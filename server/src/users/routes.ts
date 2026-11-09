// User-Verwaltung (nur admin).

import type { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { users } from '../db/schema.js'
import { createUserSchema, patchUserSchema } from '../domain/validierung.js'
import { NotFoundError, ValidationError } from '../domain/errors.js'
import { legacyRolle, normalisiereRollen, type Rolle } from '../domain/rollen.js'

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // ---------- GET /api/users ----------
  app.get(
    '/api/users',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const db = getDb()
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          anzeigename: users.anzeigename,
          rolle: users.rolle,
          rollen: users.rollen,
          aktiv: users.aktiv,
          erstelltAm: users.erstelltAm,
          letzterLoginAm: users.letzterLoginAm,
        })
        .from(users)
      return reply.send(
        rows.map((r) => ({
          ...r,
          rollen: normalisiereRollen(r.rollen),
        })),
      )
    },
  )

  // ---------- POST /api/users ----------
  app.post(
    '/api/users',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = createUserSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { email, password } = parsed.data
      // `rollen` (Stack) hat Vorrang vor dem Legacy-Feld `rolle`.
      const rollen: Rolle[] = normalisiereRollen(parsed.data.rollen ?? parsed.data.rolle)
      const normalizedEmail = email.toLowerCase()
      const anzeigename =
        parsed.data.anzeigename?.trim() || normalizedEmail.split('@')[0] || normalizedEmail
      const db = getDb()
      const existing = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1)
      if (existing.length > 0) {
        return reply.code(409).send({ code: 'EMAIL_TAKEN', message: 'E-Mail bereits vergeben' })
      }
      const id = crypto.randomUUID()
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
      await db.insert(users).values({
        id,
        email: normalizedEmail,
        passwordHash,
        rolle: legacyRolle(rollen),
        rollen,
        aktiv: true,
        erstelltAm: new Date(),
        letzterLoginAm: null,
        mustChangePassword: true,
        anzeigename,
      })
      return reply.code(201).send({
        id,
        email: normalizedEmail,
        anzeigename,
        rolle: legacyRolle(rollen),
        rollen,
        aktiv: true,
      })
    },
  )

  // ---------- PATCH /api/users/:id ----------
  app.patch<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = patchUserSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const db = getDb()
      const rows = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
      const user = rows[0]
      if (!user) throw new NotFoundError('User', req.params.id)

      const patch: Partial<typeof users.$inferInsert> = {}
      const rollenInput = parsed.data.rollen ?? parsed.data.rolle
      if (rollenInput !== undefined) {
        const rollen = normalisiereRollen(rollenInput)
        patch.rolle = legacyRolle(rollen)
        patch.rollen = rollen
      }
      if (parsed.data.aktiv !== undefined) patch.aktiv = parsed.data.aktiv
      // Self-deactivation is blocked: the admin would lock themselves out
      // (the next request fails with 401 USER_INACTIVE) — the same reasoning
      // as the blocked self-delete below (SEC-021).
      if (parsed.data.aktiv === false && req.authUser?.sub === req.params.id) {
        return reply.code(400).send({
          code: 'SELF_DEACTIVATE',
          message: 'Eigenen User nicht deaktivierbar',
        })
      }
      if (parsed.data.anzeigename !== undefined) patch.anzeigename = parsed.data.anzeigename
      if (parsed.data.password !== undefined) {
        patch.passwordHash = await argon2.hash(parsed.data.password, { type: argon2.argon2id })
        patch.mustChangePassword = true
      }
      if (Object.keys(patch).length === 0) {
        throw new ValidationError('body', 'keine Änderungen angegeben')
      }
      await db.update(users).set(patch).where(eq(users.id, req.params.id))
      return reply.code(204).send()
    },
  )

  // ---------- DELETE /api/users/:id (Hard-Delete) ----------
  app.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()
      const rows = await db.select().from(users).where(eq(users.id, req.params.id)).limit(1)
      const user = rows[0]
      if (!user) throw new NotFoundError('User', req.params.id)
      // Self-Delete verhindern
      if (req.authUser?.sub === req.params.id) {
        return reply.code(400).send({ code: 'SELF_DELETE', message: 'Eigenen User nicht löschbar' })
      }
      // Den letzten aktiven Admin nicht löschen
      if (normalisiereRollen(user.rollen).includes('admin') && user.aktiv) {
        const aktive = await db
          .select({ id: users.id, rollen: users.rollen })
          .from(users)
          .where(eq(users.aktiv, true))
        const anzahlAdmins = aktive.filter((u) => normalisiereRollen(u.rollen).includes('admin'))
          .length
        if (anzahlAdmins <= 1) {
          return reply
            .code(400)
            .send({ code: 'LAST_ADMIN', message: 'Letzter aktiver Admin nicht löschbar' })
        }
      }
      // FK-Kaskaden: refresh_tokens, api_keys, einstellungen
      // datanorm_importe.benutzer_id -> SET NULL, audit/buchungen behalten die ID
      await db.delete(users).where(eq(users.id, req.params.id))
      return reply.code(204).send()
    },
  )
}
