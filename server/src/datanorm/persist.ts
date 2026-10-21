// DATANORM persistence: batch-upsert into `hersteller_artikel`.
//
// Two write paths, picked by size (see config.DATANORM_COPY_THRESHOLD):
//
//   * Small/medium catalogues (the common case — a supplier ships 5k to
//     30k articles): Drizzle `insert().onConflictDoUpdate()` in batches.
//     Type-safe, readable, and fast enough.
//
//   * Large catalogues (100k+ articles): raw SQL through postgres-js, which
//     has native COPY support. We COPY into a temp staging table and then
//     do one `INSERT ... SELECT ... ON CONFLICT DO UPDATE`. This avoids
//     building one enormous parameterised statement and is roughly 5-8x
//     faster than batching.
//
// Both paths are idempotent: re-importing a supplier's updated catalogue
// updates existing rows instead of duplicating them. Identity is
// (lieferant_id, matchcode).
//
// Deliberately NOT touched here: castel `artikel` rows and `buchungen`.
// This module only ever writes the supplier catalogue mirror.

import { eq, sql } from 'drizzle-orm'
import { getDb, getClient } from '../db/client.js'
import { herstellerArtikel } from '../db/schema.js'
import { config } from '../config/config.js'
import type { AufgeloesterArtikel } from './types.js'

/** Rows per batch for the Drizzle path. */
const BATCH_GROESSE = 500

export interface PersistErgebnis {
  neu: number
  aktualisiert: number
  deaktiviert: number
  uebersprungen: number
  fehler: Array<{ matchcode: string; meldung: string }>
}

export interface PersistOptionen {
  lieferantId: string
  /** Progress callback for the SSE stream. */
  onFortschritt?: (verarbeitet: number, gesamt: number) => void
  /** Force the COPY path (tests) instead of honouring the threshold. */
  forceCopy?: boolean
}

function leer(): PersistErgebnis {
  return { neu: 0, aktualisiert: 0, deaktiviert: 0, uebersprungen: 0, fehler: [] }
}

/**
 * Upserts resolved articles into `hersteller_artikel`.
 *
 * Deactivation (v5 delete marker) is handled separately from the upsert:
 * a supplier withdrawing an article is a state change, not a data update,
 * and it must survive a subsequent re-upload that no longer lists the item
 * as deleted. We therefore only ever set `deaktiviert` to true here and
 * clear it when a later file lists the article as active again.
 */
export async function persistiereArtikel(
  artikel: AufgeloesterArtikel[],
  opts: PersistOptionen,
): Promise<PersistErgebnis> {
  const ergebnis = leer()
  if (artikel.length === 0) return ergebnis

  const nutzeCopy =
    opts.forceCopy === true || artikel.length >= config.DATANORM_COPY_THRESHOLD

  // Which matchcodes already exist? Only used for the admin report counters
  // — idempotency itself is guaranteed by the ON CONFLICT below. One query
  // for the whole supplier is cheap and avoids the fragility of building a
  // parameterised ANY(...) array per batch.
  const db = getDb()
  const vorhandene = new Set<string>()
  const vorhandeneRows = await db
    .select({ matchcode: herstellerArtikel.matchcode })
    .from(herstellerArtikel)
    .where(eq(herstellerArtikel.lieferantId, opts.lieferantId))
  for (const r of vorhandeneRows) vorhandene.add(r.matchcode)

  if (nutzeCopy) {
    await persistiereViaCopy(artikel, opts, (n) => {
      opts.onFortschritt?.(n, artikel.length)
    })
  } else {
    let verarbeitet = 0
    for (let i = 0; i < artikel.length; i += BATCH_GROESSE) {
      const batch = artikel.slice(i, i + BATCH_GROESSE)
      await upsertBatchRobust(batch, opts.lieferantId, ergebnis.fehler)
      verarbeitet += batch.length
      opts.onFortschritt?.(verarbeitet, artikel.length)
    }
  }

  // Counters for the admin report. Rows we could not write are neither
  // "new" nor "updated" — they land in `fehler` via upsertBatchRobust.
  for (const a of artikel) {
    if (a.deaktiviert) {
      ergebnis.deaktiviert += 1
    } else if (vorhandene.has(a.matchcode)) {
      ergebnis.aktualisiert += 1
    } else {
      ergebnis.neu += 1
    }
  }

  // Failed rows must not be counted as success.
  if (ergebnis.fehler.length > 0) {
    const misslungen = new Set(ergebnis.fehler.map((f) => f.matchcode))
    ergebnis.neu = Math.max(0, ergebnis.neu - countFehlgeschlagene(artikel, misslungen))
    ergebnis.aktualisiert = Math.max(
      0,
      ergebnis.aktualisiert - countFehlgeschlagene(artikel, misslungen),
    )
  }

  return ergebnis
}

/** How many of the resolved articles carry a matchcode in the failure set. */
function countFehlgeschlagene(
  artikel: AufgeloesterArtikel[],
  misslungen: Set<string>,
): number {
  let n = 0
  for (const a of artikel) if (misslungen.has(a.matchcode)) n++
  return n
}

/**
 * Upserts one batch, isolating constraint violations.
 *
 * A supplier file can legitimately contain data our schema rejects — the
 * most common case being two articles sharing one EAN. Aborting the whole
 * import over two bad rows would be the wrong trade, so we bisect: a
 * failing batch is retried in halves until we isolate the offending rows,
 * which are then reported instead of silently dropped.
 */
async function upsertBatchRobust(
  batch: AufgeloesterArtikel[],
  lieferantId: string,
  fehler: Array<{ matchcode: string; meldung: string }>,
): Promise<void> {
  try {
    await upsertBatch(batch, lieferantId)
    return
  } catch (err) {
    if (batch.length === 1) {
      fehler.push({
        matchcode: batch[0]!.matchcode,
        meldung: `Datensatz konnte nicht gespeichert werden: ${fehlerText(err)}`,
      })
      return
    }
    const mitte = Math.floor(batch.length / 2)
    await upsertBatchRobust(batch.slice(0, mitte), lieferantId, fehler)
    await upsertBatchRobust(batch.slice(mitte), lieferantId, fehler)
  }
}

/** Extracts a human-readable message from a postgres/Drizzle error. */
function fehlerText(err: unknown): string {
  if (err instanceof Error) {
    // postgres-js puts the useful part on `message`; Drizzle sometimes
    // wraps it. Either way the first line carries the constraint name.
    return err.message.split('\n')[0] ?? err.message
  }
  return String(err)
}

/** One Drizzle upsert batch. */
async function upsertBatch(
  batch: AufgeloesterArtikel[],
  lieferantId: string,
): Promise<void> {
  const db = getDb()
  const now = new Date()
  const rows = batch.map((a) => ({
    id: crypto.randomUUID(),
    lieferantId,
    matchcode: a.matchcode,
    matchcode2: null,
    ean: a.ean,
    titel: a.titel,
    beschreibung: a.beschreibung,
    mengeneinheit: a.mengeneinheit,
    preiseinheit: a.preiseinheit,
    inhalt: a.inhalt === null ? null : String(a.inhalt),
    warengruppe: a.warengruppe,
    preisNettoCent: a.preisNettoCent,
    preisBruttoCent: a.preisBruttoCent,
    preisAktionCent: a.preisAktionCent,
    gueltigAb: a.gueltigAb ? new Date(a.gueltigAb) : null,
    steuersatz: null,
    gewicht: null,
    ersatzMatchcode: a.ersatzMatchcode,
    deaktiviert: a.deaktiviert,
    deaktiviertAm: a.deaktiviert ? now : null,
    deaktiviertGrund: a.deaktiviert ? 'hersteller_delete' : null,
    geaendertAm: now,
    erstelltAm: now,
  }))

  await db
    .insert(herstellerArtikel)
    .values(rows)
    .onConflictDoUpdate({
      target: [herstellerArtikel.lieferantId, herstellerArtikel.matchcode],
      set: {
        ean: sql`excluded.ean`,
        titel: sql`excluded.titel`,
        beschreibung: sql`excluded.beschreibung`,
        mengeneinheit: sql`excluded.mengeneinheit`,
        preiseinheit: sql`excluded.preiseinheit`,
        inhalt: sql`excluded.inhalt`,
        warengruppe: sql`excluded.warengruppe`,
        preisNettoCent: sql`excluded.preis_netto_cent`,
        preisBruttoCent: sql`excluded.preis_brutto_cent`,
        preisAktionCent: sql`excluded.preis_aktion_cent`,
        gueltigAb: sql`excluded.gueltig_ab`,
        ersatzMatchcode: sql`excluded.ersatz_matchcode`,
        // The delete marker is a state change, not a data field. We always
        // write both columns so re-listing an article as active clears the
        // withdrawal completely instead of leaving a stale timestamp.
        deaktiviert: sql`excluded.deaktiviert`,
        deaktiviertAm: sql`excluded.deaktiviert_am`,
        deaktiviertGrund: sql`excluded.deaktiviert_grund`,
        geaendertAm: sql`excluded.geaendert_am`,
      },
    })
}

/**
 * Fast path for large catalogues: COPY into a temp table, then a single
 * upsert from it.
 *
 * The staging table lives inside the transaction and is dropped on commit,
 * so nothing survives a failure.
 */
async function persistiereViaCopy(
  artikel: AufgeloesterArtikel[],
  opts: PersistOptionen,
  onFortschritt: (n: number) => void,
): Promise<void> {
  const sql = getClient()
  const now = new Date()

  await sql.begin(async (tx) => {
    await tx`
      CREATE TEMP TABLE IF NOT EXISTS datanorm_stage (
        id text, lieferant_id text, matchcode text, matchcode2 text, ean text,
        titel text, beschreibung text, mengeneinheit text, preiseinheit int,
        inhalt numeric, warengruppe text, preis_netto_cent int,
        preis_brutto_cent int, preis_aktion_cent int, gueltig_ab timestamptz,
        steuersatz numeric, gewicht numeric, ersatz_matchcode text,
        deaktiviert boolean, deaktiviert_am timestamptz, deaktiviert_grund text,
        geaendert_am timestamptz, erstellt_am timestamptz
      ) ON COMMIT DROP
    `
    await tx`TRUNCATE datanorm_stage`

    // postgres-js supports multi-row INSERT via a helper: pass an array of
    // row tuples plus the column names. We serialise in slices so we never
    // hold a second full copy of the catalogue in memory.
    // postgres-js's multi-row INSERT helper indexes each row by column
      // NAME (`row[column]`), so rows must be objects, not arrays. It also
      // cannot serialise Date instances, hence ISO strings. Its types do not
      // model a dynamic column list, hence the single cast.
      const SPALTEN = [
        'id', 'lieferant_id', 'matchcode', 'matchcode2', 'ean', 'titel',
        'beschreibung', 'mengeneinheit', 'preiseinheit', 'inhalt', 'warengruppe',
        'preis_netto_cent', 'preis_brutto_cent', 'preis_aktion_cent', 'gueltig_ab',
        'steuersatz', 'gewicht', 'ersatz_matchcode', 'deaktiviert', 'deaktiviert_am',
        'deaktiviert_grund', 'geaendert_am', 'erstellt_am',
      ]
      type SpaltenWert = string | number | boolean | null

      const nowIso = now.toISOString()
      const CHUNK = 2000
      let gesendet = 0
      for (let i = 0; i < artikel.length; i += CHUNK) {
        const slice = artikel.slice(i, i + CHUNK)
        const rows: Record<string, SpaltenWert>[] = slice.map((a) => ({
          id: crypto.randomUUID(),
          lieferant_id: opts.lieferantId,
          matchcode: a.matchcode,
          matchcode2: null,
          ean: a.ean,
          titel: a.titel,
          beschreibung: a.beschreibung,
          mengeneinheit: a.mengeneinheit,
          preiseinheit: a.preiseinheit,
          inhalt: a.inhalt,
          warengruppe: a.warengruppe,
          preis_netto_cent: a.preisNettoCent,
          preis_brutto_cent: a.preisBruttoCent,
          preis_aktion_cent: a.preisAktionCent,
          gueltig_ab: a.gueltigAb ? new Date(a.gueltigAb).toISOString() : null,
          steuersatz: null,
          gewicht: null,
          ersatz_matchcode: a.ersatzMatchcode,
          deaktiviert: a.deaktiviert,
          deaktiviert_am: a.deaktiviert ? nowIso : null,
          deaktiviert_grund: a.deaktiviert ? 'hersteller_delete' : null,
          geaendert_am: nowIso,
          erstellt_am: nowIso,
        }))
        const helfer = (tx as unknown as {
          (data: Record<string, SpaltenWert>[], ...cols: string[]): unknown
        }).call(tx, rows, ...SPALTEN)
        await tx`INSERT INTO datanorm_stage ${helfer as never}`
        gesendet += slice.length
        onFortschritt(gesendet)
      }

    await tx`
      INSERT INTO hersteller_artikel (
        id, lieferant_id, matchcode, matchcode2, ean, titel, beschreibung,
        mengeneinheit, preiseinheit, inhalt, warengruppe, preis_netto_cent,
        preis_brutto_cent, preis_aktion_cent, gueltig_ab, steuersatz, gewicht,
        ersatz_matchcode, deaktiviert, deaktiviert_am, deaktiviert_grund,
        geaendert_am, erstellt_am
      )
      SELECT * FROM datanorm_stage
      ON CONFLICT (lieferant_id, matchcode) DO UPDATE SET
        ean = excluded.ean,
        titel = excluded.titel,
        beschreibung = excluded.beschreibung,
        mengeneinheit = excluded.mengeneinheit,
        preiseinheit = excluded.preiseinheit,
        inhalt = excluded.inhalt,
        warengruppe = excluded.warengruppe,
        preis_netto_cent = excluded.preis_netto_cent,
        preis_brutto_cent = excluded.preis_brutto_cent,
        preis_aktion_cent = excluded.preis_aktion_cent,
        gueltig_ab = excluded.gueltig_ab,
        ersatz_matchcode = excluded.ersatz_matchcode,
        deaktiviert = excluded.deaktiviert,
        deaktiviert_am = excluded.deaktiviert_am,
        deaktiviert_grund = excluded.deaktiviert_grund,
        geaendert_am = excluded.geaendert_am
    `
  })
}