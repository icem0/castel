// DATANORM import orchestration.
//
// The upload is streamed once, not buffered: a real supplier catalogue can
// run to hundreds of megabytes, and Fastify's default 4 MB body limit plus a
// full in-memory buffer would be wrong on both counts.
//
// One pass over the request stream does three things at once:
//   1. SHA-256 over the bytes (duplicate-upload detection)
//   2. write the original to DATANORM_DIR (kept for audit / re-processing)
//   3. hand the same chunks to Pass 1
//
// The DB work is deliberately separate: Pass 1 collects, Pass 2 resolves,
// persistence upserts. We only open a DB transaction for the persistence
// step so a parse failure does not hold locks.

import { createHash } from 'node:crypto'
import { createWriteStream, constants } from 'node:fs'
import { access, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { eq, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { getDb } from '../db/client.js'
import {
  auditLog,
  datanormDateien,
  datanormImporte,
  herstellerArtikel,
  lieferanten,
} from '../db/schema.js'
import { config } from '../config/config.js'
import { DatanormFehler, sammleDatanorm } from './parse-pass1.js'
export { DatanormFehler } from './parse-pass1.js'
import { loeseAuf } from './resolve.js'
import { persistiereArtikel } from './persist.js'
import { MAX_FEHLER_DETAILS } from './parse-pass1.js'
import { kanalFuer, meldeFertig } from './progress.js'
import type { DatanormEncoding, DatanormFormat, ImportFortschritt, Parserfehler } from './types.js'

/** Cap on stored error details, mirroring the parser's own cap. */
const FEHLER_DETAILS_LIMIT = MAX_FEHLER_DETAILS

export interface ImportErgebnis {
  importId: string
  status: 'erfolg' | 'teilfehler' | 'fehler' | 'duplikat'
  artikelAnzahl: number
  neu: number
  aktualisiert: number
  deaktiviert: number
  uebersprungen: number
  fehlerAnzahl: number
  fehlerDetails: Parserfehler[]
  encoding: DatanormEncoding | null
  version: number | null
  /** Set when the same file was already uploaded for this supplier. */
  vorhandenerImportId?: string
  auffaelligkeiten: string[]
}

export interface ImportOptionen {
  lieferantId: string
  originalDateiname: string
  stream: Readable
  /**
   * User who triggered the import. Nullable: `datanorm_importe.benutzer_id`
   * is a real FK to `users`, so we must not invent an 'unknown' id — that
   * would violate the constraint. System-triggered imports store NULL.
   */
  benutzerId: string | null
  /** Admin override when auto-detection was not confident. */
  encoding?: DatanormEncoding
  /** Admin override for the format (auto detection or a forced version). */
  format?: DatanormFormat
  log: FastifyBaseLogger
  onFortschritt?: (f: ImportFortschritt) => void
}

/**
 * Version of the parser logic.
 *
 * Bumped whenever the interpretation of a file changes (new field layout,
 * corrected price logic, …). A file that was imported with an older parser
 * is NOT a duplicate of the same file today — otherwise a corrected import
 * would be silently skipped and the broken catalogue rows would stay.
 *
 * 1 = the first implementation (fixed-width columns — wrong for every real
 *     supplier file)
 * 2 = semicolon-separated fields per the DATANORM specification
 */
export const PARSER_VERSION = 2

/** The file row for these bytes, regardless of the parser version. */
async function findeDatei(
  lieferantId: string,
  hash: string,
): Promise<{ id: string; parserVersion: number } | null> {
  const db = getDb()
  const datei = await db
    .select({ id: datanormDateien.id, parserVersion: datanormDateien.parserVersion })
    .from(datanormDateien)
    .where(
      sql`${datanormDateien.lieferantId} = ${lieferantId} AND ${datanormDateien.dateiHash} = ${hash}`,
    )
    .limit(1)
  return datei[0] ?? null
}

/** Maps an existing upload of the same bytes to its import id. */
async function findeDuplikat(
  lieferantId: string,
  hash: string,
): Promise<{ dateiId: string; importId: string } | null> {
  const db = getDb()
  const datei = await db
    .select({ id: datanormDateien.id })
    .from(datanormDateien)
    .where(
      sql`${datanormDateien.lieferantId} = ${lieferantId} AND ${datanormDateien.dateiHash} = ${hash} AND ${datanormDateien.parserVersion} = ${PARSER_VERSION}`,
    )
    .limit(1)
  if (datei.length === 0) return null
  const importRow = await db
    .select({ id: datanormImporte.id })
    .from(datanormImporte)
    .where(sql`${datanormImporte.dateiId} = ${datei[0]!.id}`)
    .orderBy(sql`${datanormImporte.gestartetAm} DESC`)
    .limit(1)
  return {
    dateiId: datei[0]!.id,
    importId: importRow[0]?.id ?? '',
  }
}

/** Sanitises a supplier-supplied filename for on-disk use. */
function sichererDateiname(name: string): string {
  const basis = name.split(/[\\/]/).pop() ?? 'datanorm'
  const bereinigt = basis.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return bereinigt === '' || bereinigt === '.' ? 'datanorm' : bereinigt
}

/** True for the separate price-only DATPREIS files. */
export function istPreisdatei(name: string): boolean {
  return /^datpreis[._-]?\d*\.?(txt|dat|asc|001)?$/i.test(name.trim())
}

/**
 * Checks at startup that DATANORM_DIR exists and is writable.
 *
 * The directory lives on a named volume. If the image does not create it
 * (or the volume carries the wrong owner), the container's non-root user
 * cannot write there and EVERY catalogue upload fails with EACCES. A loud
 * log at startup is far easier to diagnose than a 500 in the middle of an
 * upload.
 *
 * Returns true when the directory is usable.
 */
export async function pruefeDatanormAblage(log: FastifyBaseLogger): Promise<boolean> {
  try {
    await mkdir(config.DATANORM_DIR, { recursive: true })
    await access(config.DATANORM_DIR, constants.W_OK)
    log.info({ dir: config.DATANORM_DIR }, '[datanorm] Ablageverzeichnis bereit')
    return true
  } catch (err) {
    log.error(
      { err, dir: config.DATANORM_DIR },
      '[datanorm] DATANORM_DIR ist nicht anlegbar/schreibbar — Katalog-Uploads ' +
        'werden fehlschlagen. Rechte im Container pruefen: ' +
        'docker compose exec --user root api chown -R castel:castel ' +
        config.DATANORM_DIR,
    )
    return false
  }
}

/**
 * Runs one full import: stream -> hash -> store -> parse -> resolve -> upsert.
 *
 * Never throws for data problems (a bad file is a report, not a 500). Throws
 * only when the supplier or the request itself is wrong (unknown supplier,
 * oversized file, unreadable stream).
 */
export async function importiereDatanorm(
  opts: ImportOptionen,
): Promise<ImportErgebnis> {
  const db = getDb()
  const { log } = opts

  // ---- Guard: supplier must exist ------------------------------------
  const lieferant = await db
    .select({ id: lieferanten.id, name: lieferanten.name })
    .from(lieferanten)
    .where(sql`${lieferanten.id} = ${opts.lieferantId}`)
    .limit(1)
  if (lieferant.length === 0) {
    throw new DatanormFehler('Lieferant unbekannt', 'DATANORM_LIEFERANT_UNBEKANNT')
  }

  // ---- Report row (created before parsing so failures are traceable) ---
  const importId = crypto.randomUUID()
  // The progress channel has to exist BEFORE the first tick: the SSE
  // endpoint only creates it when a browser subscribes, which happens
  // after the upload response (the import runs inline). Without this the
  // ticks were dropped and 'fertig' was lost — the client then waited
  // forever on a stream that never closed.
  kanalFuer(importId)
  const gestartet = new Date()
  await db.insert(datanormImporte).values({
    id: importId,
    lieferantId: opts.lieferantId,
    originalDateiname: opts.originalDateiname,
    status: 'gestartet',
    benutzerId: opts.benutzerId,
    gestartetAm: gestartet,
  })

  const auffaelligkeiten: string[] = []
  if (istPreisdatei(opts.originalDateiname)) {
    auffaelligkeiten.push(
      'Dies ist eine separate DATPREIS-Preisdatei. Sie wird noch nicht unterstützt — bitte die vollständige DATANORM-Datei hochladen.',
    )
  }

  // ---- Stream once: hash + store + collect ----------------------------
  const hash = createHash('sha256')
  const bytesSchonGelesen = { n: 0 }

  const zielDir = join(config.DATANORM_DIR, gestartet.toISOString().slice(0, 10))
  const dateiName = `${importId}_${sichererDateiname(opts.originalDateiname)}`
  await mkdir(zielDir, { recursive: true })
  const zielPfad = join(zielDir, dateiName)
  const relativPfad = join(
    gestartet.toISOString().slice(0, 10),
    dateiName,
  )

  // Tee: forward every chunk to the hash, the file on disk, and Pass 1.
  const tee = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesSchonGelesen.n += chunk.length
      if (bytesSchonGelesen.n > config.DATANORM_MAX_FILE_BYTES) {
        cb(new DatanormFehler('Datei zu groß', 'DATANORM_ZU_GROSS'))
        return
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })

  let sammel
  try {
    const dateiStream = createWriteStream(zielPfad)
    // pipeline() would consume the source; we need the chunks twice (once
    // for the file, once for the parser), so we pipe the tee into both.
    const sammelPromise = sammleDatanorm(tee, {
      encoding: opts.encoding,
      format: opts.format,
      onFortschritt: (n, hinweis) => {
        opts.onFortschritt?.({
          importId,
          phase: 'parse',
          verarbeitet: n,
          gesamt: 0,
          fehler: 0,
          hinweis,
        })
      },
    })
    await Promise.all([pipeline(opts.stream, tee, dateiStream), sammelPromise])
    sammel = await sammelPromise
  } catch (err) {
    // Parsing failed: keep the file (for inspection), mark the report failed.
    await db
      .update(datanormImporte)
      .set({
        status: 'fehler',
        beendetAm: new Date(),
        fehlerAnzahl: 1,
        fehlerDetails: [
          {
            satzart: '-',
            zeile: 0,
            code: err instanceof DatanormFehler ? err.code : 'DATANORM_UNBEKANNTER_FEHLER',
            meldung: err instanceof Error ? err.message : String(err),
          },
        ],
      })
      .where(sql`${datanormImporte.id} = ${importId}`)
    log.error({ err, importId }, '[datanorm] Import fehlgeschlagen')
    // The SSE stream must close even on failure, otherwise the admin
    // watches a progress bar that never ends.
    meldeFertig(importId, err instanceof Error ? err.message : String(err))
    throw err
  }

  const dateiHash = hash.digest('hex')
  const byteGroesse = bytesSchonGelesen.n

  // ---- Duplicate detection (after we know the hash) ------------------
  const duplikat = await findeDuplikat(opts.lieferantId, dateiHash)
  if (duplikat) {
    await db
      .update(datanormImporte)
      .set({
        status: 'erfolg',
        beendetAm: new Date(),
        dateiId: duplikat.dateiId,
        metadaten: { duplikat: true, auffaelligkeiten },
      })
      .where(sql`${datanormImporte.id} = ${importId}`)
    // Our copy of the file is redundant — remove it.
    await rm(zielPfad, { force: true }).catch(() => {})
    meldeFertig(importId)
    return {
      importId,
      status: 'duplikat',
      artikelAnzahl: 0,
      neu: 0,
      aktualisiert: 0,
      deaktiviert: 0,
      uebersprungen: 0,
      fehlerAnzahl: 0,
      fehlerDetails: [],
      encoding: sammel.encoding,
      version: sammel.version,
      vorhandenerImportId: duplikat.importId,
      auffaelligkeiten,
    }
  }

  // ---- Register the file ---------------------------------------------
  // The file may already be known from an import with an OLDER parser
  // version. Its rows were produced with the wrong field layout, so they
  // are worthless: the supplier's mirror is cleared and the file is
  // imported again from scratch. The file row is reused (the bytes are
  // identical) instead of inserting a second row for the same hash.
  const bekannteDatei = await findeDatei(opts.lieferantId, dateiHash)
  let dateiId: string
  if (bekannteDatei) {
    dateiId = bekannteDatei.id
    const geloescht = await db
      .delete(herstellerArtikel)
      .where(eq(herstellerArtikel.lieferantId, opts.lieferantId))
      .returning({ id: herstellerArtikel.id })
    log.info(
      {
        importId,
        lieferantId: opts.lieferantId,
        alteParserVersion: bekannteDatei.parserVersion,
        geloeschteArtikel: geloescht.length,
      },
      '[datanorm] Datei wurde mit einer älteren Parser-Version importiert — Katalog wird neu aufgebaut',
    )
    await db
      .update(datanormDateien)
      .set({
        pfad: relativPfad,
        encoding: sammel.encoding,
        versionErkannt: sammel.version,
        parserVersion: PARSER_VERSION,
        abgelegtAm: new Date(),
      })
      .where(sql`${datanormDateien.id} = ${dateiId}`)
  } else {
    dateiId = crypto.randomUUID()
    await db.insert(datanormDateien).values({
      id: dateiId,
      lieferantId: opts.lieferantId,
      pfad: relativPfad,
      originalName: opts.originalDateiname,
      byteGroesse: byteGroesse,
      dateiHash,
      encoding: sammel.encoding,
      versionErkannt: sammel.version,
      parserVersion: PARSER_VERSION,
      abgelegtAm: new Date(),
    })
  }

  // ---- Resolve + persist ---------------------------------------------
  const aufgeloest = loeseAuf(sammel, (v, g) => {
    opts.onFortschritt?.({
      importId,
      phase: 'persist',
      verarbeitet: v,
      gesamt: g,
      fehler: 0,
    })
  })

  const alleFehler: Parserfehler[] = [...sammel.fehler, ...aufgeloest.fehler]
  const persistErgebnis = await persistiereArtikel(aufgeloest.artikel, {
    lieferantId: opts.lieferantId,
    onFortschritt: (v, g) => {
      opts.onFortschritt?.({ importId, phase: 'persist', verarbeitet: v, gesamt: g, fehler: 0 })
    },
  })

  for (const f of persistErgebnis.fehler) {
    alleFehler.push({
      satzart: 'A',
      zeile: 0,
      code: 'DATANORM_SPEICHERN_FEHLGESCHLAGEN',
      meldung: `${f.matchcode}: ${f.meldung}`,
    })
  }

  // ---- Decide the report status ---------------------------------------
  const fehlerQuote = sammel.zeilenGesamt > 0 ? alleFehler.length / sammel.zeilenGesamt : 0
  const zuVieleFehler =
    alleFehler.length > config.DATANORM_MAX_FEHLER_ABSOLUT ||
    fehlerQuote * 100 > config.DATANORM_MAX_FEHLER_PROZENT
  const status = zuVieleFehler ? 'teilfehler' : 'erfolg'

  await db
    .update(datanormImporte)
    .set({
      status,
      dateiId,
      encoding: sammel.encoding,
      versionErkannt: sammel.version,
      artikelAnzahl: aufgeloest.artikel.length,
      artikelNeu: persistErgebnis.neu,
      artikelAktualisiert: persistErgebnis.aktualisiert,
      artikelDeaktiviert: persistErgebnis.deaktiviert,
      uebersprungen: persistErgebnis.uebersprungen,
      fehlerAnzahl: alleFehler.length,
      fehlerDetails: alleFehler.slice(0, FEHLER_DETAILS_LIMIT),
      metadaten: {
        vorsatz: sammel.vorsatz,
        auffaelligkeiten,
        fehlerQuote: Math.round(fehlerQuote * 10000) / 10000,
      },
      beendetAm: new Date(),
    })
    .where(sql`${datanormImporte.id} = ${importId}`)

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    aktion: 'datanorm.import.abschluss',
    entitaet: 'datanorm_import',
    entitaetId: importId,
    benutzerId: opts.benutzerId,
    daten: {
      lieferantId: opts.lieferantId,
      status,
      artikel: aufgeloest.artikel.length,
      neu: persistErgebnis.neu,
      aktualisiert: persistErgebnis.aktualisiert,
      fehler: alleFehler.length,
    },
    zeit: new Date(),
  })

  opts.onFortschritt?.({
    importId,
    phase: 'fertig',
    verarbeitet: aufgeloest.artikel.length,
    gesamt: aufgeloest.artikel.length,
    fehler: alleFehler.length,
  })

  meldeFertig(importId)

  log.info(
    {
      importId,
      lieferantId: opts.lieferantId,
      version: sammel.version,
      encoding: sammel.encoding,
      artikel: aufgeloest.artikel.length,
      status,
    },
    '[datanorm] Import abgeschlossen',
  )

  return {
    importId,
    status,
    artikelAnzahl: aufgeloest.artikel.length,
    neu: persistErgebnis.neu,
    aktualisiert: persistErgebnis.aktualisiert,
    deaktiviert: persistErgebnis.deaktiviert,
    uebersprungen: persistErgebnis.uebersprungen,
    fehlerAnzahl: alleFehler.length,
    fehlerDetails: alleFehler.slice(0, FEHLER_DETAILS_LIMIT),
    encoding: sammel.encoding,
    version: sammel.version,
    auffaelligkeiten,
  }
}