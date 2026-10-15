// JWT- und Refresh-Token-Helfer.

import { createHash, randomBytes } from 'node:crypto'
import jwt from '@fastify/jwt'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config/config.js'

export interface JwtPayload {
  sub: string // user.id
  email: string
  rolle: 'admin' | 'user'
  iat?: number
  exp?: number
}

export async function registerJwt(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: config.JWT_SECRET,
    sign: { expiresIn: config.JWT_EXPIRES_IN },
  })
}

/**
 * Hash für Refresh-Tokens (SHA-256). Wir speichern NIE den Klartext,
 * nur den Hash — kompromittierte DB-Backups geben keine aktiven Tokens.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Erzeugt einen 32-Byte-Random-String (für Cookies). */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Konstante für Cookie-Namen. */
export const REFRESH_COOKIE = 'castel_refresh'
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 Tage

/** Cookie-Optionen für Refresh-Tokens. */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/api/auth',
    domain: config.COOKIE_DOMAIN,
    maxAge: REFRESH_TTL_MS / 1000,
  }
}

/** Liest das Refresh-Cookie und gibt den Klartext zurück (oder undefined). */
export function readRefreshCookie(req: FastifyRequest): string | undefined {
  const cookie = req.cookies[REFRESH_COOKIE]
  return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined
}

/** Setzt das Refresh-Cookie in der Antwort. */
export function setRefreshCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(REFRESH_COOKIE, token, refreshCookieOptions())
}

/** Löscht das Refresh-Cookie. */
export function clearRefreshCookie(reply: FastifyReply): void {
  void reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
}