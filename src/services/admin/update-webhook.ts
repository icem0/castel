import { ApiError, apiFetch } from '../../auth/api'

export type CommitInfo = {
  sha: string
  message: string
  date: string | null
}

export type WebhookStatus = {
  /** UPDATE_WEBHOOK_URL is set on the server. */
  configured: boolean
  /** Protocol + host + port of the target (never contains the token). */
  target: string | null
  /** A TCP connection to the target succeeded. */
  reachable: boolean
  /** Machine-readable diagnosis when unreachable / self-call. */
  reason: string | null
  /** The URL points at the API container itself (no host executor). */
  selfCall: boolean
}

export type UpdateCheck = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  commitsBehind: number | null
  commits: CommitInfo[]
  checkedAt: string
  error?: string
  webhook: WebhookStatus
}

export type UpdateStartResult = {
  started: boolean
  /** The server wrote the "requested" marker (new path). */
  requested?: boolean
  webhookStatus?: number | null
  message?: string
}

/** Prüft GitHub auf eine neuere Version als die installierte. */
export async function checkUpdate(): Promise<UpdateCheck> {
  return await apiFetch<UpdateCheck>('/api/update/check')
}

/**
 * Fordert ein Update an. Der Button schreibt die Anforderung direkt in die DB
 * (Marker `server.updateState`) — kein Webhook, kein Token im Browser. Der
 * Update-Dienst auf dem Host (scripts/update.sh) startet das Update im nächsten
 * Intervall. Aeltere Server ohne /api/admin/update/request fallen auf
 * /api/update/start zurueck (dort wird der ausgehende Webhook gefeuert).
 */
export async function startUpdate(): Promise<UpdateStartResult> {
  try {
    return await apiFetch<UpdateStartResult>('/api/admin/update/request', { method: 'POST' })
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return await apiFetch<UpdateStartResult>('/api/update/start', { method: 'POST' })
    }
    throw err
  }
}
