// Update-Endpunkte (ersetzen den alten Docker-basierten Self-Update aus
// /api/admin/update/*). Der Server prüft GitHub auf eine neuere Version und
// löst bei Bedarf einen Deploy-Webhook aus — kein Docker-Socket nötig.
//
// Endpunkte (beide admin-only):
//   GET  /api/update/check   → installierte vs. neueste Version + Commits
//   POST /api/update/start   → POST an UPDATE_WEBHOOK_URL (X-Deploy-Token)
//                              + 5-Minuten-Doppelklick-Schutz
//
// Das Token (UPDATE_WEBHOOK_TOKEN) kommt NIE ans Frontend.

import type { FastifyInstance } from 'fastify'
import { config } from '../config/config.js'
import {
  buildRequestDocument,
  parseUpdateState,
  readUpdateState,
  writeUpdateState,
} from './update-routes.js'
import { startUpdater } from './update-runner.js'

const CHECK_CACHE_TTL_MS = 60_000
const START_COOLDOWN_MS = 5 * 60_000

type CommitInfo = {
  sha: string
  message: string
  date: string | null
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
}

export type CheckDeps = {
  fetchImpl?: typeof fetch
  repo?: string
  branch?: string
  token?: string
  current?: string | null
}

type CheckCache = {
  key: string
  data: CheckResult
  fetchedAt: number
}

let checkCache: CheckCache | null = null
let lastStartAt = 0

/** Leert den Check-Cache (Tests / manuelles Neuladen). */
export function resetUpdateCache(): void {
  checkCache = null
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

/**
 * Prüft GitHub auf eine neuere Version als die installierte (GIT_COMMIT).
 * Ergebnis wird 60 Sekunden gecacht; Fehler werden nicht gecacht.
 *
 * Wirft NIE: ein fehlgeschlagener Check liefert ein Ergebnis mit gesetztem
 * `error`-Feld. So bleibt `current` (die installierte Version) immer
 * sichtbar — der Admin sieht, was installiert ist, und zusätzlich, warum
 * der Vergleich nicht klappte.
 */
export async function checkLatestVersion(deps: CheckDeps = {}): Promise<CheckResult> {
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

  // Cache hit (nur erfolgreiche Ergebnisse, pro Repo+Branch+Version)
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
          // Compare fehlgeschlagen — Update trotzdem melden, Commits bleiben leer
        }
      }
    } else {
      // Keine installierte Version bekannt → nur den HEAD-Commit anzeigen.
      // Die erste Antwort IST der Commit — kein zweiter Request nötig.
      commits.push({ sha: latestSha, message: betreff(latest), date: datum(latest) })
    }

    const result: CheckResult = {
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

export async function updateWebhookRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/update/check ----------
  // Antwortet IMMER mit 200 und einem vollständigen Ergebnis: die installierte
  // Version bleibt sichtbar, ein fehlgeschlagener Vergleich steht im
  // `error`-Feld. Ein 5xx würde die Response-Form im Frontend brechen.
  app.get('/api/update/check', { preHandler: app.requireAdmin }, async (_req, reply) => {
    const result = await checkLatestVersion()
    return reply.send(result)
  })

  // ---------- POST /api/update/start ----------
  app.post('/api/update/start', { preHandler: app.requireAdmin }, async (_req, reply) => {
    // Doppelklick-Schutz: kein zweiter Start innerhalb von 5 Minuten
    const now = Date.now()
    if (now - lastStartAt < START_COOLDOWN_MS) {
      const reste = Math.ceil((START_COOLDOWN_MS - (now - lastStartAt)) / 1000)
      return reply.code(409).send({
        code: 'UPDATE_COOLDOWN',
        message: `Bitte ${reste}s warten, bevor ein weiteres Update gestartet wird.`,
      })
    }

    // Nochmal serverseitig prüfen, ob ein Update verfügbar ist
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
        message: 'UPDATE_WEBHOOK_URL nicht konfiguriert.',
      })
    }

    lastStartAt = now

    // Webhook auslösen (nicht auf Antwort warten — die App startet selbst neu)
    void (async () => {
      try {
        await fetch(config.UPDATE_WEBHOOK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Deploy-Token': config.UPDATE_WEBHOOK_TOKEN,
          },
          body: JSON.stringify({
            triggeredAt: new Date().toISOString(),
            current: check.current,
            latest: check.latest,
          }),
        })
      } catch {
        // Webhook-Fehler wird nicht zurückgemeldet; der Start wurde akzeptiert
      }
    })()

    return reply.send({ started: true })
  })
}

// ---------- POST /api/admin/update/webhook (inbound) ----------
// Externes System (CI/CD, Orchestrator, Portainer, ...)
// kann ein Update auf dem Server ausloesen.
// Geschuetzt nur durch X-Deploy-Token (UPDATE_WEBHOOK_TOKEN), kein JWT noetig.
// Fuehrt denselben Ablauf aus wie POST /api/admin/update:
// Marker server.updateState in die DB + kurzlebigen Updater-Container starten.
export async function updateInboundWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/update/webhook', async (req, reply) => {
    if (!config.UPDATE_WEBHOOK_TOKEN) {
      return reply.code(500).send({
        code: 'UPDATE_NO_WEBHOOK_TOKEN',
        message: 'UPDATE_WEBHOOK_TOKEN nicht konfiguriert.',
      })
    }

    const token = req.headers['x-deploy-token']
    if (typeof token !== 'string' || token !== config.UPDATE_WEBHOOK_TOKEN) {
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

    const updater = await startUpdater()
    return reply.send({
      requested: true,
      started: updater.started,
      reason: updater.reason ?? null,
      state: parseUpdateState(requestedDocument),
    })
  })
}
