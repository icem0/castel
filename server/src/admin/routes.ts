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
//
// Konzept: Die PWA pollt ohnehin zyklisch (Standard 30 s) und pusht ihre
// Outbox. Wir setzen hier nur das Signal "jetzt bitte alle pushen, was
// noch uebrig ist". Der naechste regulaere Sync-Lauf jedes Clients erledigt
// den Rest. Wer eine Realtime-Variante (SSE/WebSocket) will, kann spaeter
// auf demselben Marker aufsetzen.

import type { FastifyInstance } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { einstellungen } from '../db/schema.js'

const FORCE_SYNC_KEY = 'sync.forceAt'

export async function adminRoutes(app: FastifyInstance): Promise<void> {
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
}
