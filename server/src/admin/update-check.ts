// Version check against GHCR (no GitHub tags needed - the CI pushes a
// `:v<MAJOR.MINOR.PATCH>` tag for every build). The running version comes from
// the package.json baked into the image.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeDocker, type DockerProbe } from './update-runner.js'

export type Semver = [number, number, number]

/** Parses `v1.2.3` or `1.2.3`; returns null for every other tag. */
export function parseSemver(tag: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Returns <0, 0 or >0 like a comparator. */
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = a[i]! - b[i]!
    if (diff !== 0) return diff
  }
  return 0
}

function packageJsonCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // dist/admin -> /app/package.json (runtime) and src/admin -> server/package.json (tests)
    resolve(here, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
}

/** Reads the version of the running server from its package.json. */
export function readRunningVersion(): string | null {
  for (const path of packageJsonCandidates()) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

export type UpdateCheck = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  /** True when the API can reach the Docker socket and start the updater. */
  canSelfUpdate: boolean
  /** Machine-readable diagnosis when canSelfUpdate is false. */
  selfUpdateReason: string | null
  checkedAt: string
  error?: string
}

export type CheckDeps = {
  fetchImpl?: typeof fetch
  current?: string | null
  owner?: string
  image?: string
  canSelfUpdate?: boolean
  dockerProbe?: () => Promise<DockerProbe>
}

type TagsResponse = { tags?: string[] }

/** Reads the `rel="next"` target out of a registry Link header. */
function parseNextLink(link: string | null): string | null {
  if (!link) return null
  const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)
  const raw = match?.[1]
  if (!raw) return null
  // Only follow pagination links that stay on the registry host — otherwise
  // the token in the Authorization header would be forwarded to a foreign
  // host that injected the Link header (SEC-036).
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'ghcr.io') return null
    return url.toString()
  } catch {
    return null
  }
}

const TAGS_PER_PAGE = 1000
const MAX_PAGES = 20

/**
 * Lists all tags of a package. GHCR paginates the tags endpoint (default
 * page size 100), and the `vX.Y.Z` tags are usually far behind hundreds of
 * SHA tags - without pagination the version check would never see them.
 */
async function fetchAllTags(
  fetchImpl: typeof fetch,
  token: string,
  owner: string,
  image: string,
): Promise<string[]> {
  const first = new URL(`https://ghcr.io/v2/${owner}/${image}/tags/list`)
  first.searchParams.set('n', String(TAGS_PER_PAGE))

  const tags: string[] = []
  let next: string | null = first.toString()
  for (let page = 0; next && page < MAX_PAGES; page += 1) {
    const res: Response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`tags request failed (${res.status})`)
    const body = (await res.json()) as TagsResponse
    tags.push(...(body.tags ?? []))
    next = parseNextLink(res.headers.get('link'))
  }
  return tags
}

async function fetchLatestFromGhcr(
  fetchImpl: typeof fetch,
  owner: string,
  image: string,
): Promise<{ latest: string; semver: Semver } | null> {
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${image}:pull`
  const tokenRes = await fetchImpl(tokenUrl)
  if (!tokenRes.ok) throw new Error(`token request failed (${tokenRes.status})`)
  const tokenBody = (await tokenRes.json()) as { token?: string }
  if (!tokenBody.token) throw new Error('no registry token')

  const tags = await fetchAllTags(fetchImpl, tokenBody.token, owner, image)

  let best: { latest: string; semver: Semver } | null = null
  for (const tag of tags) {
    const semver = parseSemver(tag)
    if (!semver) continue
    if (!best || compareSemver(semver, best.semver) > 0) {
      best = { latest: tag.startsWith('v') ? tag : `v${tag}`, semver }
    }
  }
  return best
}

/**
 * Checks GHCR for the newest version tag and compares it with the running
 * version. Never throws: on a registry/network error the result carries an
 * error string and unknown fields.
 */
export async function checkLatestVersion(deps: CheckDeps = {}): Promise<UpdateCheck> {
  const current = deps.current !== undefined ? deps.current : readRunningVersion()
  const fetchImpl = deps.fetchImpl ?? fetch
  const owner = deps.owner ?? process.env.CASTEL_GHCR_OWNER ?? 'icem0'
  const image = deps.image ?? process.env.CASTEL_GHCR_IMAGE ?? 'castel-api'
  const checkedAt = new Date().toISOString()
  let canSelfUpdate: boolean
  let selfUpdateReason: string | null = null
  if (deps.canSelfUpdate !== undefined) {
    canSelfUpdate = deps.canSelfUpdate
  } else {
    const probe = await (deps.dockerProbe ?? probeDocker)()
    canSelfUpdate = probe.available
    selfUpdateReason = probe.reason
  }

  try {
    const best = await fetchLatestFromGhcr(fetchImpl, owner, image)
    if (!best) {
      return {
        current,
        latest: null,
        updateAvailable: null,
        canSelfUpdate,
        selfUpdateReason,
        checkedAt,
        error: 'keine Versions-Tags in der Registry gefunden',
      }
    }
    const currentSemver = current ? parseSemver(current) : null
    const updateAvailable = currentSemver
      ? compareSemver(best.semver, currentSemver) > 0
      : null
    return {
      current,
      latest: best.latest,
      updateAvailable,
      canSelfUpdate,
      selfUpdateReason,
      checkedAt,
    }
  } catch (error) {
    return {
      current,
      latest: null,
      updateAvailable: null,
      canSelfUpdate,
      selfUpdateReason,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
