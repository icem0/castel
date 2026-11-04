// Tests fuer den GitHub-basierten Update-Check.
//
// Wichtig: Ein fehlgeschlagener Check darf NIE werfen und darf die
// installierte Version nicht verschlucken — der Admin muss im Panel sehen,
// was installiert ist und warum der Vergleich nicht klappte. Genau das
// war der Bug, der das Frontend wie "nichts passiert" wirken liess.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLatestVersion, resetUpdateCache } from '../update-webhook-routes.js'

type FetchCall = { url: string }

/** Baut einen fetch-Stub, der Commits und Compare-Antworten liefert. */
function fetchStub(opts: {
  latestSha: string
  aheadBy?: number
  commits?: Array<{ sha: string; message: string; date: string }>
  failWith?: string
}): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push({ url })
    if (opts.failWith) {
      throw new Error(opts.failWith)
    }
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
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('checkLatestVersion', () => {
  beforeEach(() => {
    resetUpdateCache()
  })

  it('meldet ein Update, wenn die installierte SHA aelter ist', async () => {
    const { impl, calls } = fetchStub({
      latestSha: 'neue123',
      aheadBy: 3,
      commits: [
        { sha: 'c1', message: 'feat: eins', date: '2026-01-02T00:00:00Z' },
        { sha: 'c2', message: 'fix: zwei', date: '2026-01-03T00:00:00Z' },
      ],
    })

    const res = await checkLatestVersion({
      fetchImpl: impl,
      repo: 'icem0/castel',
      branch: 'main',
      current: 'alte456',
    })

    expect(res.error).toBeUndefined()
    expect(res.current).toBe('alte456')
    expect(res.latest).toBe('neue123')
    expect(res.updateAvailable).toBe(true)
    expect(res.commitsBehind).toBe(3)
    expect(res.commits).toHaveLength(2)
    expect(res.commits[0]?.message).toBe('feat: eins')
    expect(res.commits[1]?.sha).toBe('c2')
    // Commit + Compare
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('https://api.github.com/repos/icem0/castel/commits/main')
    expect(calls[1]?.url).toBe(
      'https://api.github.com/repos/icem0/castel/compare/alte456...neue123',
    )
  })

  it('meldet kein Update, wenn die installierte SHA schon die neueste ist', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'gleich789' })

    const res = await checkLatestVersion({
      fetchImpl: impl,
      repo: 'icem0/castel',
      current: 'gleich789',
    })

    expect(res.updateAvailable).toBe(false)
    expect(res.latest).toBe('gleich789')
    expect(res.commits).toHaveLength(0)
    // Kein Compare, wenn nichts zu tun ist
    expect(calls).toHaveLength(1)
  })

  it('liefert bei nicht erreichbarem GitHub die installierte Version UND den Fehler', async () => {
    const { impl } = fetchStub({ latestSha: 'x', failWith: 'GitHub API: HTTP 403' })

    const res = await checkLatestVersion({
      fetchImpl: impl,
      repo: 'icem0/castel',
      current: 'alte456',
    })

    // Kein Wurf — das Frontend muss den Fehler anzeigen koennen.
    expect(res.error).toBe('GitHub API: HTTP 403')
    // Die installierte Version bleibt sichtbar.
    expect(res.current).toBe('alte456')
    expect(res.latest).toBeNull()
    expect(res.updateAvailable).toBeNull()
  })

  it('meldet fehlende Repo-Konfiguration', async () => {
    const res = await checkLatestVersion({
      fetchImpl: fetchStub({ latestSha: 'x' }).impl,
      repo: '',
      current: 'alte456',
    })

    expect(res.error).toBe('GITHUB_REPO nicht konfiguriert')
    expect(res.current).toBe('alte456')
  })

  it('cached ein erfolgreiches Ergebnis fuer 60 Sekunden', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'neu1' })

    const a = await checkLatestVersion({ fetchImpl: impl, repo: 'r', current: 'alt1' })
    const requestsNachErstem = calls.length
    const b = await checkLatestVersion({ fetchImpl: impl, repo: 'r', current: 'alt1' })

    expect(a.latest).toBe('neu1')
    expect(b.latest).toBe('neu1')
    // Der zweite Check darf GitHub nicht erneut fragen.
    expect(requestsNachErstem).toBeGreaterThan(0)
    expect(calls).toHaveLength(requestsNachErstem)
  })

  it('cached Fehler NICHT — ein Retry ist sofort moeglich', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('GitHub API: HTTP 500')
    }) as unknown as typeof fetch

    const a = await checkLatestVersion({ fetchImpl, repo: 'r', current: 'alt1' })
    const b = await checkLatestVersion({ fetchImpl, repo: 'r', current: 'alt1' })

    expect(a.error).toBe('GitHub API: HTTP 500')
    expect(b.error).toBe('GitHub API: HTTP 500')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('zeigt den HEAD-Commit, wenn keine installierte Version bekannt ist', async () => {
    const { impl, calls } = fetchStub({ latestSha: 'head1' })

    const res = await checkLatestVersion({
      fetchImpl: impl,
      repo: 'r',
      current: null,
    })

    expect(res.current).toBeNull()
    expect(res.latest).toBe('head1')
    expect(res.commits).toHaveLength(1)
    expect(res.commits[0]?.message).toBe('HEAD-Commit')
    // Kein zweiter Request fuer denselben Commit.
    expect(calls).toHaveLength(1)
  })
})
