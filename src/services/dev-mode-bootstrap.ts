// dev-mode-bootstrap.ts — Drop der lokalen IndexedDB beim App-Start, wenn
// DEV_MODE aktiv ist.
//
// Hintergrund:
//   Der Server truncatet bei DEV_MODE=true seine DB-Tabellen, aber die
//   PWA hat ihre eigene IndexedDB (Dexie). Beim naechsten Login synct
//   die PWA die lokalen Daten wieder hoch -> die Server-Daten sind
//   sofort wieder da. Damit das nicht passiert, leeren wir auch die
//   Browser-DB direkt beim Bootstrap, BEVOR die Vue-App mountet und
//   BEVOR irgendein Sync-Worker laufen kann.
//
// Aufruf: in main.ts VOR app.mount('#app'). Vor diesem Zeitpunkt ist
// noch nichts initialisiert (kein Pinia, kein Router, kein Sync-Worker,
// keine Auth-Store), also auch nichts, was in die DB schreiben koennte.
//
// Wenn DEV_MODE nicht aktiv: No-Op, normale Initialisierung.
//
// Fehler beim Drop werden geloggt, aber NICHT eskaliert. Wenn die DB
// nicht geloescht werden kann (z. B. weil die IndexedDB-API im Browser
// fehlt), laeuft die App normal weiter mit den vorhandenen Daten —
// das ist besser als ein totaler App-Crash wegen einer Debug-Hilfe.

import { getDb, resetDbForTests } from '../db/database'
import { resolveDevMode } from '../composables/useDevMode'

const RESET_MARKER_KEY = 'dev.lastResetAt'

interface ResetResult {
  performed: boolean
  reason: 'dev-mode' | 'disabled' | 'no-op' | 'error'
  error?: string
  timestamp: string
}

/**
 * Droppt die lokale IndexedDB, wenn DEV_MODE aktiv ist. Vor dem Aufruf
 * darf noch nichts mit der DB interagiert haben (also vor app.mount).
 * Setzt im Erfolgsfall einen localStorage-Marker, den die LoginView
 * als Hinweis anzeigen kann.
 */
export async function runDevModeBootstrap(): Promise<ResetResult> {
  const timestamp = new Date().toISOString()
  if (!resolveDevMode()) {
    return { performed: false, reason: 'disabled', timestamp }
  }

  try {
    const db = getDb()
    db.close()
    await db.delete()
    resetDbForTests()

    try {
      localStorage.setItem(RESET_MARKER_KEY, JSON.stringify({ at: timestamp }))
    } catch {
      // localStorage nicht verfuegbar — nicht schlimm, der Hinweis
      // erscheint dann einfach nicht.
    }

    console.warn(
      `[dev-bootstrap] DEV_MODE=true → IndexedDB 'castel' gedroppt. ` +
        'App startet mit leerem lokalen Cache.',
    )
    return { performed: true, reason: 'dev-mode', timestamp }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)

    console.warn(
      `[dev-bootstrap] DEV_MODE=true, aber IndexedDB-Drop fehlgeschlagen: ${msg}. ` +
        'App laeuft mit vorhandenen Daten weiter.',
    )
    return { performed: false, reason: 'error', error: msg, timestamp }
  }
}

/**
 * Liest den Reset-Marker (localStorage). LoginView nutzt das, um einen
 * dezenten Hinweis "Lokale Datenbank um HH:MM zurueckgesetzt" zu zeigen.
 * Gibt null zurueck, wenn kein Drop in dieser Session stattfand.
 */
export function readDevResetMarker(): { at: string } | null {
  try {
    const raw = localStorage.getItem(RESET_MARKER_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'at' in parsed &&
      typeof (parsed as { at: unknown }).at === 'string'
    ) {
      return { at: (parsed as { at: string }).at }
    }
    return null
  } catch {
    return null
  }
}

export function clearDevResetMarker(): void {
  try {
    localStorage.removeItem(RESET_MARKER_KEY)
  } catch {
    // ignore
  }
}
