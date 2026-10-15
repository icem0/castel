// Bestandsformel: Σ buchungen.menge where storno=false und standortId = :s.
//
// Diese Datei hat zwei Schichten:
//   1) Pure-Funktionen (`berechneBestandPure` und Helfer) — exakt dieselbe
//      Logik wie in `src/domain/bestand.ts` der PWA. Ein Property-Test
//      (`src/domain/__tests__/bestand-paritaet.test.ts` auf PWA-Seite)
//      liest beide Quelldateien ein und verifiziert die Byte-Identität.
//   2) SQL-Layer (Drizzle) für den Server (`berechneBestand`,
//      `berechneBestaendeProArtikel`) — übersetzt dieselbe Formel in eine
//      aggregierte Query gegen Postgres. Dient dem Snapshot-Endpoint und
//      dem Negativ-Bestand-Check im Sync-Resolver.
//
// Wichtig: Der Sync-Resolver (`src/sync/resolver.ts`) importiert die
// SQL-Variante. Validierung + Schreiben bleiben im Resolver.

import { sql, eq, and } from 'drizzle-orm'
import { buchungen } from '../db/schema.js'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '../db/schema.js'

// ---------- Pure-Layer (byte-identisch zur PWA-Variante) ----------

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
export function berechneBestandPure(buchungen: BestandBuchung[], standortId: string): number {
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
export function berechneBestandProStandortPure(
  buchungen: BestandBuchung[],
): Map<string, number> {
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
export function summeAktiveBuchungenPure(buchungen: BestandBuchung[]): number {
  let summe = 0
  for (const b of buchungen) {
    if (!b.storno) summe += b.menge
  }
  return summe
}

// ---------- SQL-Layer (Drizzle / Postgres) ----------

export interface BestandResult {
  artikelId: string
  standortId: string
  menge: number
}

/**
 * Bestand für einen Artikel an einem Standort (SQL-Layer).
 *
 * Modellierung (PLAN §4):
 *   * einlagerung / entnahme / inventur / kommission / storno
 *     → haben nur `standortId`; Menge positiv oder negativ.
 *   * umlagerung
 *     → als zwei Buchungen mit gleicher `paarId` gespeichert:
 *       - entnahme am Quellstandort mit negativer Menge (`standortId = von`)
 *       - einlagerung am Zielstandort mit positiver Menge (`standortId = nach`)
 *
 * Daher reicht die einfache Summe: alle Buchungen, deren `standortId = s`
 * (für Umlagerungen steht jede Teilbuchung bereits auf der betroffenen
 * Seite). Negativ ist erlaubt (zeigt die Konflikt-Situation nach
 * Offline-Buchungen); der Sync-Resolver lehnt das beim Push ab.
 */
export async function berechneBestand(
  db: PostgresJsDatabase<typeof schema>,
  artikelId: string,
  standortId: string,
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${buchungen.menge}), 0)::int` })
    .from(buchungen)
    .where(
      and(
        eq(buchungen.artikelId, artikelId),
        eq(buchungen.storno, false),
        eq(buchungen.standortId, standortId),
      ),
    )
  return rows[0]?.total ?? 0
}

/**
 * Liste aller Bestände für einen Artikel (gruppiert nach Standort).
 * Wird im Snapshot-Endpoint und fürs Push-Audit benutzt.
 *
 * Jede Buchung trägt ihren `standortId` auf der betroffenen Seite (auch
 * Umlagerungs-Teilbuchungen), daher reicht eine einzelne gruppierte Query.
 */
export async function berechneBestaendeProArtikel(
  db: PostgresJsDatabase<typeof schema>,
  artikelId: string,
): Promise<BestandResult[]> {
  const rows = await db
    .select({
      sid: buchungen.standortId,
      total: sql<number>`coalesce(sum(${buchungen.menge}), 0)::int`,
    })
    .from(buchungen)
    .where(and(eq(buchungen.artikelId, artikelId), eq(buchungen.storno, false)))
    .groupBy(buchungen.standortId)

  const results: BestandResult[] = []
  for (const r of rows) {
    if (r.sid) results.push({ artikelId, standortId: r.sid, menge: r.total })
  }
  return results
}
