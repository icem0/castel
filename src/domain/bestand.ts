// Bestandsberechnung.
// Kernregel aus AGENTS.md: Bestand ist die Summe der Buchungen.
// Stornierte Buchungen zählen nicht (storno = true).
//
// WICHTIG: Diese Pure-Funktion ist byte-identisch zur Server-Variante in
// `server/src/domain/bestand.ts` (Modul `berechneBestandPure`). Ein
// Property-Test (`src/domain/__tests__/bestand-paritaet.test.ts`) liest
// beide Quelldateien ein und verifiziert, dass die Funktionskörper
// übereinstimmen. Bei einer Änderung muss die Server-Variante angepasst
// werden (oder umgekehrt). Der DB-Layer (Drizzle-SQL bzw. Dexie) ist
// separat.

/**
 * Strukturelles Minimum an Feldern, das die Pure-Funktionen brauchen.
 * Sowohl `Buchung` aus `src/db/types.ts` (PWA, Dexie) als auch die
 * Drizzle-Row aus `server/src/db/schema.ts` erfüllen diese Form.
 */
export interface BestandBuchung {
  standortId: string
  menge: number
  storno: boolean
}

/**
 * Bestand eines Artikels an einem Standort.
 * Zählt nur nicht-stornierte Buchungen. Bei umlagerung trägt die entnahme
 * die negative Menge an der Quelle, die einlagerung die positive am Ziel.
 * Inventur-Buchungen sind bereits als Differenz (soll - bestand) kodiert.
 */
export function berechneBestand(buchungen: BestandBuchung[], standortId: string): number {
  let summe = 0
  for (const b of buchungen) {
    if (b.storno) continue
    if (b.standortId === standortId) summe += b.menge
  }
  return summe
}

/**
 * Bestand eines Artikels aufgeschlüsselt nach Standort.
 */
export function berechneBestandProStandort(buchungen: BestandBuchung[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const b of buchungen) {
    if (b.storno) continue
    map.set(b.standortId, (map.get(b.standortId) ?? 0) + b.menge)
  }
  return map
}

/**
 * Summe aller (nicht-stornierten) Buchungen — nützlich für Inventur-Differenzen.
 */
export function summeAktiveBuchungen(buchungen: BestandBuchung[]): number {
  let summe = 0
  for (const b of buchungen) {
    if (!b.storno) summe += b.menge
  }
  return summe
}
