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
//   * POST /api/admin/buchungen/filter - filtert Buchungen basierend auf Kriterien.
//   * POST /api/admin/buchungen/bulk-delete - bereitet Bulk-Löschung von Buchungen vor.
//   * POST /api/admin/buchungen/execute-bulk-delete - führt Bulk-Löschung aus.
//   * POST /api/admin/standorte/bulk-rename - benennt mehrere Standorte um.
//   * POST /api/admin/standorte/bulk-archive - archiviert mehrere Standorte.
//
// Konzept: Die PWA pollt ohnehin zyklisch (Standard 30 s) und pusht ihre
// Outbox. Wir setzen hier nur das Signal "jetzt bitte alle pushen, was
// noch uebrig ist". Der naechste regulaere Sync-Lauf jedes Clients erledigt
// den Rest. Wer eine Realtime-Variante (SSE/WebSocket) will, kann spaeter
// auf demselben Marker aufsetzen.

import type { FastifyInstance } from 'fastify'
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { einstellungen } from '../db/schema.js'
import { buchungen } from '../db/schema.js'
import { standorte } from '../db/schema.js'

export type FilterCriteria = {
  standortId?: string
  artikelId?: string
  datumVon?: string
  datumBis?: string
  typ?: string
  projekt?: string
  kennzeichen?: string
}

const FORCE_SYNC_KEY = 'sync.forceAt'

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

  // POST /api/admin/buchungen/filter
  // Admin-only. Filtert Buchungen basierend auf Suchkriterien.
  app.post(
    '/api/admin/buchungen/filter',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { filter } = req.body as { filter: FilterCriteria }
      
      const db = getDb()
      const { standortId, artikelId, datumVon, datumBis, typ, projekt, kennzeichen } = filter
      
      let query = db.select().from(buchungen)
      
      if (standortId) {
        query = query.where(eq(buchungen.standortId, standortId))
      }
      if (artikelId) {
        query = query.where(eq(buchungen.artikelId, artikelId))
      }
      if (datumVon && datumBis) {
        query = query.where(
          and(
            sql`${buchungen.datum} >= ${datumVon}`,
            sql`${buchungen.datum} <= ${datumBis}`
          )
        )
      }
      if (typ) {
        query = query.where(eq(buchungen.typ, typ))
      }
      if (projekt) {
        query = query.where(eq(buchungen.projekt, projekt))
      }
      if (kennzeichen) {
        query = query.where(eq(buchungen.kennzeichen, kennzeichen))
      }
      
      const filteredBuchungen = await query
      return reply.send(filteredBuchungen)
    },
  )

  // POST /api/admin/buchungen/bulk-delete
  // Admin-only. Löscht mehrere Buchungen mit Sicherheitsabfrage.
  app.post(
    '/api/admin/buchungen/bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids } = req.body as { ids: string[] }
      
      if (!ids || ids.length === 0) {
        return reply.status(400).send({ error: 'Keine IDs angegeben' })
      }
      
      const db = getDb()
      
      // Sicherheitsabfrage - Anzahl der zu löschenden Buchungen
      const zuLoeschende = await db
        .select({ c: count() })
        .from(buchungen)
        .where(inArray(buchungen.id, ids))
      
      const anzahl = zuLoeschende[0]?.c || 0
      
      // Rückgabe der Anzahl für die Bestätigung im UI
      return reply.send({ 
        count: anzahl,
        ids: ids
      })
    },
  )

  // POST /api/admin/buchungen/execute-bulk-delete
  // Admin-only. Führt den Bulk-Löschvorgang nach Bestätigung aus.
  app.post(
    '/api/admin/buchungen/execute-bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids } = req.body as { ids: string[] }
      
      if (!ids || ids.length === 0) {
        return reply.status(400).send({ error: 'Keine IDs angegeben' })
      }
      
      const db = getDb()
      
      // Tatsächliche Löschung
      await db.delete(buchungen).where(inArray(buchungen.id, ids))
      
      return reply.send({ success: true })
    },
  )

  // POST /api/admin/standorte/bulk-rename
  // Admin-only. Benennt mehrere Standorte um.
  app.post(
    '/api/admin/standorte/bulk-rename',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids, newName } = req.body as { ids: string[]; newName: string }
      
      if (!ids || ids.length === 0) {
        return reply.status(400).send({ error: 'Keine Standorte ausgewählt' })
      }
      if (!newName || newName.trim().length === 0) {
        return reply.status(400).send({ error: 'Neuer Name ist erforderlich' })
      }
      
      const db = getDb()
      const now = new Date().toISOString()
      
      // Aktualisiere alle ausgewählten Standorte
      for (const id of ids) {
        await db
          .update(standorte)
          .set({ name: newName, geaendertAm: now })
          .where(eq(standorte.id, id))
      }
      
      return reply.send({ success: true, updated: ids.length })
    },
  )

  // POST /api/admin/standorte/bulk-archive
  // Admin-only. Archiviert mehrere Standorte.
  app.post(
    '/api/admin/standorte/bulk-archive',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids, archiviert } = req.body as { ids: string[]; archiviert: boolean }
      
      if (!ids || ids.length === 0) {
        return reply.status(400).send({ error: 'Keine Standorte ausgewählt' })
      }
      
      const db = getDb()
      const now = new Date().toISOString()
      
      // Prüfe ob irgendein Standort der Standard ist (geschuetzt)
      const standardStandorte = await db
        .select({ id: standorte.id })
        .from(standorte)
        .where(and(eq(standorte.id, ids[0]), eq(standorte.standard, true)))
      
      if (standardStandorte.length > 0) {
        return reply.status(409).send({
          error: 'Standort kann nicht archiviert werden: Standardlager darf nicht archiviert werden'
        })
      }
      
      // Archiviere alle ausgewählten Standorte
      for (const id of ids) {
        await db
          .update(standorte)
          .set({ archiviert: archiviert, geaendertAm: now })
          .where(eq(standorte.id, id))
      }
      
      return reply.send({ success: true, updated: ids.length })
    },
  )
}
