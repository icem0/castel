// Admin-Routes: Werkzeuge, die nur fuer Admins erreichbar sind.
//
// Aktuell:
//   * POST /api/admin/sync/all     - triggert einen globalen Sync-Impuls.
//                                    Setzt einen `sync.forceAt`-Marker in der
//                                    `einstellungen`-Tabelle (global,
//                                    user_id IS NULL). Antwortet sofort mit
//                                    dem Zeitstempel des Markers, damit das
//                                    aufrufende Skript anschliessend per
//                                    /api/sync/status pollen kann, ob die
//                                    Clients die Outbox leergemacht haben.
//   * GET  /api/admin/sync/force-at - liest den aktuellen Marker. Wird
//                                    vom PWA-Worker genutzt, um festzu-
//                                    stellen, ob der Server einen Push
//                                    angefordert hat.
//   * POST /api/admin/db/clear     - leert alle Domain-Datentabellen im Server.
//   * POST /api/admin/buchungen/filter      - filtert Buchungen (Dev-UI).
//   * POST /api/admin/buchungen/bulk-delete - loescht ausgewaehlte Buchungen
//                                             (Dev-UI, Hard-Delete).
//
// Konzept: Die PWA pollt ohnehin zyklisch (Standard 30 s) und pusht ihre
// Outbox. Wir setzen hier nur das Signal "jetzt bitte alle pushen, was
// noch uebrig ist". Der naechste regulaere Sync-Lauf jedes Clients erledigt
// den Rest. Wer eine Realtime-Variante (SSE/WebSocket) will, kann spaeter
// auf demselben Marker aufsetzen.

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { spawn } from 'node:child_process'
import { getDb } from '../db/client.js'
import { einstellungen, geraete, syncErrorReports, users } from '../db/schema.js'
import { bulkBookingRoutes } from './bulk-booking-routes.js'
import { normalisiereRollen } from '../domain/rollen.js'
import { z } from 'zod'

const FORCE_SYNC_KEY = 'sync.forceAt'

/**
 * Fuehrt ein Kommando aus und liefert Exit-Code, stdout und stderr.
 * Wird fuer den Update-Endpunkt genutzt (git pull, docker compose, …).
 */
async function fuehreKommando(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const CLEARED_DOMAIN_TABLES = [
  'datanorm_importe',
  'datanorm_dateien',
  'hersteller_artikel',
  'lieferanten',
  'mindestbestand_ereignisse',
  'akku_netzteile',
  'akku_projekte',
  'akku_bestellungen',
  'audit_log',
  'fotos',
  'buchungen',
  'commission',
  'artikel_standort_mindestbestaende',
  'artikel',
  'standorte',
  'einstellungen',
] as const

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await bulkBookingRoutes(app)

  // POST /api/admin/sync/all
  // Admin-only. Setzt den globalen `sync.forceAt`-Marker auf die aktuelle
  // Server-Zeit. Existiert der Marker schon, wird er ueberschrieben
  // (LWW auf geaendert_am).
  app.post(
    '/api/admin/sync/all',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const db = getDb()
      const now = new Date().toISOString()
      // upsert: existierende Zeile aktualisieren, sonst anlegen.
      // Raw-SQL ist hier sauberer als ein Drizzle-Update + Insert-Try,
      // weil user_id = NULL den Compound-Key (key, user_id) in ON CONFLICT
      // nicht abbildet (NULL gilt als unterschiedlich). Deshalb greifen wir
      // den Teil-Index einstellungen_key_global_idx (key) WHERE user_id IS NULL.
      await db.execute(sql`
        INSERT INTO einstellungen (key, user_id, value, geaendert_am)
        VALUES (${FORCE_SYNC_KEY}, NULL, ${now}, NOW())
        ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE
          SET value = EXCLUDED.value,
              geaendert_am = EXCLUDED.geaendert_am
      `)
      return reply.send({ forceAt: now })
    },
  )

  // GET /api/admin/sync/force-at
  // Auth erforderlich (irgendein eingeloggter User), weil der Marker
  // Server-Internas preisgibt. Read-only - erlaubt auch normalen Usern,
  // damit der Sync-Worker ohne Admin-Check pollen kann.
  app.get(
    '/api/admin/sync/force-at',
    { preHandler: app.requireAuth },
    async (_req, reply) => {
      const db = getDb()
      const rows = await db
        .select({ value: einstellungen.value })
        .from(einstellungen)
        .where(and(eq(einstellungen.key, FORCE_SYNC_KEY), isNull(einstellungen.userId)))
        .limit(1)
      const forceAt = rows[0]?.value ?? null
      return reply.send({ forceAt })
    },
  )

  // POST /api/admin/db/clear
  // Admin-only. Leert alle Domain-Datentabellen auf dem Server (Artikel,
  // Standorte, Buchungen, Fotos, Einstellungen, etc.) aber behält Users
  // und Refresh-Tokens bei, damit der Admin weiter angemeldet bleibt.
  app.post(
    '/api/admin/db/clear',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const db = getDb()

      // PostgreSQL rejects separate TRUNCATE calls when an FK points from an
      // omitted table to the target, even if that referencing table is empty.
      // A single statement locks the whole domain closure, and CASCADE keeps
      // the operation stable when new dependent domain tables are added.
      await db.execute(
        sql.raw(
          `TRUNCATE TABLE ${CLEARED_DOMAIN_TABLES.join(', ')} CASCADE`,
        ),
      )

      return reply.send({ cleared: true })
    },
  )

  // ---------- GET /api/admin/geraete ----------
  // Listet alle registrierten Endgeraete mit dem zugehortigen User und dem
  // Reset-Flag (reset_am). Grundlage fuer den serverseitig ausgeloesten
  // lokalen DB-Reset pro Endgeraet (siehe AGENTS.md "Geraete-Reset").
  // Liefert pro Geraet zudem den letzten Sync-Fehler (falls vorhanden).
  app.get(
    '/api/admin/geraete',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const db = getDb()
      const rows = await db
        .select({
          id: geraete.id,
          userId: geraete.userId,
          email: users.email,
          rolle: users.rolle,
          rollen: users.rollen,
          fingerprint: geraete.fingerprint,
          resetAm: geraete.resetAm,
          registriertAm: geraete.registriertAm,
          zuletztGesehenAm: geraete.zuletztGesehenAm,
        })
        .from(geraete)
        .leftJoin(users, eq(geraete.userId, users.id))
        .orderBy(desc(geraete.zuletztGesehenAm))

      // Letzten Sync-Fehler pro Geraet ermitteln (neuester Report).
      const reportsByDevice = new Map<string, { occurredAt: string; code: string; message: string }[]>()
      try {
        const deviceIds = rows.map((r) => r.id)
        if (deviceIds.length > 0) {
          const allReports = await db
            .select({
              deviceId: syncErrorReports.deviceId,
              occurredAt: syncErrorReports.occurredAt,
              code: syncErrorReports.code,
              message: syncErrorReports.message,
              createdAt: syncErrorReports.createdAt,
            })
            .from(syncErrorReports)
            .where(inArray(syncErrorReports.deviceId, deviceIds))
            .orderBy(syncErrorReports.createdAt)
          for (const r of allReports) {
            const arr = reportsByDevice.get(r.deviceId) ?? []
            arr.push({
              occurredAt: r.occurredAt.toISOString(),
              code: r.code,
              message: r.message,
            })
            reportsByDevice.set(r.deviceId, arr)
          }
        }
      } catch {
        // sync_error_reports-Tabelle existiert noch (Migration nicht durchgelaufen).
        // Einfach keine Reports anzeigen — die Geräteliste bleibt trotzdem funktionsfähig.
      }

      return reply.send({
        geraete: rows.map((r) => {
          const reports = reportsByDevice.get(r.id) ?? []
          const last = reports[reports.length - 1]
          return {
            id: r.id,
            userId: r.userId,
            email: r.email ?? null,
            rolle: r.rolle ?? null,
            rollen: normalisiereRollen(r.rollen),
            fingerprint: r.fingerprint ? JSON.parse(r.fingerprint) : {},
            resetAm: r.resetAm?.toISOString() ?? null,
            registriertAm: r.registriertAm.toISOString(),
            zuletztGesehenAm: r.zuletztGesehenAm.toISOString(),
            lastSyncErrorAt: last?.occurredAt ?? null,
            lastSyncErrorCode: last?.code ?? null,
            lastSyncErrorMessage: last?.message ?? null,
          }
        }),
      })
    },
  )

  // ---------- GET /api/admin/geraete/:deviceId/sync-error-reports ----------
  // Liefert die letzten 2 Sync-Fehler-Reports eines Endgeraets (mit vollen
  // Diagnostics) fuer die Entwicklungs-Ansicht.
  app.get(
    '/api/admin/geraete/:deviceId/sync-error-reports',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { deviceId } = req.params as { deviceId: string }
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'deviceId erforderlich' })
      }
      const db = getDb()
      const reports = await db
        .select({
          id: syncErrorReports.id,
          occurredAt: syncErrorReports.occurredAt,
          source: syncErrorReports.source,
          code: syncErrorReports.code,
          message: syncErrorReports.message,
          httpStatus: syncErrorReports.httpStatus,
          stack: syncErrorReports.stack,
          payload: syncErrorReports.payload,
          diagnostics: syncErrorReports.diagnostics,
          createdAt: syncErrorReports.createdAt,
        })
        .from(syncErrorReports)
        .where(eq(syncErrorReports.deviceId, deviceId))
        .orderBy(syncErrorReports.createdAt)
      return reply.send({
        reports: reports.map((r) => ({
          id: r.id,
          occurredAt: r.occurredAt.toISOString(),
          source: r.source,
          code: r.code,
          message: r.message,
          httpStatus: r.httpStatus ?? null,
          stack: r.stack ?? null,
          payload: r.payload ?? null,
          diagnostics: r.diagnostics ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      })
    },
  )

  // ---------- POST /api/admin/geraete/:deviceId/reset ----------
  // Setzt (oder hebt) das Reset-Flag eines Endgeraets. Wenn gesetzt, loescht
  // das Endgeraet beim nachsten Sync-Tick (oder Login) seine lokale IndexedDB
  // und baut sie vom Server neu auf.
  const gerateResetSchema = z.object({ reset: z.boolean().optional().default(true) })

  app.post(
    '/api/admin/geraete/:deviceId/reset',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()
      const { deviceId } = req.params as { deviceId: string }
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'deviceId erforderlich' })
      }
      const parsed = gerateResetSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const resetAm = parsed.data.reset ? new Date() : null
      const result = await db
        .update(geraete)
        .set({ resetAm })
        .where(eq(geraete.id, deviceId))
        .returning({ id: geraete.id })
      return reply.send({
        deviceId,
        resetAm: resetAm?.toISOString() ?? null,
        matched: result.length,
      })
    },
  )

  // ---------- POST /api/admin/geraete/user/:userId/reset ----------
  // Setzt (oder hebt) das Reset-Flag fuer alle Endgeraete eines Users.
  app.post(
    '/api/admin/geraete/user/:userId/reset',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()
      const { userId } = req.params as { userId: string }
      if (typeof userId !== 'string' || userId.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'userId erforderlich' })
      }
      const parsed = gerateResetSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const resetAm = parsed.data.reset ? new Date() : null
      const result = await db
        .update(geraete)
        .set({ resetAm })
        .where(eq(geraete.userId, userId))
        .returning({ id: geraete.id })
      return reply.send({
        userId,
        resetAm: resetAm?.toISOString() ?? null,
        matched: result.length,
      })
    },
  )

  // ---------- POST /api/admin/update ----------
  // Fuehrt auf dem Host ein Update aus: git pull, docker compose pull,
  // docker compose up -d, docker image prune -f.
  //
  // Voraussetzungen (muss der Deployer bereitstellen):
  //   * Das Host-Verzeichnis ./scripts ist in den API-Container gemountet
  //     (z. B. `- ./scripts:/app/scripts:ro` in docker-compose.yml).
  //   * Der Docker-Socket ist gemountet (`- /var/run/docker.sock:/var/run/docker.sock`).
  //   * Das API-Image enthaelt `git` und den `docker` CLI (server/Dockerfile).
  // Ohne diese Voraussetzungen liefert der Endpunkt einen klaren Fehler.
  const updateSchema = z.object({ bestaetigt: z.boolean() })

  app.post(
    '/api/admin/update',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      if (!parsed.data.bestaetigt) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'bestaetigt muss true sein' })
      }

      const script = '/app/scripts/update.sh'
      let ergebnis: { code: number | null; stdout: string; stderr: string }
      try {
        ergebnis = await fuehreKommando('bash', [script])
      } catch (e) {
        return reply.code(500).send({
          code: 'UPDATE_FAILED',
          message: e instanceof Error ? e.message : String(e),
        })
      }

      const ok = ergebnis.code === 0
      return reply.send({
        ok,
        exitCode: ergebnis.code,
        stdout: ergebnis.stdout,
        stderr: ergebnis.stderr,
      })
    },
  )
}
