// Read-only update check.
//
// Endpoint:
//   GET /api/update/check (admin JWT) → installed vs. latest commit on GitHub
//
// The API never updates itself and accepts no update trigger. Updates run on
// the host (`git pull && docker compose pull && docker compose up -d`, or
// scripts/update.sh). This module only tells an admin whether a newer commit
// exists.

import type { FastifyInstance } from 'fastify'
import { config } from '../config/config.js'

const CHECK_CACHE_TTL_MS = 60_000

export type CommitInfo = {
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
  /** Error message when the check failed (GitHub unreachable, rate limit, ...). */
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

/** Clears the check cache (tests / manual reload). */
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
 * Checks GitHub for a newer commit than the installed one. Never throws: a
 * failed check yields an `error` field so the installed version stays visible.
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
          // Compare failed - still report the update, commits stay empty.
        }
      }
    } else {
      // No installed version known - show only the HEAD commit.
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

export async function updateCheckRoutes(
  app: FastifyInstance,
  deps: CheckDeps = {},
): Promise<void> {
  // ---------- GET /api/update/check ----------
  // Admin-only. Always 200 with a complete result: the installed version stays
  // visible and a failed comparison is reported in the `error` field.
  app.get('/api/update/check', { preHandler: app.requireAdmin }, async (_req, reply) => {
    const result = await checkLatestVersion(deps)
    return reply.send(result)
  })
}
