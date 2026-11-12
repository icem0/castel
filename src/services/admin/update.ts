import { apiFetch } from '../../auth/api'

/**
 * Update-Status. Gespiegelt den Feldern, die scripts/update.sh in die DB
 * schreibt (einstellungen, key "server.updateState"). Read-only Diagnose:
 * die Ausführung übernimmt der externe Update-Dienst.
 */
export type UpdatePhase = 'requested' | 'running' | 'done' | 'failed'

export type UpdateState = {
  phase: UpdatePhase
  ok: boolean | null
  exitCode: number | null
  requestedAt: string | null
  startedAt: string | null
  finishedAt: string | null
  step: string | null
  message: string | null
  log: string | null
  gitBefore: string | null
  gitAfter: string | null
  versionBefore: string | null
  versionAfter: string | null
  imageTag: string | null
  host: string | null
}

/** Liest den aktuellen Update-Status (von scripts/update.sh geschrieben). */
export async function fetchUpdateState(): Promise<UpdateState> {
  const res = await apiFetch<{ state: UpdateState }>('/api/admin/update/status')
  return res.state
}
