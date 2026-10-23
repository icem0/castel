// Verwaltung von API-Keys (JWT-only, NICHT per API-Key erreichbar).
//
//   GET    /api/keys          -> eigene Keys
//   POST   /api/keys          -> eigenen Key anlegen (Klartext einmalig)
//   DELETE /api/keys/:id      -> eigenen Key widerrufen
//   GET    /api/admin/keys    -> alle Keys (Admin)
//   DELETE /api/admin/keys/:id -> beliebigen Key widerrufen (Admin)
//
// Ein Key kann keine weiteren Keys anlegen: die Routen haengen am
// bestehenden JWT-preHandler. Damit ist eine Eskalation ueber einen
// kompromittierten Agenten-Key ausgeschlossen.

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { apiKeys, users } from '../db/schema.js'
import { config } from '../config/config.js'
import {
  generateApiKey,
  normalisiereScopes,
  type ApiKeyScope,
} from './api-keys.js'
import { NotFoundError } from '../domain/errors.js'

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'muss ISO-8601-Datum sein',
})

const createKeySchema = z.object({
  name: z.string().trim().min(1, 'Name ist erforderlich').max(100),
  scopes: z.array(z.string()).default(['read']),
  ablaufAm: iso.nullable().optional(),
})

const KEY_COLUMNS = {
  id: apiKeys.id,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  erstelltAm: apiKeys.erstelltAm,
  letzteNutzungAm: apiKeys.letzteNutzungAm,
  ablaufAm: apiKeys.ablaufAm,
  revokedAt: apiKeys.revokedAt,
}

function dto(row: {
  id: string
  name: string
  prefix: string
  scopes: string[] | null
  erstelltAm: Date
  letzteNutzungAm: Date | null
  ablaufAm: Date | null
  revokedAt: Date | null
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes ?? [],
    erstelltAm: row.erstelltAm.toISOString(),
    letzteNutzungAm: row.letzteNutzungAm?.toISOString() ?? null,
    ablaufAm: row.ablaufAm?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }
}

export async function apiKeyRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/keys ----------
  app.get('/api/keys', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!config.API_KEYS_ENABLED) {
      return reply.code(404).send({ code: 'API_DISABLED', message: 'Agenten-API ist deaktiviert' })
    }
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    const db = getDb()
    const rows = await db
      .select(KEY_COLUMNS)
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.sub))
      .orderBy(desc(apiKeys.erstelltAm))
    return reply.send({ keys: rows.map(dto) })
  })

  // ---------- POST /api/keys ----------
  app.post('/api/keys', { preHandler: app.requireAuth }, async (req, reply) => {
    if (!config.API_KEYS_ENABLED) {
      return reply.code(404).send({ code: 'API_DISABLED', message: 'Agenten-API ist deaktiviert' })
    }
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })

    const parsed = createKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
    }
    const scopes = normalisiereScopes(parsed.data.scopes)
    if (!scopes || scopes.length === 0) {
      return reply.code(400).send({
        code: 'VALIDATION',
        message: 'Mindestens ein gültiger Scope (read, write, admin) ist erforderlich',
      })
    }
    if (scopes.includes('admin') && user.rolle !== 'admin') {
      return reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'Der admin-Scope ist nur für Admin-User erlaubt',
      })
    }

    const db = getDb()
    const [countRow] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, user.sub), isNull(apiKeys.revokedAt)))
    if ((countRow?.c ?? 0) >= config.API_KEY_MAX_PER_USER) {
      return reply.code(409).send({
        code: 'KEY_LIMIT',
        message: `Maximal ${config.API_KEY_MAX_PER_USER} aktive Keys pro User`,
      })
    }

    const generated = generateApiKey()
    const id = crypto.randomUUID()
    const ablaufAm = parsed.data.ablaufAm ? new Date(parsed.data.ablaufAm) : null
    if (ablaufAm !== null && ablaufAm.getTime() <= Date.now()) {
      return reply.code(400).send({
        code: 'VALIDATION',
        message: 'ablaufAm muss in der Zukunft liegen',
      })
    }

    const [row] = await db
      .insert(apiKeys)
      .values({
        id,
        userId: user.sub,
        name: parsed.data.name,
        keyHash: generated.hash,
        prefix: generated.prefix,
        scopes: scopes as ApiKeyScope[],
        erstelltAm: new Date(),
        ablaufAm,
      })
      .returning(KEY_COLUMNS)

    return reply.code(201).send({
      key: generated.plaintext,
      ...dto(row!),
    })
  })

  // ---------- DELETE /api/keys/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/keys/:id',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const user = req.authUser
      if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
      const db = getDb()
      const rows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, user.sub)))
        .limit(1)
      if (rows.length === 0) throw new NotFoundError('API-Key', req.params.id)
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, req.params.id))
      return reply.code(204).send()
    },
  )

  // ---------- GET /api/admin/keys ----------
  app.get('/api/admin/keys', { preHandler: app.requireAdmin }, async (_req, reply) => {
    if (!config.API_KEYS_ENABLED) {
      return reply.code(404).send({ code: 'API_DISABLED', message: 'Agenten-API ist deaktiviert' })
    }
    const db = getDb()
    const rows = await db
      .select({
        ...KEY_COLUMNS,
        userId: apiKeys.userId,
        userEmail: users.email,
        userAnzeigename: users.anzeigename,
      })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .orderBy(desc(apiKeys.erstelltAm))
    return reply.send({
      keys: rows.map((row) => ({
        ...dto(row),
        userId: row.userId,
        userEmail: row.userEmail,
        userAnzeigename: row.userAnzeigename,
      })),
    })
  })

  // ---------- DELETE /api/admin/keys/:id ----------
  app.delete<{ Params: { id: string } }>(
    '/api/admin/keys/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()
      const rows = await db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.id, req.params.id))
        .limit(1)
      if (rows.length === 0) throw new NotFoundError('API-Key', req.params.id)
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, req.params.id))
      return reply.code(204).send()
    },
  )
}
