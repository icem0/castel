// Wartungsmodus fuer den Restore.
//
// Ein Restore ersetzt die komplette Datenbank (pg_restore --clean) und die
// Foto-/DATANORM-Ablagen. While that runs, the database is in a state that
// no client can interpret: partly old, partly new. A sync push in that
// window would write pre-restore state back into the freshly restored
// tables — and a snapshot would hand out a mixture of both worlds.
//
// Therefore the sync endpoints refuse to work while a restore is running.
// The clients answer 503 with the code RESTORE_IN_PROGRESS and retry later
// (the PWA sync worker backs off and retries on its next tick).
//
// The flag lives in the process memory on purpose: a restore is a
// short-lived, single-process operation. A stale flag after a crash is
// impossible — the process died with the flag, and on boot nothing is
// blocked. The persistent counterpart is the restore epoch
// (`server.restoreEpoch`), which makes the clients rebuild afterwards.

let _sperre: { grund: string; seit: string } | null = null

/**
 * Blocks the sync endpoints. `grund` is a short human-readable reason that
 * ends up in the server log and in the 503 response.
 */
export function restoreSperreSetzen(grund: string): void {
  _sperre = { grund, seit: new Date().toISOString() }
}

/** Releases the block again. */
export function restoreSperreAufheben(): void {
  _sperre = null
}

/** Is a restore currently running? */
export function restoreGesperrt(): boolean {
  return _sperre !== null
}

/** Details about the active block (null when nothing is blocked). */
export function restoreSperreInfo(): { grund: string; seit: string } | null {
  return _sperre
}

/**
 * Runs `fn` while the sync endpoints are blocked. The block is always
 * released — also when `fn` throws. Without that a failed restore would
 * leave the whole sync dead until the next API restart.
 */
export async function mitRestoreSperre<T>(grund: string, fn: () => Promise<T>): Promise<T> {
  restoreSperreSetzen(grund)
  try {
    return await fn()
  } finally {
    restoreSperreAufheben()
  }
}
