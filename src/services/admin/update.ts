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
  /** True when the server started the updater container itself. */
  started: boolean
  /** Machine-readable reason when started is false (e.g. DOCKER_UNAVAILABLE). */
  reason: string | null
  state: UpdateState
}

export type UpdateCheck = {
  current: string | null
  latest: string | null
  updateAvailable: boolean | null
  /** True when the server can reach the Docker socket and self-update. */
  canSelfUpdate: boolean
  checkedAt: string
  error?: string
}

/** Fordert ein Update an und startet den Updater-Container auf dem Server. */
export async function requestUpdate(): Promise<UpdateRequestResult> {
  return await apiFetch<UpdateRequestResult>('/api/admin/update', { method: 'POST' })
}

/** Prueft GHCR auf eine neuere Version als die laufende. */
export async function checkUpdate(): Promise<UpdateCheck> {
  return await apiFetch<UpdateCheck>('/api/admin/update/check')
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
