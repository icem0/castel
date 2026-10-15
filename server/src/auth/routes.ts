// Auth-Routes: /login, /refresh, /logout, /me.

import type { FastifyInstance } from 'fastify'
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { users } from '../db/schema.js'
import { loginSchema } from '../domain/validierung.js'
import {
  generateRefreshToken,
  hashRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_TTL_MS,
  type JwtPayload,
} from './jwt.js'
import { refreshTokens } from '../db/schema.js'
import { ladeAktivenUserByEmail } from './middleware.js'
import { loginRateLimit } from './rate-limit.js'

interface RefreshTokenRow {
  id: string
  user_id: string
  token_hash: string
  ablauf_am: Date
  revoked_at: Date | null
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Login-Rate-Limit Prehandler (siehe rate-limit.ts)
  const loginLimiter = loginRateLimit(app)

  // ---------- POST /api/auth/login ----------
  app.post(
    '/api/auth/login',
    { preHandler: loginLimiter },
    async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION',
        issues: parsed.error.issues,
      })
    }
    const { email, password } = parsed.data

    const user = await ladeAktivenUserByEmail(email)
    if (!user) {
      // Unspezifische Antwort: gleiche Antwortzeit durch künstliche Verzögerung
      await argon2.hash('decoy-password-for-timing-attack-mitigation')
      return reply.code(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'E-Mail oder Passwort ist falsch',
      })
    }

    const ok = await argon2.verify(user.passwordHash, password)
    if (!ok) {
      return reply.code(401).send({
        code: 'INVALID_CREDENTIALS',
        message: 'E-Mail oder Passwort ist falsch',
      })
    }

    const tokens = await issueTokenPair(app, user.id, user.email, user.rolle, req.headers['user-agent'])
    setRefreshCookie(reply, tokens.refreshPlain)

    // Letzter Login speichern
    const db = getDb()
    await db.update(users).set({ letzterLoginAm: new Date() }).where(eq(users.id, user.id))

    return reply.send({
      token: tokens.jwt,
      user: {
        id: user.id,
        email: user.email,
        anzeigename: user.anzeigename,
        rolle: user.rolle,
        mustChangePassword: user.mustChangePassword,
      },
    })
  },
  )

  // ---------- POST /api/auth/refresh ----------
  app.post('/api/auth/refresh', async (req, reply) => {
    const refreshPlain = readRefreshCookie(req)
    if (!refreshPlain) {
      return reply.code(401).send({ code: 'NO_REFRESH', message: 'kein Refresh-Cookie' })
    }
    const tokenHash = hashRefreshToken(refreshPlain)

    const db = getDb()
    const rows = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1)
    const row = rows[0] as RefreshTokenRow | undefined

    if (!row || row.revoked_at !== null || row.ablauf_am.getTime() < Date.now()) {
      clearRefreshCookie(reply)
      return reply.code(401).send({ code: 'REFRESH_INVALID', message: 'Refresh-Token ungültig' })
    }

    // Altes Token widerrufen, neues Paar ausstellen (Rotation)
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id))

    const userRows = await db.select().from(users).where(eq(users.id, row.user_id)).limit(1)
    const user = userRows[0]
    if (!user || !user.aktiv) {
      clearRefreshCookie(reply)
      return reply.code(401).send({ code: 'USER_INACTIVE', message: 'User ist deaktiviert' })
    }

    const tokens = await issueTokenPair(app, user.id, user.email, user.rolle, req.headers['user-agent'])
    setRefreshCookie(reply, tokens.refreshPlain)
    return reply.send({ token: tokens.jwt })
  })

  // ---------- POST /api/auth/logout ----------
  app.post('/api/auth/logout', async (req, reply) => {
    const refreshPlain = readRefreshCookie(req)
    if (refreshPlain) {
      const tokenHash = hashRefreshToken(refreshPlain)
      const db = getDb()
      await db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.tokenHash, tokenHash))
    }
    clearRefreshCookie(reply)
    return reply.code(204).send()
  })

  // ---------- GET /api/auth/me ----------
  app.get(
    '/api/auth/me',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const u = req.authUser
      if (!u) return reply.code(401).send({ code: 'UNAUTHORIZED' })
      const db = getDb()
      const rows = await db.select().from(users).where(eq(users.id, u.sub)).limit(1)
      const user = rows[0]
      if (!user) return reply.code(404).send({ code: 'NOT_FOUND' })
      return reply.send({
        id: user.id,
        email: user.email,
        anzeigename: user.anzeigename,
        rolle: user.rolle,
        mustChangePassword: user.mustChangePassword,
      })
    },
  )

  // ---------- POST /api/auth/change-password ----------
  const changePwSchema = z.object({
    oldPassword: z.string().min(1),
    newPassword: z.string().min(8),
  })
  app.post<{ Body: z.infer<typeof changePwSchema> }>(
    '/api/auth/change-password',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = changePwSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const u = req.authUser
      if (!u) return reply.code(401).send({ code: 'UNAUTHORIZED' })
      const db = getDb()
      const rows = await db.select().from(users).where(eq(users.id, u.sub)).limit(1)
      const user = rows[0]
      if (!user) return reply.code(404).send({ code: 'NOT_FOUND' })

      const ok = await argon2.verify(user.passwordHash, parsed.data.oldPassword)
      if (!ok) {
        return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Altes Passwort falsch' })
      }
      const newHash = await argon2.hash(parsed.data.newPassword)
      await db
        .update(users)
        .set({ passwordHash: newHash, mustChangePassword: false })
        .where(eq(users.id, u.sub))
      return reply.code(204).send()
    },
  )
}

// ---------- Helfer ----------

interface TokenPair {
  jwt: string
  refreshPlain: string
}

async function issueTokenPair(
  app: FastifyInstance,
  userId: string,
  email: string,
  rolle: 'admin' | 'user',
  userAgent: string | undefined,
): Promise<TokenPair> {
  const payload: JwtPayload = { sub: userId, email, rolle }
  const jwt = app.jwt.sign(payload)
  const refreshPlain = generateRefreshToken()
  const tokenHash = hashRefreshToken(refreshPlain)

  const db = getDb()
  await db.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    erstelltAm: new Date(),
    ablaufAm: new Date(Date.now() + REFRESH_TTL_MS),
    userAgent: userAgent ?? null,
  })

  return { jwt, refreshPlain }
}