// Photo routes of the agent API v1.
//
// Auth: API key with scope write (upload), read (list) and admin (delete).
// The multipart parser is registered in the calling scope (index.ts) so
// that the file limits only apply to these routes and not to the rest of
// the API.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentenRateLimit } from '../../auth/rate-limit.js'
import {
  FotoFehler,
  artikelExistiert,
  listeFotos,
  loescheFoto,
  speichereFoto,
} from '../../fotos/service.js'
import { config } from '../../config/config.js'
import { ApiV1Error } from './service.js'

function fehler(reply: FastifyReply, err: unknown, req: FastifyRequest): FastifyReply {
  if (err instanceof ApiV1Error) {
    return reply.code(err.status).send({
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    })
  }
  if (err instanceof FotoFehler) {
    return reply.code(err.status).send({ code: err.code, message: err.message })
  }
  req.log.error({ err }, 'api_v1_foto_internal_error')
  return reply.code(500).send({
    code: 'INTERNAL',
    message: 'Interner Server-Fehler',
  })
}

/** Translates multipart errors into API errors with a clean status. */
function multipartFehler(err: unknown): ApiV1Error {
  const code = (err as { code?: string }).code
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return new ApiV1Error(413, 'PAYLOAD_TOO_LARGE', 'Datei zu groß')
  }
  return new ApiV1Error(
    400,
    'VALIDATION',
    'multipart/form-data mit genau einem Bildfeld (z. B. "foto") erwartet',
  )
}

/** Reads the first image from the multipart body. */
async function liesBild(req: FastifyRequest): Promise<{ contentType: string; daten: Buffer }> {
  let file
  try {
    file = await req.file()
  } catch (err) {
    throw multipartFehler(err)
  }
  if (!file) {
    throw new ApiV1Error(400, 'NO_FILE', 'kein Bild hochgeladen')
  }
  const chunks: Buffer[] = []
  try {
    for await (const chunk of file.file) chunks.push(chunk as Buffer)
  } catch (err) {
    throw multipartFehler(err)
  }
  // On limit overflow the stream is cut off — a silently truncated
  // image would be broken. Reject it instead.
  if (file.file.truncated) {
    throw new ApiV1Error(
      413,
      'PAYLOAD_TOO_LARGE',
      `Bild zu groß (maximal ${config.FOTOS_MAX_BYTES} Bytes)`,
    )
  }
  return { contentType: file.mimetype, daten: Buffer.concat(chunks) }
}

export async function apiV1FotoRoutes(app: FastifyInstance): Promise<void> {
  const limit = agentenRateLimit(app)

  const read = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('read')] }
  const write = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('write')] }
  const admin = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('admin')] }

  // ---------- GET /api/v1/artikel/:id/fotos ----------
  app.get<{ Params: { id: string } }>('/api/v1/artikel/:id/fotos', read, async (req, reply) => {
    try {
      if (!(await artikelExistiert(req.params.id))) {
        throw new ApiV1Error(404, 'NOT_FOUND', `Artikel ${req.params.id} nicht gefunden`)
      }
      return reply.send({ items: await listeFotos(req.params.id) })
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- POST /api/v1/artikel/:id/fotos ----------
  app.post<{ Params: { id: string } }>('/api/v1/artikel/:id/fotos', write, async (req, reply) => {
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      const bild = await liesBild(req)
      const foto = await speichereFoto({
        artikelId: req.params.id,
        contentType: bild.contentType,
        daten: bild.daten,
        erstelltVon: auth.userId,
      })
      return reply.code(201).send(foto)
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- DELETE /api/v1/fotos/:id ----------
  app.delete<{ Params: { id: string } }>('/api/v1/fotos/:id', admin, async (req, reply) => {
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      const geloescht = await loescheFoto(req.params.id, auth.userId)
      if (!geloescht) {
        throw new ApiV1Error(404, 'NOT_FOUND', `Foto ${req.params.id} nicht gefunden`)
      }
      return reply.code(204).send()
    } catch (err) {
      return fehler(reply, err, req)
    }
  })
}
