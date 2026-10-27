// Photo service: shared logic for the PWA (JWT) and the agent API (API key).
//
// Storage: $FOTOS_DIR/<artikelId>/<random><ext>
// DB:      row in `fotos` (1:N to artikel, ON DELETE CASCADE)
// Audit:   row in `audit_log` (entitaet = 'foto')
//
// The routes must not implement any file logic on their own — otherwise the
// PWA upload and the API upload drift apart (limit, file name, DB row).

import { count, eq } from 'drizzle-orm'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client.js'
import { artikel, auditLog, fotos } from '../db/schema.js'
import { config } from '../config/config.js'

/** Allowed image formats — everything else is rejected. */
export const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

/** Error carrying an HTTP status — the routes reuse code and message. */
export class FotoFehler extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'FotoFehler'
  }
}

export interface FotoDto {
  id: string
  artikelId: string
  url: string
  contentType: string
  groesse: number
  erstelltAm: string
}

/** File extension for a MIME type — derived, never taken from the client file name. */
export function endungFuerMime(mime: string): string | null {
  return EXT_FOR_MIME[mime] ?? null
}

function randomFileName(ext: string): string {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return arr.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '') + ext
}

/**
 * Resolves a relative path (from `fotos.pfad`) and makes sure it stays
 * inside FOTOS_DIR. Guards against path traversal in case a DB row was
 * tampered with.
 */
export function absoluterFotoPfad(pfad: string): string | null {
  const root = resolve(config.FOTOS_DIR)
  const ziel = resolve(root, pfad)
  if (ziel !== root && !ziel.startsWith(root + sep)) return null
  return ziel
}

export async function artikelExistiert(artikelId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(eq(artikel.id, artikelId))
    .limit(1)
  return rows.length > 0
}

/**
 * Stores a product image: file on disk, row in `fotos`, audit entry.
 * Throws `FotoFehler` for an unsupported MIME type, an unknown article,
 * an oversized file or too many images per article.
 */
export async function speichereFoto(params: {
  artikelId: string
  contentType: string
  daten: Buffer
  erstelltVon: string
}): Promise<FotoDto> {
  const db = getDb()
  const { artikelId, contentType, daten, erstelltVon } = params

  const artikelRows = await db
    .select({ id: artikel.id })
    .from(artikel)
    .where(eq(artikel.id, artikelId))
    .limit(1)
  if (artikelRows.length === 0) {
    throw new FotoFehler(404, 'ARTIKEL_NOT_FOUND', `Artikel ${artikelId} nicht gefunden`)
  }

  if (!ALLOWED_MIME.has(contentType)) {
    throw new FotoFehler(415, 'UNSUPPORTED_MEDIA_TYPE', `erlaubt: ${[...ALLOWED_MIME].join(', ')}`)
  }

  if (daten.length > config.FOTOS_MAX_BYTES) {
    throw new FotoFehler(
      413,
      'PAYLOAD_TOO_LARGE',
      `maximal ${config.FOTOS_MAX_BYTES} Bytes pro Bild`,
    )
  }

  const cntRows = await db.select({ c: count() }).from(fotos).where(eq(fotos.artikelId, artikelId))
  const currentCount = Number(cntRows[0]?.c ?? 0)
  if (currentCount >= config.FOTOS_MAX_PER_ARTIKEL) {
    throw new FotoFehler(
      413,
      'TOO_MANY_FOTOS',
      `maximal ${config.FOTOS_MAX_PER_ARTIKEL} Bilder pro Artikel`,
    )
  }

  const ext = endungFuerMime(contentType)
  if (ext === null) {
    throw new FotoFehler(415, 'UNSUPPORTED_MEDIA_TYPE', `erlaubt: ${[...ALLOWED_MIME].join(', ')}`)
  }

  const fileName = randomFileName(ext)
  const artikelDir = join(config.FOTOS_DIR, artikelId)
  await mkdir(artikelDir, { recursive: true })
  await writeFile(join(artikelDir, fileName), daten)

  const id = randomUUID()
  const erstelltAm = new Date()
  await db.insert(fotos).values({
    id,
    artikelId,
    pfad: `${artikelId}/${fileName}`,
    contentType,
    groesse: daten.length,
    erstelltAm,
    erstelltVon,
  })
  await db.insert(auditLog).values({
    id: randomUUID(),
    aktion: 'create',
    entitaet: 'foto',
    entitaetId: id,
    benutzerId: erstelltVon,
    daten: { op: 'create', entity: 'foto', artikelId, contentType, groesse: daten.length },
    zeit: erstelltAm,
  })

  return {
    id,
    artikelId,
    url: `/fotos/${artikelId}/${fileName}`,
    contentType,
    groesse: daten.length,
    erstelltAm: erstelltAm.toISOString(),
  }
}

/** All images of an article, oldest first. */
export async function listeFotos(artikelId: string): Promise<FotoDto[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(fotos)
    .where(eq(fotos.artikelId, artikelId))
    .orderBy(fotos.erstelltAm)
  return rows.map((r) => ({
    id: r.id,
    artikelId: r.artikelId,
    url: `/fotos/${r.pfad}`,
    contentType: r.contentType,
    groesse: r.groesse,
    erstelltAm: r.erstelltAm.toISOString(),
  }))
}

/**
 * The first (oldest) image per article — thumbnail map for list views.
 *
 * The PWA loads this once when the article list mounts and shows one image
 * per row. One request instead of N — with 500 articles that have photos the
 * per-article variant (/api/fotos/list/:artikelId) would be a hundred
 * roundtrips.
 *
 * Implementation: all photo rows are read (the server-side index on
 * `fotos.artikel_id` exists — `fotos_artikel_idx`), grouped in JS and the
 * first (oldest) one per group is taken. With a few thousand photos that is
 * faster and more portable than DISTINCT ON — and the sort happens once
 * anyway, not per request.
 */
export async function erstesFotoProArtikel(): Promise<
  Array<{ artikelId: string; id: string; url: string }>
> {
  const db = getDb()
  const rows = await db
    .select({
      artikelId: fotos.artikelId,
      id: fotos.id,
      pfad: fotos.pfad,
      erstelltAm: fotos.erstelltAm,
    })
    .from(fotos)
    .orderBy(fotos.artikelId, fotos.erstelltAm)
  const firstByArtikel = new Map<string, { id: string; url: string }>()
  for (const r of rows) {
    if (firstByArtikel.has(r.artikelId)) continue
    firstByArtikel.set(r.artikelId, { id: r.id, url: `/fotos/${r.pfad}` })
  }
  const out: Array<{ artikelId: string; id: string; url: string }> = []
  for (const [artikelId, foto] of firstByArtikel) {
    out.push({ artikelId, ...foto })
  }
  return out
}

/**
 * Deletes an image: DB row, audit entry and the file on disk.
 * Returns false if no image with that ID existed.
 */
export async function loescheFoto(id: string, benutzerId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db.select().from(fotos).where(eq(fotos.id, id)).limit(1)
  const foto = rows[0]
  if (!foto) return false

  await db.delete(fotos).where(eq(fotos.id, id))
  await db.insert(auditLog).values({
    id: randomUUID(),
    aktion: 'delete',
    entitaet: 'foto',
    entitaetId: id,
    benutzerId,
    daten: { op: 'delete', entity: 'foto', artikelId: foto.artikelId },
    zeit: new Date(),
  })

  const pfad = absoluterFotoPfad(foto.pfad)
  if (pfad !== null) {
    // ENOENT is not an error — the file may be gone already.
    await rm(pfad, { force: true }).catch(() => undefined)
  }
  return true
}
