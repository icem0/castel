// Photo routes of the PWA (JWT): POST /api/fotos/upload/:artikelId,
// GET /api/fotos/list/:artikelId, GET /api/fotos/by-artikel,
// DELETE /api/fotos/:id (admin only) and the static delivery under /fotos/*.
//
// The storage logic lives in service.ts and is shared with the agent API
// (API key) — both paths behave identically.

import type { FastifyInstance, FastifyReply } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { resolve as resolvePath } from 'node:path'
import { config } from '../config/config.js'
import {
  FotoFehler,
  erstesFotoProArtikel,
  listeFotos,
  loescheFoto,
  speichereFoto,
} from './service.js'

function fotoFehlerAntwort(reply: FastifyReply, err: FotoFehler): FastifyReply {
  return reply.code(err.status).send({ code: err.code, message: err.message })
}

export async function fotoRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.FOTOS_MAX_BYTES,
      files: 1,
    },
  })

  // ---------- POST /api/fotos/upload/:artikelId ----------
  app.post<{ Params: { artikelId: string } }>(
    '/api/fotos/upload/:artikelId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const file = await req.file()
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'kein Bild hochgeladen' })
      }

      const chunks: Buffer[] = []
      for await (const chunk of file.file) chunks.push(chunk as Buffer)
      const daten = Buffer.concat(chunks)

      // On limit overflow the stream is cut off — a silently truncated
      // image would be broken. Reject it instead.
      if (file.file.truncated) {
        return reply.code(413).send({
          code: 'PAYLOAD_TOO_LARGE',
          message: `Bild zu groß (maximal ${config.FOTOS_MAX_BYTES} Bytes)`,
        })
      }

      try {
        const foto = await speichereFoto({
          artikelId: req.params.artikelId,
          contentType: file.mimetype,
          daten,
          erstelltVon: req.authUser?.sub ?? 'unknown',
        })
        return reply.send({
          id: foto.id,
          url: foto.url,
          contentType: foto.contentType,
          groesse: foto.groesse,
        })
      } catch (err) {
        if (err instanceof FotoFehler) return fotoFehlerAntwort(reply, err)
        throw err
      }
    },
  )

  // ---------- DELETE /api/fotos/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/fotos/:id',
    { preHandler: app.requireAdmin }, // nur Admin
    async (req, reply) => {
      const geloescht = await loescheFoto(req.params.id, req.authUser?.sub ?? 'unknown')
      if (!geloescht) return reply.code(404).send({ code: 'NOT_FOUND' })
      return reply.code(204).send()
    },
  )

  // ---------- GET /api/fotos/list/:artikelId ----------
  app.get<{ Params: { artikelId: string } }>(
    '/api/fotos/list/:artikelId',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const liste = await listeFotos(req.params.artikelId)
      return reply.send(
        liste.map((f) => ({
          id: f.id,
          url: f.url,
          contentType: f.contentType,
          groesse: f.groesse,
          erstelltAm: f.erstelltAm,
        })),
      )
    },
  )

  // ---------- GET /api/fotos/by-artikel ----------
  // Liefert für JEDEN Artikel mit mindestens einem Foto genau das erste
  // (älteste) Foto als Thumbnail-URL. Die PWA lädt das einmal beim Mount
  // der Artikel-Liste und zeigt pro Zeile das Bild an. Ein Request statt
  // N — bei 500 Artikeln mit Fotos wäre die per-Artikel-Variante
  // (/api/fotos/list/:artikelId) sonst einhunderte Roundtrips.
  app.get('/api/fotos/by-artikel', { preHandler: app.requireAuth }, async (_req, reply) => {
    return reply.send(await erstesFotoProArtikel())
  })

  // Vor jedem Listing: 404 (keine Directory-Listings)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/fotos/') && req.url.endsWith('/')) {
      return reply.code(404).send({ code: 'NOT_FOUND' })
    }
  })
}

/**
 * Statische Auslieferung der hochgeladenen Bilder unter `/fotos/*` — ohne
 * Auth. Muss in `index.ts` VOR dem `requireAuth`-preHandler-Block
 * registriert werden, weil <img>-Tags keinen Authorization-Header
 * mitschicken. Path-Traversal ist über `resolvePath(config.FOTOS_DIR)`
 * als root ausgeschlossen.
 */
export async function fotoStaticRoutes(app: FastifyInstance): Promise<void> {
  const root = resolvePath(config.FOTOS_DIR)
  await app.register(fastifyStatic, {
    root,
    prefix: '/fotos/',
    decorateReply: false,
    constraints: {},
    // Serve ohne Index für Verzeichnisse
    index: [],
  })
}
