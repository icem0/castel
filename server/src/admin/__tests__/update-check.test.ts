// Tests for GET /api/update/check.
//
// A failed check must never throw and must never drop the installed version:
// the admin has to see what is installed and why the comparison failed.
// The module is read-only: no route may start or request an update.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkLatestVersion, resetUpdateCache, updateCheckRoutes, type CheckDeps } from '../update-check.js'

type FetchCall = { url: string; headers: Record<string, string> }

/** Builds a fetch stub that answers the commit and compare endpoints. */
function fetchStub(opts: {
  latestSha: string
  aheadBy?: number
  commits?: Array<{ sha: string; message: string; date: string }>
  failWith?: string
  status?: number
}): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    if (opts.failWith) throw new Error(opts.failWith)
    const body = url.includes('/compare/')
      ? {
          ahead_by: opts.aheadBy ?? 0,
          commits: (opts.commits ?? []).map((c) => ({
            sha: c.sha,
            commit: { message: c.message, committer: { date: c.date } },
          })),
        }
      : {
          sha: opts.latestSha,
          commit: { message: 'HEAD-Commit\nDetails', committer: { date: '2026-01-02T03:04:05Z' } },
        }
    const status = opts.status ?? 200
    return { ok: status < 400, status, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

/**
 * Minimal app: requireAdmin is stubbed via the `x-test-role` header so the test
 * needs no database. 401 without header, 403 for non-admins.
 */
async function buildApp(deps: CheckDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    const role = req.headers['x-test-role']
    if (!role) {
      void reply.code(401).send({ code: 'UNAUTHORIZED' })
      return
    }
    if (role !== 'admin') void reply.code(403).send({ code: 'FORBIDDEN' })
  })
  await updateCheckRoutes(app, deps)
  await app.ready()
  return app
}

describe('GET /api/update/check', () => {
  let app: FastifyInstance | null = null

  beforeEach(() => {
    resetUpdateCache()
  })
  afterEach(async () => {
    await app?.close()
    app = null
  })

  it('reports an update with commits when the installed SHA is older', async () => {
    const { impl, calls } = fetchStub({
      latestSha: 'neu123',
      aheadBy: 2,
      commits: [
        { sha: 'c1', message: 'feat: eins\nBody', date: '2026-01-02T00:00:00Z' },
        { sha: 'c2', message: 'fix: zwei', date: '2026-01-03T00:00:00Z' },
      ],
    })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', branch: 'main', current: 'alt456' })

    const res = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'admin' } })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      current: 'alt456',
      latest: 'neu123',
      updateAvailable: true,
      commitsBehind: 2,
      commits: [
        { sha: 'c1', message: 'feat: eins', date: '2026-01-02T00:00:00Z' },
        { sha: 'c2', message: 'fix: zwei', date: '2026-01-03T00:00:00Z' },
      ],
    })
    expect(body.error).toBeUndefined()
    expect(typeof body.checkedAt).toBe('string')
    // The response carries no update-trigger details any more.
    expect(body.webhook).toBeUndefined()
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/icem0/castel/commits/main',
      'https://api.github.com/repos/icem0/castel/compare/alt456...neu123',
    ])
  })

  it('reports no update and skips the compare call when already current', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'gleich789' })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: 'gleich789' })

    const res = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'admin' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ updateAvailable: false, latest: 'gleich789', commits: [] })
    expect(calls).toHaveLength(1)
  })

  it('shows the HEAD commit when the installed version is unknown', async () => {
    const { impl } = fetchStub({ latestSha: 'kopf1' })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: null })

    const res = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'admin' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      current: null,
      latest: 'kopf1',
      updateAvailable: null,
      commits: [{ sha: 'kopf1', message: 'HEAD-Commit', date: '2026-01-02T03:04:05Z' }],
    })
  })

  it('answers 200 with the installed version and an error when GitHub fails', async () => {
    const { impl } = fetchStub({ latestSha: 'x', status: 403 })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: 'alt456' })

    const res = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'admin' } })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      current: 'alt456',
      latest: null,
      updateAvailable: null,
      error: 'GitHub API: HTTP 403',
    })
  })

  it('sends the GitHub token only as Authorization header', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'gleich' })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: 'gleich', token: 'ghp_test' })

    const res = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'admin' } })

    expect(res.statusCode).toBe(200)
    expect(calls[0]?.headers.Authorization).toBe('Bearer ghp_test')
    expect(res.body).not.toContain('ghp_test')
  })

  it('rejects requests without login (401) and non-admins (403) before calling GitHub', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'neu' })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: 'alt' })

    const anon = await app.inject({ method: 'GET', url: '/api/update/check' })
    const user = await app.inject({ method: 'GET', url: '/api/update/check', headers: { 'x-test-role': 'lager' } })

    expect(anon.statusCode).toBe(401)
    expect(user.statusCode).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('registers no update trigger routes', async () => {
    const { impl } = fetchStub({ latestSha: 'neu' })
    app = await buildApp({ fetchImpl: impl, repo: 'icem0/castel', current: 'alt' })
    const headers = { 'x-test-role': 'admin' }

    for (const url of ['/api/update/start', '/api/admin/update/request', '/api/admin/update/webhook']) {
      const res = await app.inject({ method: 'POST', url, headers })
      expect(res.statusCode, url).toBe(404)
    }
    const status = await app.inject({ method: 'GET', url: '/api/admin/update/status', headers })
    expect(status.statusCode).toBe(404)
  })
})

describe('checkLatestVersion', () => {
  beforeEach(() => {
    resetUpdateCache()
  })

  it('caches the GitHub answer for the same repo, branch and version', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'gleich' })
    await checkLatestVersion({ fetchImpl: impl, repo: 'icem0/castel', current: 'gleich' })
    await checkLatestVersion({ fetchImpl: impl, repo: 'icem0/castel', current: 'gleich' })
    expect(calls).toHaveLength(1)
  })

  it('reports a missing repo without calling GitHub', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'x' })
    const res = await checkLatestVersion({ fetchImpl: impl, repo: '', current: 'alt' })
    expect(res.error).toBe('GITHUB_REPO nicht konfiguriert')
    expect(res.current).toBe('alt')
    expect(calls).toHaveLength(0)
  })
})
