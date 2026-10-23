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
  FOTOS_DIR: z.string().default('/var/lib/castel/fotos'),
  FOTOS_MAX_BYTES: z.coerce.number().int().positive().default(524288),
  FOTOS_MAX_PER_ARTIKEL: z.coerce.number().int().positive().default(5),

  // Backups
  BACKUP_DIR: z.string().default('/var/lib/castel/backups'),
  BACKUP_SYNC_QUIET_MS: z.coerce.number().int().positive().default(8000),
  BACKUP_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  // Rate-Limit
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.string().default('1 minute'),

  // Agenten-Zugriff (API-Keys + MCP).
  // API_KEYS_ENABLED=false deaktiviert sowohl die Key-Verwaltung als auch
  // die API-Key-Authentifizierung; die PWA/JWT-Nutzung bleibt unberuehrt.
  API_KEYS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),
  API_KEY_MAX_PER_USER: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_API_WINDOW: z.string().default('1 minute'),

  // MCP-Server (in-process im API-Container).
  // Der Pfad liegt bewusst unter /api/*, damit der bestehende nginx-Proxy
  // im PWA-Container ihn ohne zusaetzliche location-Regel erreicht.
  MCP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),
  MCP_PATH: z.string().default('/api/mcp'),

  // OpenAPI/Swagger-UI unter /api/docs. Oeffentlich lesbar (keine Daten),
  // kann bei Bedarf abgeschaltet werden.
  API_DOCS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),

  // DATANORM-Import (Hersteller-Kataloge).
  // Die Dateien werden serverseitig aufbewahrt und geparst; die PWA fragt
  // den Katalog anschliessend on-demand per /api/datanorm/artikel ab.
  // Hinweis: DATANORM-Dateien sind kein offener Standard und koennen
  // sehr gross sein (real 1 MB bis mehrere GB). Deshalb streamen wir,
  // puffern nicht komplett im RAM und haben ein hartes Size-Limit.
  DATANORM_DIR: z.string().default('/var/lib/castel/datanorm'),
  // Temporaerer Arbeitsbereich fuer Pass-1-Zwischenspeicher (Disk-Spill
  // bei sehr grossen Dateien). Default: Betriebssystem-Temp (os.tmpdir()).
  DATANORM_TMP_DIR: z.string().default(''),
  // Hartes Limit fuer eine einzelne hochgeladene Datei (Default 500 MB).
  DATANORM_MAX_FILE_BYTES: z.coerce.number().int().positive().default(524288000),
  // Ab dieser Record-Zahl wird statt Batch-Upsert der COPY-Pfad
  // (Staging-Tabelle + INSERT ... SELECT ... ON CONFLICT) genutzt.
  DATANORM_COPY_THRESHOLD: z.coerce.number().int().positive().default(30000),
  // In-Memory-Budget fuer Pass 1. Darueber hinaus werden die
  // Zwischen-Records als JSONL-Chunks auf Platte geschrieben.
  DATANORM_DISK_SPILL_BYTES: z.coerce.number().int().positive().default(209715200),
  // True = Parser bricht bei der ersten strukturellen Auffaelligkeit ab.
  // Default false (tolerant): nur harte Strukturfehler (kein Encoding,
  // keine A-Saetze) brechen ab, alles andere landet im Import-Report.
  DATANORM_STRICT_MODE: z
    .string()
    .default('false')
    .transform((v) => {
      const n = v.toLowerCase()
      return n === 'true' || n === '1' || n === 'yes' || n === 'on'
    }),
  // Obergrenzen fuer gemeldete Parserfehler: Anteil bzw. absolute Zahl
  // fehlerhafter Zeilen, ab der ein Import als "degraded" markiert wird.
  DATANORM_MAX_FEHLER_PROZENT: z.coerce.number().min(0).max(100).default(25),
  DATANORM_MAX_FEHLER_ABSOLUT: z.coerce.number().int().positive().default(100000),
  // Aufbewahrung der hochgeladenen Originaldateien: Der jeweils JUENGSTE
  // Eintrag pro Lieferant bleibt immer erhalten, aeltere werden nach
  // diesem Wert in Tagen geloescht. Die Import-Reports selbst werden
  // nicht aufgeraeumt (Audit-Spur bleibt vollstaendig).
  DATANORM_CLEANUP_TAGE: z.coerce.number().int().positive().default(730),

  // Mail / Notification-Gateway (Vorbereitung für tägliche Sammel-Mail).
  // MAIL_ENABLED=false (Default) → LogNotificationGateway, kein SMTP,
  // keine zusätzlichen Dependencies. MAIL_ENABLED=true →
  // SmtpNotificationGateway (aktuell noch Skeleton/Stub). Die echte
  // SMTP-Implementierung wird nachgerüstet, sobald die Daily-Digest-
  // Funktionalität drankommt. Bis dahin dokumentieren die Variablen
  // den Vertrag, damit das Schema steht.
  MAIL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1' || v.toLowerCase() === 'yes'),
  MAIL_SMTP_HOST: z.string().default(''),
  MAIL_SMTP_PORT: z.coerce.number().int().positive().default(587),
  MAIL_SMTP_USER: z.string().default(''),
  MAIL_SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('castel@example.com'),
  MAIL_DAILY_DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(7),
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