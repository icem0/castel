import { apiFetch } from '../../auth/api'

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
  webhookStatus?: number | null
  message?: string
}

/** Prüft GitHub auf eine neuere Version als die installierte. */
export async function checkUpdate(): Promise<UpdateCheck> {
  return await apiFetch<UpdateCheck>('/api/update/check')
}

/** Löst den Update-Webhook aus und liefert das echte Ergebnis zurück. */
export async function startUpdate(): Promise<UpdateStartResult> {
  return await apiFetch<UpdateStartResult>('/api/update/start', { method: 'POST' })
}
