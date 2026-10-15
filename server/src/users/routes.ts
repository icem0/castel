// User-Verwaltung (nur admin).

import type { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { users } from '../db/schema.js'
import { createUserSchema, patchUserSchema } from '../domain/validierung.js'
import { NotFoundError, ValidationError } from '../domain/errors.js'

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
          aktiv: users.aktiv,
          erstelltAm: users.erstelltAm,
          letzterLoginAm: users.letzterLoginAm,
        })
        .from(users)
      return reply.send(rows)
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
      const { email, password, rolle } = parsed.data
      const db = getDb()
      const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
      if (existing.length > 0) {
        return reply.code(409).send({ code: 'EMAIL_TAKEN', message: 'E-Mail bereits vergeben' })
      }
      const id = crypto.randomUUID()
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id })
      await db.insert(users).values({
        id,
        email: email.toLowerCase(),
        passwordHash,
        rolle,
        aktiv: true,
        erstelltAm: new Date(),
        letzterLoginAm: null,
        mustChangePassword: true,
        anzeigename: '',
      })
      return reply.code(201).send({ id, email: email.toLowerCase(), rolle, aktiv: true })
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
      if (parsed.data.rolle !== undefined) patch.rolle = parsed.data.rolle
      if (parsed.data.aktiv !== undefined) patch.aktiv = parsed.data.aktiv
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

  // ---------- DELETE /api/users/:id (Soft-Delete via aktiv=false) ----------
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
        return reply.code(400).send({ code: 'SELF_DELETE', message: 'Eigenen User nicht deaktivierbar' })
      }
      await db.update(users).set({ aktiv: false }).where(eq(users.id, req.params.id))
      return reply.code(204).send()
    },
  )
}