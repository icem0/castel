// Waits until freshly queued bookings are confirmed by the server.
//
// Confirmation means the server accepted the outbox item in the push
// response, which the sync worker records as `outbox.syncedAt`. The caller
// can navigate away immediately; this helper keeps polling in the background.

import { getDb } from '../../db/database'
import type { OutboxEintrag } from '../../db/types'
import { getSyncStatus, payloadIdFor, triggerSyncNow } from './worker'

export type BuchungBestaetigung =
  | { status: 'bestaetigt' }
  | { status: 'ausstehend'; grund: 'offline' | 'timeout'; fehler: string | null }
  | { status: 'abgelehnt'; grund: string }

export const BUCHUNG_BESTAETIGUNG_TIMEOUT_MS = 8_000
const POLL_MS = 250
const TRIGGER_THROTTLE_MS = 750

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function outboxBuchungIds(eintrag: OutboxEintrag): string | null {
  if (eintrag.entity !== 'buchung') return null
  try {
    return payloadIdFor('buchung', JSON.parse(eintrag.payload))
  } catch {
    return null
  }
}

async function findeBuchungOutbox(buchungIds: Set<string>): Promise<OutboxEintrag[]> {
  const alle = await getDb().outbox.toArray()
  return alle.filter((eintrag) => {
    const id = outboxBuchungIds(eintrag)
    return id !== null && buchungIds.has(id)
  })
}

/**
 * Server-side rejections are encoded by the worker as `CODE: message`
 * (e.g. `CONFLICT: …`, `VALIDATION: …`). Network errors have no such code
 * prefix, so this distinguishes a definitive rejection from a retryable
 * transport failure.
 */
function serverAblehnung(eintrag: OutboxEintrag): string | null {
  if (eintrag.quarantinedAt !== null) {
    return eintrag.quarantineReason ?? eintrag.lastError ?? 'Unbekannter Server-Fehler'
  }
  if (!eintrag.lastError) return null
  return /^(CONFLICT|[A-Z][A-Z0-9_]+):/.test(eintrag.lastError) ? eintrag.lastError : null
}

/**
 * Triggers a sync and polls the outbox until all given booking IDs are
 * confirmed, rejected, or the timeout elapses.
 *
 * - `bestaetigt`: server accepted every booking.
 * - `abgelehnt`: server definitively rejected at least one booking.
 * - `ausstehend`: offline or timeout; the booking is still queued locally.
 */
export async function syncUndBestaetigeBuchungen(
  buchungIds: string[],
  opts: { apiBase: string; token: string | null; timeoutMs?: number },
): Promise<BuchungBestaetigung> {
  const ids = new Set(buchungIds)
  if (ids.size === 0) return { status: 'bestaetigt' }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'ausstehend', grund: 'offline', fehler: null }
  }

  const timeoutMs = opts.timeoutMs ?? BUCHUNG_BESTAETIGUNG_TIMEOUT_MS
  const startedAt = Date.now()
  let lastTriggerAt = 0

  while (Date.now() - startedAt < timeoutMs) {
    const rows = await findeBuchungOutbox(ids)

    if (rows.length === ids.size && rows.every((row) => row.syncedAt !== null)) {
      return { status: 'bestaetigt' }
    }

    for (const row of rows) {
      const grund = serverAblehnung(row)
      if (grund) return { status: 'abgelehnt', grund }
    }

    const status = getSyncStatus()
    if (status.status === 'offline') {
      return { status: 'ausstehend', grund: 'offline', fehler: status.lastError }
    }

    const now = Date.now()
    const nextRetry = status.nextRetryAt ? Date.parse(status.nextRetryAt) : 0
    const retryAllowed = !status.nextRetryAt || !Number.isFinite(nextRetry) || nextRetry <= now
    if (status.status !== 'syncing' && retryAllowed && now - lastTriggerAt >= TRIGGER_THROTTLE_MS) {
      lastTriggerAt = now
      // Fire and forget: the polling loop observes the outbox result. If a
      // run is already active, the worker schedules an immediate rerun.
      void triggerSyncNow({ apiBase: opts.apiBase, token: opts.token })
    }

    await delay(POLL_MS)
  }

  const rest = await findeBuchungOutbox(ids)
  for (const row of rest) {
    const grund = serverAblehnung(row)
    if (grund) return { status: 'abgelehnt', grund }
  }
  return { status: 'ausstehend', grund: 'timeout', fehler: getSyncStatus().lastError }
}
