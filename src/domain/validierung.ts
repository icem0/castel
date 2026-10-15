// Reine Validatoren für Eingabeparameter der Domänen-Schicht.
// Werden von den create*-Funktionen UND direkt in Tests verwendet.

import type { Iso } from '../db/types'
import { PflichtfeldFehltError, UngueltigeMengeError, ZukunftsDatumError } from './errors'

export function assertMengePositiv(menge: number): void {
  if (typeof menge !== 'number' || !Number.isFinite(menge) || menge <= 0) {
    throw new UngueltigeMengeError(menge)
  }
}

export function assertPflichtfeld(name: string, value: unknown): void {
  if (value === null || value === undefined || value === '') {
    throw new PflichtfeldFehltError(name)
  }
}

/**
 * Wirft, wenn `datum` in der Zukunft liegt (mehr als 1 Minute Toleranz für
 * Client/Server-Clock-Drift). Buchungen mit Zukunfts-Datum sind ein
 * klassischer Eingabefehler und führen zu falscher zeitlicher Sortierung.
 */
export function assertKeinZukunftsDatum(datum: Iso, name = 'erstelltAm'): void {
  if (typeof datum !== 'string' || Number.isNaN(Date.parse(datum))) {
    throw new PflichtfeldFehltError(`${name} (muss ISO-8601-Datum sein)`)
  }
  const ts = Date.parse(datum)
  const driftMs = 60_000
  if (ts - driftMs > Date.now()) {
    throw new ZukunftsDatumError(name, new Date(ts).toISOString())
  }
}
