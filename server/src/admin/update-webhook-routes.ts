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

const CHECK_CACHE_TTL_MS = 60_000
const START_COOLDOWN_MS = 5 * 60_000

type CommitInfo = {
  sha: string
  message: string
  date: string | null
}

type CheckResult = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  commitsBehind: number | null
  commits: CommitInfo[]
  checkedAt: string
  error?: string
}

type CheckCache = {
  data: CheckResult
  fetchedAt: number
}

let checkCache: CheckCache | null = null
let lastStartAt = 0

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (config.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`
  }
  return headers
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: githubHeaders() })
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
 * Ergebnis wird 60 Sekunden gecached; Fehler werden nicht gecached.
 */
async function checkLatestVersion(): Promise<CheckResult> {
  const now = Date.now()
  const current = config.GIT_COMMIT === 'unknown' ? null : config.GIT_COMMIT
  const checkedAt = new Date().toISOString()

  if (!config.GITHUB_REPO) {
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

  // Cache hit (nur erfolgreiche Ergebnisse)
  if (checkCache && now - checkCache.fetchedAt < CHECK_CACHE_TTL_MS) {
    return checkCache.data
  }

  try {
    const latest: any = await fetchJson(
      `https://api.github.com/repos/${config.GITHUB_REPO}/commits/${config.GITHUB_BRANCH}`,
    )
    const latestSha: string = latest.sha
    const latestDate: string | null = datum(latest)

    let updateAvailable: boolean | null = null
    let commitsBehind: number | null = null
    const commits: CommitInfo[] = []

    if (current) {
      updateAvailable = latestSha !== current
      if (updateAvailable) {
        try {
          const compare: any = await fetchJson(
            `https://api.github.com/repos/${config.GITHUB_REPO}/compare/${current}...${latestSha}`,
          )
          commitsBehind =
            typeof compare.ahead_by === 'number' ? compare.ahead_by : null
          for (const c of compare.commits ?? []) {
            commits.push({ sha: c.sha, message: betreff(c), date: datum(c) })
          }
        } catch {
          // Compare fehlgeschlagen — Update trotzdem melden, Commits bleiben leer
        }
      }
    } else {
      // Keine installierte Version bekannt → nur Latest anzeigen
      commits.push({ sha: latestSha, message: betreff(latest), date: latestDate })
    }

    const result: CheckResult = {
      current,
      latest: latestSha,
      updateAvailable,
      commitsBehind,
      commits,
      checkedAt,
    }
    checkCache = { data: result, fetchedAt: now }
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
  app.get('/api/update/check', { preHandler: app.requireAdmin }, async (_req, reply) => {
    const result = await checkLatestVersion()
    if (result.error) {
      return reply.code(502).send({ code: 'UPDATE_CHECK_FAILED', message: result.error })
    }
    return reply.send(result)
  })

  // ---------- POST /api/update/start ----------
  app.post('/api/update/start', { preHandler: app.requireAdmin }, async (_req, reply) => {
    // Doppelklick-Schutz: kein zweiter Start innerhalb von 5 Minuten
    const now = Date.now()
    if (now - lastStartAt < START_COOLDOWN_MS) {
      const restante = Math.ceil((START_COOLDOWN_MS - (now - lastStartAt)) / 1000)
      return reply.code(409).send({
        code: 'UPDATE_COOLDOWN',
        message: `Bitte ${restante}s warten, bevor ein weiteres Update gestartet wird.`,
      })
    }

    // Nochmal serverseitig prüfen, ob ein Update verfügbar ist
    const check = await checkLatestVersion()
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
