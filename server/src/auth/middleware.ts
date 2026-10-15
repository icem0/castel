// Fastify-Decorators + Middleware für Auth.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { users } from '../db/schema.js'
import { NotFoundError } from '../domain/errors.js'
import type { JwtPayload } from './jwt.js'

// Fastify-Typen-Erweiterung: Auth-Daten am Request, Decorators am Instance
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: JwtPayload
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * Setzt die User-Info auf `request.authUser`, falls ein JWT vorliegt.
 * Wird als preValidation/preParsing genutzt, damit `request.authUser` schon
 * in normalen Handlern verfügbar ist.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const payload = await req.jwtVerify<JwtPayload>()
    // Nochmal gegen DB prüfen (User könnte deaktiviert worden sein)
    const db = getDb()
    const row = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1)
    const user = row[0]
    if (!user || !user.aktiv) {
      void reply.code(401).send({ code: 'USER_INACTIVE', message: 'User ist deaktiviert' })
      return
    }
    req.authUser = payload
  } catch {
    void reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Token fehlt oder ungültig' })
  }
}

/** Erfordert einen eingeloggten User; sonst 401. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.authUser) return
  await authenticate(req, reply)
}

/** Factory für Rollen-Guards. */
export function requireRole(...rollen: Array<'admin' | 'user'>) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(req, reply)
    if (reply.sent) return
    const user = req.authUser
    if (!user || !rollen.includes(user.rolle)) {
      void reply.code(403).send({
        code: 'FORBIDDEN',
        message: `Rolle ${user?.rolle ?? 'keine'} nicht erlaubt`,
      })
    }
  }
}

/** Convenience-Decorator, damit Handler `req.currentUser()` aufrufen können. */
export function registerAuthDecorators(app: FastifyInstance): void {
  app.decorateRequest('authUser', undefined as unknown as JwtPayload)
  app.decorate(
    'requireAuth',
    async (req: FastifyRequest, reply: FastifyReply) => requireAuth(req, reply),
  )
  app.decorate(
    'requireAdmin',
    async (req: FastifyRequest, reply: FastifyReply) => requireRole('admin')(req, reply),
  )
}

/** Lädt den vollen User-Datensatz aus der DB (für Login-Flow). */
export async function ladeUser(userId: string) {
  const db = getDb()
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  const user = rows[0]
  if (!user) throw new NotFoundError('User', userId)
  return user
}

/** Wie oben, aber filtert auf aktiv=true. */
export async function ladeAktivenUserByEmail(email: string) {
  const db = getDb()
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1)
  const user = rows[0]
  if (!user || !user.aktiv) return null
  return user
}