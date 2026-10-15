// Pure validation logic for the BuchungFormView (view-layer rules).
//
// Why a separate module?
//   - Lets us unit-test the rules without mounting a Vue component.
//   - Keeps the view-script short and focused on wiring.
//   - Uses the same field semantics as the domain-layer asserts in
//     `domain/validierung.ts` and `domain/errors.ts`, but is view-only:
//     it returns the first failing message as a string instead of
//     throwing typed domain errors.

import type { BuchungsTyp } from '../db/types'

export interface BuchungsEingabe {
  typ: BuchungsTyp
  artikelId: string
  standortId: string
  zielStandortId: string
  menge: number
  sollMenge: number
}

/**
 * Returns `null` if the input is acceptable, otherwise the first
 * human-readable error message. The caller decides how to surface it
 * (alert-box, inline error, toast, ...).
 */
export function validiereBuchungsEingabe(e: BuchungsEingabe): string | null {
  if (!e.artikelId) return 'Artikel fehlt'
  if (!e.standortId) return 'Standort fehlt'

  if (e.typ === 'inventur') {
    if (typeof e.sollMenge !== 'number' || Number.isNaN(e.sollMenge) || e.sollMenge < 0) {
      return 'Soll-Menge fehlt oder ungültig'
    }
    return null
  }

  // einlagerung / entnahme / umlagerung
  if (typeof e.menge !== 'number' || !Number.isFinite(e.menge) || e.menge <= 0) {
    return 'Menge muss > 0 sein'
  }

  if (e.typ === 'umlagerung') {
    if (!e.zielStandortId) return 'Zielstandort fehlt'
    if (e.zielStandortId === e.standortId) {
      return 'Quell- und Zielstandort sind identisch'
    }
  }

  return null
}
