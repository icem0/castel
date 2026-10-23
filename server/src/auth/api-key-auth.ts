// API-Key-Authentifizierung fuer /api/v1 und /api/mcp.
//
// Die bestehenden PWA-/Sync-Routen bleiben JWT-only. Agenten bekommen
// einen eigenen Auth-Pfad, damit wir Scopes und Rate-Limits sauber
// durchsetzen koennen, ohne das Verhalten der PWA zu veraendern.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { apiKeys, users } from '../db/schema.js'
import { config } from '../config/config.js'
import {
  apiKeyAusRequest,
  hashApiKey,
  scopeErlaubt,
  type ApiKeyScope,
} from './api-keys.js'

export interface ApiAuthContext {
  userId: string
  email: string
  rolle: 'admin' | 'user'
  scopes: ApiKeyScope[]
  apiKeyId: string
  keyPrefix: string
}

declare module 'fastify' {
  interface FastifyRequest {
    apiAuth?: ApiAuthContext
  }
  interface FastifyInstance {
    requireApiAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireApiScope: (
      scope: ApiKeyScope,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/** Nur fuer Tests: ein Auth-Kontext ohne DB-Lookup. */
export function setzeTestApiAuth(req: FastifyRequest, ctx: ApiAuthContext | undefined): void {
  req.apiAuth = ctx
}

/**
 * Loest den API-Key gegen die DB auf. Liefert `null` bei jedem Fehler —
 * der Aufrufer entscheidet ueber die HTTP-Antwort.
 */
export async function authenticateApiKey(req: FastifyRequest): Promise<ApiAuthContext | null> {
  if (!config.API_KEYS_ENABLED) return null
  const plaintext = apiKeyAusRequest(req)
  if (!plaintext) return null

  const db = getDb()
  const hash = hashApiKey(plaintext)
  const rows = await db
    .select({
      keyId: apiKeys.id,
      keyPrefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      ablaufAm: apiKeys.ablaufAm,
      revokedAt: apiKeys.revokedAt,
      letzteNutzungAm: apiKeys.letzteNutzungAm,
      userId: users.id,
      email: users.email,
      rolle: users.rolle,
      aktiv: users.aktiv,
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  if (!row.aktiv) return null
  if (row.revokedAt !== null) return null
  if (row.ablaufAm !== null && row.ablaufAm.getTime() <= Date.now()) return null

  // last_used throttled: kein Write pro Request.
  const now = Date.now()
  const letzte = row.letzteNutzungAm?.getTime() ?? 0
  if (now - letzte > 60_000) {
    void db
      .update(apiKeys)
      .set({ letzteNutzungAm: new Date(now) })
      .where(and(eq(apiKeys.id, row.keyId), isNull(apiKeys.revokedAt)))
      .catch((err: unknown) => req.log.warn({ err }, 'api_key_last_used_update_failed'))
  }

  return {
    userId: row.userId,
    email: row.email,
    rolle: row.rolle,
    scopes: (row.scopes ?? []) as ApiKeyScope[],
    apiKeyId: row.keyId,
    keyPrefix: row.keyPrefix,
  }
}

/** PreHandler: verlangt einen gueltigen API-Key. */
export async function requireApiAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!config.API_KEYS_ENABLED) {
    void reply.code(404).send({ code: 'API_DISABLED', message: 'Agenten-API ist deaktiviert' })
    return
  }
  if (req.apiAuth) return
  const ctx = await authenticateApiKey(req)
  if (!ctx) {
    void reply.code(401).send({
      code: 'UNAUTHORIZED',
      message: 'API-Key fehlt oder ist ungültig',
    })
    return
  }
  req.apiAuth = ctx
}

/** PreHandler-Factory: verlangt zusaetzlich einen Scope. */
export function requireApiScope(scope: ApiKeyScope) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ctx = req.apiAuth
    if (!ctx) {
      void reply.code(401).send({ code: 'UNAUTHORIZED', message: 'API-Key fehlt' })
      return
    }
    if (!scopeErlaubt(ctx.scopes, scope)) {
      void reply.code(403).send({
        code: 'FORBIDDEN',
        message: `API-Key hat den Scope "${scope}" nicht`,
      })
      return
    }
    if (scope === 'admin' && ctx.rolle !== 'admin') {
      void reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'Admin-Scope erfordert einen Admin-User',
      })
    }
  }
}

/**
 * Registriert die API-Key-Auth als Fastify-Decorator. Der Decorator ist
 * auch in Tests nutzbar, die die Routen ohne echten Key mounten.
 */
export function registerApiAuthDecorators(app: FastifyInstance): void {
  app.decorateRequest('apiAuth', undefined)
  app.decorate('requireApiAuth', requireApiAuth)
  app.decorate('requireApiScope', requireApiScope)
}

/**
 * Hilfsfunktion fuer Routen, die entweder JWT ODER API-Key akzeptieren.
 * Aktuell nicht verwendet, bleibt als bewusster Erweiterungspunkt.
 */
export async function istEingeloggtOderApiKey(req: FastifyRequest): Promise<boolean> {
  if (req.authUser) return true
  if (req.apiAuth) return true
  const ctx = await authenticateApiKey(req)
  if (!ctx) return false
  req.apiAuth = ctx
  return true
}


