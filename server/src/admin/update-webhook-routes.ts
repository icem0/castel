// Update endpoints (replace the former Docker-based self-update from
// /api/admin/update/*). The server checks GitHub for a newer version and, when
// requested, calls an external update webhook with a shared token.
//
// Endpoints:
//   GET  /api/update/check   → installed vs. latest version + commits + webhook status
//   POST /api/update/start   → POST to UPDATE_WEBHOOK_URL and report the real result
//   POST /api/admin/update/webhook (inbound, token-only)
//                            → marks an update request in the DB; the actual
//                              update is executed by an external host-side
//                              runner (scripts/update.sh). No sidecar container.
//
// The token (UPDATE_WEBHOOK_TOKEN) is NEVER sent to the frontend.
//
// IMPORTANT (container networking): `127.0.0.1` inside the API container is the
// API itself, not the host. An external update daemon on the host must therefore
// be addressed via `http://host.docker.internal:3000/...` (mapped by
// `extra_hosts` in docker-compose.yml). A self-call URL is rejected with
// WEBHOOK_SELF_CALL because, without the removed updater sidecar, the API cannot
// execute a host update on its own.

import type { FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { connect } from 'node:net'
import { config } from '../config/config.js'
import {
  buildRequestDocument,
  parseUpdateState,
  readUpdateState,
  writeUpdateState,
} from './update-routes.js'

const CHECK_CACHE_TTL_MS = 60_000
const START_COOLDOWN_MS = 5 * 60_000
const WEBHOOK_TIMEOUT_MS = 8_000
const WEBHOOK_PROBE_TIMEOUT_MS = 1_500

type CommitInfo = {
  sha: string
  message: string
  date: string | null
}

export type WebhookStatus = {
  /** UPDATE_WEBHOOK_URL is set. */
  configured: boolean
  /** Protocol + host + port of the target (never contains the token). */
  target: string | null
  /** A TCP connection to the target succeeded. */
  reachable: boolean
  /** Machine-readable diagnosis when reachable is false (or selfCall). */
  reason: string | null
  /** The URL points at the API container itself (no host executor). */
  selfCall: boolean
}

export type CheckResult = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  commitsBehind: number | null
  commits: CommitInfo[]
  checkedAt: string
  /** Fehlermeldung, wenn der Check fehlgeschlagen ist (GitHub nicht erreichbar, Rate-Limit, ...). */
  error?: string
  webhook: WebhookStatus
}

export type CheckDeps = {
  fetchImpl?: typeof fetch
  repo?: string
  branch?: string
  token?: string
  current?: string | null
  webhookUrl?: string
  webhookProbe?: (url: string) => Promise<WebhookStatus>
}

type CheckCache = {
  key: string
  data: Omit<CheckResult, 'webhook'>
  fetchedAt: number
}

let checkCache: CheckCache | null = null
let lastStartAt = 0

/** Leert den Check-Cache (Tests / manuelles Neuladen). */
export function resetUpdateCache(): void {
  checkCache = null
}

/** Resets the in-process start cooldown (tests). */
export function resetUpdateCooldown(): void {
  lastStartAt = 0
}

function githubHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return headers
}

async function fetchJson(url: string, token: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: githubHeaders(token) })
  if (!res.ok) {
    throw new Error(`GitHub API: HTTP ${res.status}`)
  }
  return res.json()
}

function betreff(commit: unknown): string {
  const c = commit as { commit?: { message?: string } } | null
  const msg = c?.commit?.message ?? ''
  return msg.split('\n')[0] ?? ''
}

function datum(commit: unknown): string | null {
  const c = commit as { commit?: { committer?: { date?: string } } } | null
  return c?.commit?.committer?.date ?? null
}

// ---------------------------------------------------------------------------
// Webhook reachability + dispatch
// ---------------------------------------------------------------------------

/** Protocol + host + port of a webhook URL, without credentials or path. */
export function webhookTarget(url: string): string | null {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/**
 * True when the URL points at this very API container (loopback + own port).
 * Such a self-call cannot start a host update without the removed sidecar.
 */
export function isSelfCallUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback) return false
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    const ownPort = Number(process.env.PORT ?? 3000)
    return port === ownPort
  } catch {
    return false
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })
    const finish = (reason: string | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reason)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(null))
    socket.once('timeout', () => finish('TIMEOUT'))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code ?? 'UNREACHABLE'))
  })
}

/**
 * Side-effect-free reachability check: opens a TCP connection to the webhook
 * target but never sends the request. Used by the version panel to show an
 * offline update daemon before the admin clicks the button.
 */
export async function probeWebhook(
  url: string,
  timeoutMs = WEBHOOK_PROBE_TIMEOUT_MS,
): Promise<WebhookStatus> {
  if (!url) {
    return { configured: false, target: null, reachable: false, reason: 'NOT_CONFIGURED', selfCall: false }
  }
  const target = webhookTarget(url)
  if (!target) {
    return { configured: true, target: null, reachable: false, reason: 'INVALID_URL', selfCall: false }
  }
  const selfCall = isSelfCallUrl(url)
  if (selfCall) {
    return { configured: true, target, reachable: false, reason: 'SELF_CALL', selfCall: true }
  }
  try {
    const parsed = new URL(url)
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    const reason = await tcpProbe(parsed.hostname, port, timeoutMs)
    return { configured: true, target, reachable: reason === null, reason, selfCall: false }
  } catch {
    return { configured: true, target, reachable: false, reason: 'INVALID_URL', selfCall: false }
  }
}

export type WebhookFireResult = {
  ok: boolean
  status: number | null
  /** Parsed JSON response body, if the receiver returned one. */
  body: unknown
  /** Machine-readable reason when ok is false. */
  reason: string | null
  message: string | null
}

function bodyField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object') return undefined
  return (body as Record<string, unknown>)[key]
}

/**
 * POSTs to the update webhook and waits for the real result. A receiver that
 * answers non-2xx, is unreachable, times out, or returns `started:false` /
 * `requested:false` is reported as a failure — never swallowed.
 */
export async function fireUpdateWebhook(
  url: string,
  token: string,
  payload: Record<string, unknown>,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebhookFireResult> {
  if (!url) {
    return { ok: false, status: null, body: null, reason: 'NOT_CONFIGURED', message: 'UPDATE_WEBHOOK_URL ist nicht konfiguriert.' }
  }
  if (isSelfCallUrl(url)) {
    return {
      ok: false,
      status: null,
      body: null,
      reason: 'SELF_CALL',
      message:
        'UPDATE_WEBHOOK_URL zeigt auf die API selbst (127.0.0.1/localhost). Nutze die Host-Adresse des Update-Dienstes, z.B. http://host.docker.internal:3000/…',
    }
  }

  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Deploy-Token': token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })

    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // Receiver may answer with an empty/non-JSON body.
    }

    if (!res.ok) {
      const message = bodyField(body, 'message')
      return {
        ok: false,
        status: res.status,
        body,
        reason: `HTTP_${res.status}`,
        message: typeof message === 'string' ? message : `Der Update-Dienst antwortete mit HTTP ${res.status}.`,
      }
    }

    if (bodyField(body, 'started') === false || bodyField(body, 'requested') === false) {
      const reason = bodyField(body, 'reason')
      const message = bodyField(body, 'message')
      return {
        ok: false,
        status: res.status,
        body,
        reason: typeof reason === 'string' ? reason : 'REJECTED',
        message: typeof message === 'string' ? message : 'Der Update-Dienst hat die Anforderung abgelehnt.',
      }
    }

    return { ok: true, status: res.status, body, reason: null, message: null }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError'
    return {
      ok: false,
      status: null,
      body: null,
      reason: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      message: timedOut
        ? `Der Update-Dienst antwortete nicht innerhalb von ${Math.round(timeoutMs / 1000)} s.`
        : `Der Update-Dienst ist nicht erreichbar: ${err.message}`,
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub version check
// ---------------------------------------------------------------------------

async function resolveGithub(deps: CheckDeps): Promise<Omit<CheckResult, 'webhook'>> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const repo = deps.repo ?? config.GITHUB_REPO
  const branch = deps.branch ?? config.GITHUB_BRANCH
  const token = deps.token ?? config.GITHUB_TOKEN
  const current =
    deps.current !== undefined
      ? deps.current
      : config.GIT_COMMIT === 'unknown'
        ? null
        : config.GIT_COMMIT
  const checkedAt = new Date().toISOString()

  if (!repo) {
    return {
      current,
      latest: null,
      updateAvailable: null,
      commitsBehind: null,
      commits: [],
      checkedAt,
      error: 'GITHUB_REPO nicht konfiguriert',
    }
  }

  const cacheKey = `${repo}@${branch}#${current ?? 'unknown'}`
  const now = Date.now()
  if (checkCache && checkCache.key === cacheKey && now - checkCache.fetchedAt < CHECK_CACHE_TTL_MS) {
    return checkCache.data
  }

  try {
    const latest = (await fetchJson(
      `https://api.github.com/repos/${repo}/commits/${branch}`,
      token,
      fetchImpl,
    )) as { sha?: string }
    const latestSha = latest.sha
    if (!latestSha) {
      throw new Error('GitHub API: keine Commit-SHA in der Antwort')
    }

    let updateAvailable: boolean | null = null
    let commitsBehind: number | null = null
    const commits: CommitInfo[] = []

    if (current) {
      updateAvailable = latestSha !== current
      if (updateAvailable) {
        try {
          const compare = (await fetchJson(
            `https://api.github.com/repos/${repo}/compare/${current}...${latestSha}`,
            token,
            fetchImpl,
          )) as { ahead_by?: number; commits?: unknown[] }
          commitsBehind = typeof compare.ahead_by === 'number' ? compare.ahead_by : null
          for (const c of compare.commits ?? []) {
            commits.push({ sha: (c as { sha: string }).sha, message: betreff(c), date: datum(c) })
          }
        } catch {
          // Compare failed — still report the update, commits stay empty.
        }
      }
    } else {
      // No installed version known → show only the HEAD commit.
      commits.push({ sha: latestSha, message: betreff(latest), date: datum(latest) })
    }

    const result: Omit<CheckResult, 'webhook'> = {
      current,
      latest: latestSha,
      updateAvailable,
      commitsBehind,
      commits,
      checkedAt,
    }
    checkCache = { key: cacheKey, data: result, fetchedAt: now }
    return result
  } catch (error) {
    return {
      current,
      latest: null,
      updateAvailable: null,
      commitsBehind: null,
      commits: [],
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Checks GitHub for a newer version than the installed one and probes the
 * update webhook. Never throws: a failed check yields an `error` field, and the
 * webhook status is always present so the UI can show an offline daemon.
 */
export async function checkLatestVersion(deps: CheckDeps = {}): Promise<CheckResult> {
  const webhookUrl = deps.webhookUrl ?? config.UPDATE_WEBHOOK_URL
  const webhook = await (deps.webhookProbe ?? probeWebhook)(webhookUrl)
  const github = await resolveGithub(deps)
  return { ...github, webhook }
}

export async function updateWebhookRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/update/check ----------
  // Always 200 with a complete result: the installed version stays visible and
  // a failed comparison is reported in the `error` field.
  app.get('/api/update/check', { preHandler: app.requireAdmin }, async (_req, reply) => {
    const result = await checkLatestVersion()
    return reply.send(result)
  })

  // ---------- POST /api/update/start ----------
  app.post('/api/update/start', { preHandler: app.requireAdmin }, async (_req, reply) => {
    // Double-click guard: no second start within 5 minutes. Only a *successful*
    // dispatch starts the cooldown, so a failed attempt can be retried at once.
    const now = Date.now()
    if (now - lastStartAt < START_COOLDOWN_MS) {
      const reste = Math.ceil((START_COOLDOWN_MS - (now - lastStartAt)) / 1000)
      return reply.code(409).send({
        code: 'UPDATE_COOLDOWN',
        message: `Bitte ${reste}s warten, bevor ein weiteres Update gestartet wird.`,
      })
    }

    // Re-check server-side whether an update is available.
    const check = await checkLatestVersion()
    if (check.error) {
      return reply.code(502).send({ code: 'UPDATE_CHECK_FAILED', message: check.error })
    }
    if (check.updateAvailable !== true) {
      return reply.code(409).send({
        code: 'UPDATE_NOT_AVAILABLE',
        message: 'Kein Update verfügbar.',
      })
    }
    if (!config.UPDATE_WEBHOOK_URL) {
      return reply.code(500).send({
        code: 'UPDATE_NO_WEBHOOK',
        message:
          'UPDATE_WEBHOOK_URL ist nicht konfiguriert. Setze die Adresse des Update-Dienstes in der .env.',
      })
    }

    // Wait for the real webhook result instead of fire-and-forget. The admin
    // gets a definitive success/failure answer.
    const fired = await fireUpdateWebhook(config.UPDATE_WEBHOOK_URL, config.UPDATE_WEBHOOK_TOKEN, {
      triggeredAt: new Date().toISOString(),
      current: check.current,
      latest: check.latest,
    })

    if (!fired.ok) {
      return reply.code(502).send({
        code: 'UPDATE_WEBHOOK_FAILED',
        reason: fired.reason,
        status: fired.status,
        message: fired.message ?? 'Der Update-Dienst konnte nicht erreicht werden.',
      })
    }

    lastStartAt = now
    return reply.send({
      started: true,
      webhookStatus: fired.status,
      message: 'Update beim Update-Dienst ausgelöst.',
    })
  })
}

// ---------- POST /api/admin/update/webhook (inbound) ----------
// External systems (CI/CD, orchestrator, ...) can request an update on this
// server. Protected only by X-Deploy-Token (no JWT). This endpoint writes the
// `server.updateState` marker; the actual execution is done by an external
// host-side runner (scripts/update.sh --if-requested). No updater container is
// started from inside the API.
export async function updateInboundWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/update/webhook', async (req, reply) => {
    if (!config.UPDATE_WEBHOOK_TOKEN) {
      return reply.code(500).send({
        code: 'UPDATE_NO_WEBHOOK_TOKEN',
        message: 'UPDATE_WEBHOOK_TOKEN nicht konfiguriert.',
      })
    }

    const token = req.headers['x-deploy-token']
    // Constant-time comparison: a plain `!==` short-circuits at the first
    // differing byte and leaks information about the secret over the network
    // (SEC-035).
    const provided = typeof token === 'string' ? token : ''
    const expected = config.UPDATE_WEBHOOK_TOKEN
    const tokenOk =
      provided.length === expected.length &&
      provided.length > 0 &&
      timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
    if (!tokenOk) {
      return reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Ungültiges oder fehlendes X-Deploy-Token.',
      })
    }

    const current = await readUpdateState()
    if (current.phase === 'running') {
      return reply.code(409).send({
        code: 'UPDATE_RUNNING',
        message: 'Ein Update läuft bereits.',
        state: current,
      })
    }

    const now = new Date().toISOString()
    const requestedDocument = buildRequestDocument(now)
    await writeUpdateState(requestedDocument)

    return reply.send({
      requested: true,
      executed: false,
      reason: 'EXTERNAL_RUNNER_REQUIRED',
      message:
        'Update angefordert. Die Ausführung übernimmt der externe Update-Dienst (scripts/update.sh).',
      state: parseUpdateState(requestedDocument),
    })
  })
}
