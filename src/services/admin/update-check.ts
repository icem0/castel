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

/**
 * Prüft GitHub auf eine neuere Version als die installierte. Read-only: das
 * Update selbst läuft auf dem Server (scripts/update.sh), nicht aus der App.
 */
export async function checkUpdate(): Promise<UpdateCheck> {
  return await apiFetch<UpdateCheck>('/api/update/check')
}
