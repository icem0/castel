// Zentrale, getypte Konfiguration aus Umgebungsvariablen.
// Wird einmal beim Modul-Import geladen und gegen die .env-Datei geprüft.

import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  // Postgres
  DATABASE_URL: z.string().url(),

  // HTTP
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen haben'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false')])
    .transform((v) => v === 'true')
    .default('false'),
  COOKIE_DOMAIN: z.string().default('localhost'),

  // CORS
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

  // Fotos
  FOTOS_DIR: z.string().default('./var/fotos'),
  FOTOS_MAX_BYTES: z.coerce.number().int().positive().default(524288),
  FOTOS_MAX_PER_ARTIKEL: z.coerce.number().int().positive().default(5),

  // Rate-Limit
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.string().default('1 minute'),

  // Development-Modus. Siehe docker-compose.yml (.env DEV_MODE).
  // Steuert u. a. das "DEV MODE"-Badge in der PWA und expose hier den
  // Status ueber /api/dev/status. Akzeptiert 'true'/'false'/'1'/'0'
  // (case-insensitive). Andere Werte oder nicht gesetzt -> false.
  // Bewusst locker: ein falsch gesetztes DEV_MODE soll den Server
  // nicht am Start hindern.
  DEV_MODE: z
    .string()
    .default('false')
    .transform((v) => {
      const n = v.toLowerCase()
      return n === 'true' || n === '1' || n === 'yes' || n === 'on'
    }),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Ungültige Umgebungsvariablen:')
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const config = parsed.data
export type AppConfig = typeof config