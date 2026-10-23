// HTTP-Routen der Agenten-API v1.
//
// Auth: API-Key (Bearer oder X-API-Key), Scope je Route. Die bestehenden
// PWA-/Sync-Routen bleiben JWT-only. Alle schreibenden Operationen laufen
// ueber den gemeinsamen Service-Layer (siehe service.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentenRateLimit } from '../../auth/rate-limit.js'
import { ApiV1Error } from './service.js'
import {
  artikelCreateSchema,
  artikelPatchSchema,
  artikelQuerySchema,
  auditQuerySchema,
  bestandQuerySchema,
  buchungCreateSchema,
  buchungQuerySchema,
  idParamsSchema,
  kommissionBodySchema,
  mindestbestandQuerySchema,
  standortCreateSchema,
  standortPatchSchema,
  stornoBodySchema,
} from './schemas.js'
import {
  createArtikel,
  createStandort,
  deleteArtikel,
  erstelleBuchung,
  getApiMeta,
  getArtikel,
  getBestand,
  getStatus,
  kommissioniereBuchung,
  listeArtikel,
  listeAudit,
  listeBuchungen,
  listeKommissionen,
  listeMindestbestand,
  listeStandorte,
  storniereBuchung,
  updateArtikel,
  updateStandort,
} from './service.js'
import type { NotificationGateway } from '../../services/notification-gateway.js'

function fehler(reply: FastifyReply, err: unknown, req: FastifyRequest): FastifyReply {
  if (err instanceof ApiV1Error) {
    return reply.code(err.status).send({
      code: err.code,
      message: err.message,
      ...(err.details === undefined ? {} : { details: err.details }),
    })
  }
  req.log.error({ err }, 'api_v1_internal_error')
  return reply.code(500).send({
    code: 'INTERNAL',
    message: 'Interner Server-Fehler',
  })
}

function validierungsFehler(reply: FastifyReply, issues: unknown): FastifyReply {
  return reply.code(400).send({
    code: 'VALIDATION',
    message: 'Ungültige Anfrage',
    details: issues,
  })
}

export async function apiV1Routes(
  app: FastifyInstance,
  gateway: NotificationGateway,
): Promise<void> {
  const limit = agentenRateLimit(app)

  const readOnly = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('read')] }
  const write = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('write')] }
  const admin = { preHandler: [app.requireApiAuth, limit, app.requireApiScope('admin')] }

  // ---------- Meta (public) ----------
  app.get('/api/v1/meta', async (_req, reply) => {
    try {
      return reply.send(await getApiMeta())
    } catch (err) {
      return fehler(reply, err, _req)
    }
  })

  // ---------- Status ----------
  app.get('/api/v1/status', readOnly, async (req, reply) => {
    try {
      return reply.send(await getStatus())
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Artikel ----------
  app.get('/api/v1/artikel', readOnly, async (req, reply) => {
    const parsed = artikelQuerySchema.safeParse(req.query)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    try {
      return reply.send(await listeArtikel(parsed.data))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.post('/api/v1/artikel', write, async (req, reply) => {
    const parsed = artikelCreateSchema.safeParse(req.body)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      return reply.code(201).send(await createArtikel(parsed.data, auth))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.get<{ Params: { id: string } }>('/api/v1/artikel/:id', readOnly, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params)
    if (!params.success) return validierungsFehler(reply, params.error.issues)
    try {
      return reply.send(await getArtikel(params.data.id))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.patch<{ Params: { id: string } }>('/api/v1/artikel/:id', write, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params)
    const body = artikelPatchSchema.safeParse(req.body)
    if (!params.success) return validierungsFehler(reply, params.error.issues)
    if (!body.success) return validierungsFehler(reply, body.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      return reply.send(await updateArtikel(params.data.id, body.data, auth))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/artikel/:id', admin, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params)
    if (!params.success) return validierungsFehler(reply, params.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      await deleteArtikel(params.data.id, auth)
      return reply.code(204).send()
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Standorte ----------
  app.get('/api/v1/standorte', readOnly, async (req, reply) => {
    const includeArchived = (req.query as { alle?: string } | undefined)?.alle === 'true'
    try {
      return reply.send({ items: await listeStandorte(includeArchived) })
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.post('/api/v1/standorte', write, async (req, reply) => {
    const parsed = standortCreateSchema.safeParse(req.body)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      return reply.code(201).send(await createStandort(parsed.data, auth))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.patch<{ Params: { id: string } }>('/api/v1/standorte/:id', write, async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params)
    const body = standortPatchSchema.safeParse(req.body)
    if (!params.success) return validierungsFehler(reply, params.error.issues)
    if (!body.success) return validierungsFehler(reply, body.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      return reply.send(await updateStandort(params.data.id, body.data, auth))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Bestand ----------
  app.get('/api/v1/bestand', readOnly, async (req, reply) => {
    const parsed = bestandQuerySchema.safeParse(req.query)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    try {
      return reply.send(await getBestand(parsed.data.artikelId, parsed.data.standortId))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Buchungen ----------
  app.get('/api/v1/buchungen', readOnly, async (req, reply) => {
    const parsed = buchungQuerySchema.safeParse(req.query)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    try {
      return reply.send(await listeBuchungen(parsed.data))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.post('/api/v1/buchungen', write, async (req, reply) => {
    const parsed = buchungCreateSchema.safeParse(req.body)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    const auth = req.apiAuth
    if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    try {
      return reply.code(201).send(await erstelleBuchung(parsed.data, auth, gateway))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  app.post<{ Params: { id: string } }>(
    '/api/v1/buchungen/:id/storno',
    write,
    async (req, reply) => {
      const params = idParamsSchema.safeParse(req.params)
      const body = stornoBodySchema.safeParse(req.body ?? {})
      if (!params.success) return validierungsFehler(reply, params.error.issues)
      if (!body.success) return validierungsFehler(reply, body.error.issues)
      const auth = req.apiAuth
      if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
      try {
        return reply.send(
          await storniereBuchung(params.data.id, body.data.grund, auth, gateway),
        )
      } catch (err) {
        return fehler(reply, err, req)
      }
    },
  )

  app.post<{ Params: { id: string } }>(
    '/api/v1/buchungen/:id/kommission',
    write,
    async (req, reply) => {
      const params = idParamsSchema.safeParse(req.params)
      const body = kommissionBodySchema.safeParse(req.body)
      if (!params.success) return validierungsFehler(reply, params.error.issues)
      if (!body.success) return validierungsFehler(reply, body.error.issues)
      const auth = req.apiAuth
      if (!auth) return reply.code(401).send({ code: 'UNAUTHORIZED' })
      try {
        return reply.code(201).send(
          await kommissioniereBuchung(
            params.data.id,
            body.data.projekt,
            body.data.kommentar ?? null,
            auth,
            gateway,
          ),
        )
      } catch (err) {
        return fehler(reply, err, req)
      }
    },
  )

  // ---------- Kommissionen ----------
  app.get('/api/v1/kommissionen', readOnly, async (req, reply) => {
    try {
      return reply.send({ items: await listeKommissionen() })
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Mindestbestand ----------
  app.get('/api/v1/mindestbestand', readOnly, async (req, reply) => {
    const parsed = mindestbestandQuerySchema.safeParse(req.query)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    try {
      return reply.send(await listeMindestbestand(parsed.data))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })

  // ---------- Audit ----------
  app.get('/api/v1/audit', admin, async (req, reply) => {
    const parsed = auditQuerySchema.safeParse(req.query)
    if (!parsed.success) return validierungsFehler(reply, parsed.error.issues)
    try {
      return reply.send(await listeAudit(parsed.data))
    } catch (err) {
      return fehler(reply, err, req)
    }
  })
}
