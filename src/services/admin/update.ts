import { apiFetch } from '../../auth/api'

/**
 * Update-Status. Gespiegelt den Feldern, die scripts/update.sh in die DB
 * schreibt (einstellungen, key "server.updateState").
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

export type UpdateRequestResult = {
  requested: boolean
  alreadyRequested: boolean
  state: UpdateState
}

/**
 * Fordert ein Update an. Die Ausfuehrung uebernimmt der Host-Runner
 * (scripts/update.sh) innerhalb von wenigen Sekunden - der API-Container
 * startet sich nicht selbst neu.
 */
export async function requestUpdate(): Promise<UpdateRequestResult> {
  return await apiFetch<UpdateRequestResult>('/api/admin/update', { method: 'POST' })
}

/** Liest den aktuellen Update-Status. */
export async function fetchUpdateState(): Promise<UpdateState> {
  const res = await apiFetch<{ state: UpdateState }>('/api/admin/update/status')
  return res.state
}

/**
 * Ein Update laeuft, solange die Phase "requested" oder "running" ist.
 */
export function laeuftNoch(state: UpdateState): boolean {
  return state.phase === 'requested' || state.phase === 'running'
}
