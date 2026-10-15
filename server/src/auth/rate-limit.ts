// Rate-Limit-Konfiguration für Login-Versuche.
//
// In @fastify/rate-limit v10 ist rateLimit ein Prehandler-Hook, kein globales
// Plugin. Wir registrieren global nur das optionale Store-Plugin (nicht
// nötig), und nutzen den Prehandler per-Route für Login.

import type { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { config } from '../config/config.js'

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  // Globales Rate-Limit-Plugin, aber mit `global: false` deaktiviert.
  // Damit ist `app.rateLimit` als Prehandler verfügbar.
  await app.register(rateLimit, {
    global: false,
    max: 200,
    timeWindow: '1 minute',
  })
}

/**
 * Prehandler für Login-Routen, der das Rate-Limit strickt durchsetzt.
 * Wird in den Auth-Routen als `preHandler: loginRateLimit(app)` registriert.
 */
export function loginRateLimit(app: FastifyInstance) {
  return app.rateLimit({
    max: config.RATE_LIMIT_LOGIN_MAX,
    timeWindow: config.RATE_LIMIT_LOGIN_WINDOW,
    keyGenerator: (req) => req.ip,
  })
}