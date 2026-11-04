import { apiFetch } from '../../auth/api'

export type CommitInfo = {
  sha: string
  message: string
  date: string | null
}

export type UpdateCheck = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  commitsBehind: number | null
  commits: CommitInfo[]
  checkedAt: string
  error?: string
}

export type UpdateStartResult = {
  started: boolean
}

/** Prüft GitHub auf eine neuere Version als die installierte. */
export async function checkUpdate(): Promise<UpdateCheck> {
  return await apiFetch<UpdateCheck>('/api/update/check')
}

/** Löst den Update-Webhook aus. Keine Client-Parameter werden mitgereicht. */
export async function startUpdate(): Promise<UpdateStartResult> {
  return await apiFetch<UpdateStartResult>('/api/update/start', { method: 'POST' })
}
