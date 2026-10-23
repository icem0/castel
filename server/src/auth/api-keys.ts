// API-Key-Erzeugung und -Pruefung fuer Agenten-/MCP-Zugriff.
//
// Sicherheitsregeln:
//   * Klartext-Keys werden NIE gespeichert oder geloggt.
//   * In der DB liegt nur der SHA-256-Hash (Lookup per Hash-Index).
//   * Ein sichtbarer Prefix erlaubt die Identifikation in der UI.
//   * Scopes koennen Rechte nur einschraenken, nie erweitern — die Rolle
//     des Users wird bei jeder Anfrage zusaetzlich geprueft.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

export const API_KEY_PREFIX = 'castel'
export const API_KEY_SCOPES = ['read', 'write', 'admin'] as const

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export interface GeneratedApiKey {
  /** Vollstaendiger Key — nur einmal an den User ausliefern. */
  plaintext: string
  /** SHA-256-Hash fuer die Speicherung. */
  hash: string
  /** Sichtbarer Teil fuer die UI, z. B. `castel_ab12cd34`. */
  prefix: string
}

/**
 * Erzeugt einen neuen API-Key. Format:
 *   castel_<8 hex prefix>_<32 byte base64url secret>
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = `${API_KEY_PREFIX}_${randomBytes(4).toString('hex')}`
  const secret = randomBytes(32).toString('base64url')
  const plaintext = `${prefix}_${secret}`
  return { plaintext, hash: hashApiKey(plaintext), prefix }
}

/** SHA-256-Hash eines API-Keys (hex). */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/** True, wenn der String wie ein castel-API-Key aussieht. */
export function siehtAusWieApiKey(value: string): boolean {
  return /^castel_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/.test(value)
}

/**
 * Liest den API-Key aus den erlaubten Headern. Bewusst NUR Header —
 * Query-Parameter landen in Logs und Proxy-Logs und werden nicht akzeptiert.
 *
 * Akzeptiert:
 *   Authorization: Bearer castel_...
 *   X-API-Key: castel_...
 */
export function apiKeyAusRequest(req: FastifyRequest): string | null {
  const header = req.headers['x-api-key']
  if (typeof header === 'string' && siehtAusWieApiKey(header.trim())) {
    return header.trim()
  }
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    const token = match?.[1]?.trim()
    if (token && siehtAusWieApiKey(token)) return token
  }
  return null
}

/** Normalisiert und validiert Scope-Listen aus dem Request-Body. */
export function normalisiereScopes(input: unknown): ApiKeyScope[] | null {
  if (!Array.isArray(input)) return null
  const out: ApiKeyScope[] = []
  for (const item of input) {
    if (typeof item !== 'string') return null
    if (!(API_KEY_SCOPES as readonly string[]).includes(item)) return null
    const scope = item as ApiKeyScope
    if (!out.includes(scope)) out.push(scope)
  }
  return out
}

/**
 * Prueft, ob die Key-Scopes eine Aktion erlauben.
 * `admin` impliziert read + write; `write` impliziert NICHT read
 * (bewusst explizit: ein reiner Schreib-Key soll keine Daten lesen).
 */
export function scopeErlaubt(
  scopes: readonly string[],
  benoetigt: ApiKeyScope,
): boolean {
  if (scopes.includes('admin')) return true
  if (benoetigt === 'read') return scopes.includes('read')
  if (benoetigt === 'write') return scopes.includes('write')
  return scopes.includes('admin')
}

/**
 * Konstantzeit-Vergleich fuer Hash-Strings. Der DB-Lookup passiert ueber
 * den Hash-Index; diese Funktion ist fuer Faelle, in denen zwei Hashes
 * direkt verglichen werden (Tests, Defense-in-Depth).
 */
export function hashesGleich(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
