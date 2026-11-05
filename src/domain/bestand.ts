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
//
// Darüber hinaus liefert dieses Modul `bestandFuerPaar`, das den
// materialisierten Bestand aus der `bestand`-Tabelle liest und um lokale,
// noch nicht zum Server gepushte Buchungen korrigiert (solange der Pull
// den neuen Server-Stand noch nicht gebracht hat).

import { getDb } from '../db/database'

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

/**
 * Bestand eines Artikels an einem Standort, wie der Client ihn derzeit
 * sehen soll: der materialisierte `bestand`-Wert vom Server plus die
 * lokal noch nicht gepushten Buchungen (korrigiert den materialisierten
 * Stand, bis der Pull den aktualisierten Server-Wert liefert).
 *
 * Gibt 0 zurück, wenn es noch keine `bestand`-Zeile für das Paar gibt
 * (z. B. vor dem ersten Rebase / für frische Paare).
 */
export async function bestandFuerPaar(artikelId: string, standortId: string): Promise<number> {
  const db = getDb()
  const row = await db.bestand.get([artikelId, standortId])
  if (row !== undefined) {
    // Materialisierter Server-Stand existiert — korrigiere um lokal noch
    // nicht gepushte Buchungen, bis der Pull den aktuellen Stand bringt.
    let korrektur = 0
    const pending = await db.buchungen.filter((b) => b.pendingSync === true).toArray()
    for (const b of pending) {
      if (b.artikelId === artikelId && b.standortId === standortId) korrektur += b.menge
    }
    return row.menge + korrektur
  }
  // Keine bestand-Zeile (vor dem ersten Rebase / für frische Paare): über
  // die lokalen Buchungen summieren. Nach dem Rebase existiert für jedes
  // Paar eine Zeile, dieser Pfad wird dann nicht mehr genommen.
  const alle = await db.buchungen.where('artikelId').equals(artikelId).toArray()
  return berechneBestand(alle, standortId)
}
