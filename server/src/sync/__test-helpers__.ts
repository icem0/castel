// Reine Hilfsfunktion für Last-Writer-Wins. Wird sowohl intern vom
// Resolver genutzt als auch direkt in Tests.
//
// Wir extrahieren sie, damit die Logik ohne DB testbar ist.

import { ConflictError } from './resolver.js'

export interface LastWriterWinsParams {
  serverGeaendertAm: Date
  incomingGeaendertAm: Date
  id: string
}

/**
 * Prüft, ob die eingehende Änderung die Server-Version überschreiben darf.
 * Wirft ConflictError, wenn der Server neuer ist (strictly greater).
 */
export function applyLastWriterWinsMock(p: LastWriterWinsParams): void {
  if (p.serverGeaendertAm.getTime() > p.incomingGeaendertAm.getTime()) {
    throw new ConflictError(
      `Server-Version ist neuer (${p.serverGeaendertAm.toISOString()} > ${p.incomingGeaendertAm.toISOString()})`,
    )
  }
}