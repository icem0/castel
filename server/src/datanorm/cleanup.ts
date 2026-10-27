// Retention for uploaded DATANORM files.
//
// Policy (decided by the user):
//   * the NEWEST file per supplier is always kept — it is the catalogue the
//     admin works from and the one needed for a re-import
//   * older files are deleted after DATANORM_CLEANUP_TAGE (default 730 = 2 years)
//   * `datanorm_importe` (the import reports) is NEVER cleaned: that table is
//     the audit trail and stays small anyway
//
// Deleting a row from `datanorm_dateien` sets `datanorm_importe.datei_id` to
// NULL (ON DELETE SET NULL), so the report survives and simply loses the file
// pointer. That is intentional: "we imported this, the file is gone now" is a
// fact the admin should still be able to see.

import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { getDb } from '../db/client.js'
import { datanormDateien, lieferanten } from '../db/schema.js'
import { config } from '../config/config.js'

/** One file that the cleanup removed. */
export interface GeloeschterEintrag {
  id: string
  pfad: string
  lieferantId: string
  alterTage: number
}

export interface CleanupErgebnis {
  geprueft: number
  geloescht: number
  eintraege: GeloeschterEintrag[]
}

/**
 * Resolves a stored relative path inside DATANORM_DIR.
 *
 * Paths come from our own database, but a destructive delete must not be able
 * to escape the configured directory through a crafted `pfad` (e.g. after a
 * restore from an untrusted backup). Returns null when it escapes.
 */
function pfadImDatanormVerzeichnis(relPfad: string): string | null {
  const basis = resolve(config.DATANORM_DIR)
  const ziel = resolve(basis, relPfad)
  if (ziel === basis || !ziel.startsWith(basis + sep)) return null
  return ziel
}

/**
 * Removes one stored DATANORM file from disk. Used by the admin delete
 * actions; a missing file is not an error (the row is removed regardless).
 */
export async function loescheDateiVomDatentraeger(
  log: FastifyBaseLogger,
  relPfad: string,
): Promise<boolean> {
  const vollPfad = pfadImDatanormVerzeichnis(relPfad)
  if (vollPfad === null) {
    log.warn({ pfad: relPfad }, '[datanorm] Pfad liegt ausserhalb von DATANORM_DIR — uebersprungen')
    return false
  }
  try {
    const s = await stat(vollPfad)
    if (!s.isFile()) return false
    await rm(vollPfad, { force: true })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, pfad: vollPfad }, '[datanorm] Datei konnte nicht gelöscht werden')
    }
    return false
  }
}

/**
 * Deletes DATANORM files older than the retention window, keeping the newest
 * per supplier.
 *
 * Safe to call repeatedly. Only removes files whose DB row is gone
 * afterwards — a file on disk whose row still exists (e.g. the newest one) is
 * never touched.
 */
export async function raeumeAlteDateien(
  log: FastifyBaseLogger,
  tage = config.DATANORM_CLEANUP_TAGE,
): Promise<CleanupErgebnis> {
  const db = getDb()
  const ergebnis: CleanupErgebnis = { geprueft: 0, geloescht: 0, eintraege: [] }
  if (tage < 1) return ergebnis

  const grenze = new Date(Date.now() - tage * 24 * 60 * 60 * 1000)

  // The newest file per supplier, identified by abgelegt_am.
  const newest = await db.execute<{ lieferant_id: string; neueste: Date }>(sql`
    SELECT lieferant_id, MAX(abgelegt_am) AS neueste
    FROM datanorm_dateien
    GROUP BY lieferant_id
  `)

  const rows = await db
    .select({
      id: datanormDateien.id,
      pfad: datanormDateien.pfad,
      lieferantId: datanormDateien.lieferantId,
      abgelegtAm: datanormDateien.abgelegtAm,
    })
    .from(datanormDateien)
    .where(sql`${datanormDateien.abgelegtAm} < ${grenze}`)

  ergebnis.geprueft = rows.length
  if (rows.length === 0) return ergebnis

  const newestMap = new Map<string, Date>()
  for (const r of newest) newestMap.set(r.lieferant_id, new Date(r.neueste))

  for (const row of rows) {
    // Keep the newest file of this supplier regardless of age.
    const neueste = newestMap.get(row.lieferantId)
    if (neueste && row.abgelegtAm.getTime() >= neueste.getTime()) continue

    const alterTage = Math.floor((Date.now() - row.abgelegtAm.getTime()) / (24 * 60 * 60 * 1000))
    await loescheDateiVomDatentraeger(log, row.pfad)

    // ON DELETE SET NULL keeps the import report intact.
    await db.delete(datanormDateien).where(sql`${datanormDateien.id} = ${row.id}`)
    ergebnis.geloescht += 1
    ergebnis.eintraege.push({ id: row.id, pfad: row.pfad, lieferantId: row.lieferantId, alterTage })
  }

  if (ergebnis.geloescht > 0) {
    log.info(
      { geloescht: ergebnis.geloescht, tage },
      '[datanorm] Aufraeumen abgeschlossen (juengster Datei pro Lieferant bleibt erhalten)',
    )
    // Remove date directories that are now empty.
    await raeumeLeereVerzeichnisse(log)
  }

  return ergebnis
}

/** Removes date folders (YYYY-MM-DD) that no longer contain any file. */
export async function raeumeLeereVerzeichnisse(log: FastifyBaseLogger): Promise<void> {
  let verzeichnisse: string[]
  try {
    verzeichnisse = await readdir(config.DATANORM_DIR)
  } catch {
    return
  }
  for (const name of verzeichnisse) {
    // Only touch our date folders; anything else in DATANORM_DIR is not ours.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue
    const dir = join(config.DATANORM_DIR, name)
    try {
      const inhalt = await readdir(dir)
      if (inhalt.length === 0) await rm(dir, { recursive: true, force: true })
    } catch {
      // Races with a concurrent import are fine — the folder simply stays.
    }
  }
  log.debug({ verzeichnisse: verzeichnisse.length }, '[datanorm] Leere Tagesordner geprueft')
}

/** Count of suppliers, used by the admin overview. */
export async function lieferantenMitKatalog(): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ id: lieferanten.id })
    .from(lieferanten)
    .where(sql`EXISTS (SELECT 1 FROM hersteller_artikel WHERE hersteller_artikel.lieferant_id = lieferanten.id)`)
  return rows.length
}