// Foto-Routes: POST /api/fotos/upload (multipart) und statische Auslieferung
// unter /fotos/*.

import type { FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { eq, and, count } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, extname, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db/client.js'
import { fotos, artikel } from '../db/schema.js'
import { config } from '../config/config.js'

// Sichere Dateinamen-Endungen (Whitelist)
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

function randomId(): string {
  // kanonische UUID v4
  return randomUUID()
}

function randomFileName(ext: string): string {
  // 16 Bytes random base64url
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return arr.reduce((s, b) => s + b.toString(16).padStart(2, '0'), '') + ext
}

export async function fotoRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.FOTOS_MAX_BYTES,
      files: 1,
    },
  })

  // ---------- POST /api/fotos/upload ----------
  app.post<{ Params: { artikelId: string } }>(
    '/api/fotos/upload/:artikelId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const db = getDb()

      // Existiert Artikel?
      const a = await db
        .select({ id: artikel.id })
        .from(artikel)
        .where(eq(artikel.id, req.params.artikelId))
        .limit(1)
      if (a.length === 0) {
        return reply.code(404).send({ code: 'ARTIKEL_NOT_FOUND', message: 'Artikel unbekannt' })
      }

      // Max-Anzahl pro Artikel?
      const cntRows = await db
        .select({ c: count() })
        .from(fotos)
        .where(and(eq(fotos.artikelId, req.params.artikelId)))
      const currentCount = cntRows[0]?.c ?? 0
      if (Number(currentCount) >= config.FOTOS_MAX_PER_ARTIKEL) {
        return reply.code(413).send({
          code: 'TOO_MANY_FOTOS',
          message: `maximal ${config.FOTOS_MAX_PER_ARTIKEL} Bilder pro Artikel`,
        })
      }

      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'kein Bild hochgeladen' })
      }
      if (!ALLOWED_MIME.has(file.mimetype)) {
        return reply.code(415).send({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `erlaubt: ${[...ALLOWED_MIME].join(', ')}`,
        })
      }

      const ext = EXT_FOR_MIME[file.mimetype] ?? extname(file.filename ?? '')
      const fileName = randomFileName(ext)
      const artikelDir = join(config.FOTOS_DIR, req.params.artikelId)
      await mkdir(artikelDir, { recursive: true })
      const fullPath = join(artikelDir, fileName)

      // Stream in Buffer schreiben (Datei ist klein, maxSize begrenzt)
      const chunks: Buffer[] = []
      for await (const chunk of file.file) chunks.push(chunk as Buffer)
      const buffer = Buffer.concat(chunks)
      await writeFile(fullPath, buffer)

      const id = randomId()
      await db.insert(fotos).values({
        id,
        artikelId: req.params.artikelId,
        pfad: `${req.params.artikelId}/${fileName}`,
        contentType: file.mimetype,
        groesse: buffer.length,
        erstelltAm: new Date(),
        erstelltVon: req.authUser?.sub ?? 'unknown',
      })

      return reply.send({
        id,
        url: `/fotos/${req.params.artikelId}/${fileName}`,
        contentType: file.mimetype,
        groesse: buffer.length,
      })
    },
  )

  // ---------- DELETE /api/fotos/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/fotos/:id',
    { preHandler: app.requireAdmin }, // nur Admin
    async (req, reply) => {
      const db = getDb()
      const rows = await db.select().from(fotos).where(eq(fotos.id, req.params.id)).limit(1)
      const foto = rows[0]
      if (!foto) return reply.code(404).send({ code: 'NOT_FOUND' })
      await db.delete(fotos).where(eq(fotos.id, req.params.id))
      // Datei auf der Platte löschen wäre nice-to-have (race-condition mit Upload),
      // lassen wir erstmal weg — Garbage-Collection per Cron später.
      return reply.code(204).send()
    },
  )

  // ---------- GET /api/fotos/list/:artikelId ----------
  app.get<{ Params: { artikelId: string } }>(
    '/api/fotos/list/:artikelId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const db = getDb()
      const rows = await db
        .select()
        .from(fotos)
        .where(eq(fotos.artikelId, req.params.artikelId))
        .orderBy(fotos.erstelltAm)
      return reply.send(
        rows.map((r) => ({
          id: r.id,
          url: `/fotos/${r.pfad}`,
          contentType: r.contentType,
          groesse: r.groesse,
          erstelltAm: r.erstelltAm,
        })),
      )
    },
  )

  // ---------- Statische Auslieferung ----------
  // Wir liefern /fotos/* aus FOTOS_DIR. Sicherheitscheck: Pfad darf nicht
  // nach oben wandern (Path-Traversal).
  const root = resolvePath(config.FOTOS_DIR)
  await app.register(fastifyStatic, {
    root,
    prefix: '/fotos/',
    decorateReply: false,
    constraints: {},
    // Serve ohne Index für Verzeichnisse
    index: [],
  })

  // Vor jedem Listing: 404 (keine Directory-Listings)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/fotos/') && req.url.endsWith('/')) {
      return reply.code(404).send({ code: 'NOT_FOUND' })
    }
  })
}