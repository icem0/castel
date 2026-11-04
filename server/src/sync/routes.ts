// Sync-Routes: GET /api/sync/snapshot, GET /api/sync/status, POST /api/sync/push.

import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  artikel,
  artikelStandortMindestbestaende,
  akkuBestellungen,
  akkuNetzteile,
  akkuProjekte,
  buchungen,
  etikettenBogenLayout,
  einstellungen,
  geraete,
  hersteller,
  inventurPositionen,
  inventurStichtage,
  mindestbestandEreignisse,
  projekte,
  standorte,
  syncErrorReports,
} from '../db/schema.js'
import { pushPayloadSchema, reconcileSchema, snapshotQuerySchema } from '../domain/validierung.js'
import { leseRestoreEpoch } from '../admin/backup.js'
import { restoreGesperrt } from '../admin/restore-lock.js'
import { resolvePush } from './resolver.js'
import { INTERN_EINSTELLUNGS_KEYS } from './einstellungen-intern.js'
import { mappeHerstellerRabattsatz, stripEinkaufspreis } from './preise.js'
import { hatBerechtigung } from '../domain/rollen.js'
import type { NotificationGateway } from '../services/notification-gateway.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

async function countRows(db: ReturnType<typeof getDb>): Promise<{
  artikel: number
  standorte: number
  commission: number
  buchungen: number
  hersteller: number
  artikelStandortMindestbestand: number
  akkuNetzteile: number
  akkuProjekte: number
  akkuBestellungen: number
  etikettenBogenLayout: number
  inventurStichtage: number
  inventurPositionen: number
}> {
  const [a, s, p, b, h, m, n, q, ab, ebl, ist, ip] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(artikel),
    db.select({ c: sql<number>`count(*)::int` }).from(standorte),
    db.select({ c: sql<number>`count(*)::int` }).from(projekte),
    db.select({ c: sql<number>`count(*)::int` }).from(buchungen),
    db.select({ c: sql<number>`count(*)::int` }).from(hersteller),
    db.select({ c: sql<number>`count(*)::int` }).from(artikelStandortMindestbestaende),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuNetzteile),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuProjekte),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuBestellungen),
    db.select({ c: sql<number>`count(*)::int` }).from(etikettenBogenLayout),
    db.select({ c: sql<number>`count(*)::int` }).from(inventurStichtage),
    db.select({ c: sql<number>`count(*)::int` }).from(inventurPositionen),
  ])
  return {
    artikel: a[0]?.c ?? 0,
    standorte: s[0]?.c ?? 0,
    commission: p[0]?.c ?? 0,
    buchungen: b[0]?.c ?? 0,
    hersteller: h[0]?.c ?? 0,
    artikelStandortMindestbestand: m[0]?.c ?? 0,
    akkuNetzteile: n[0]?.c ?? 0,
    akkuProjekte: q[0]?.c ?? 0,
    akkuBestellungen: ab[0]?.c ?? 0,
    etikettenBogenLayout: ebl[0]?.c ?? 0,
    inventurStichtage: ist[0]?.c ?? 0,
    inventurPositionen: ip[0]?.c ?? 0,
  }
}

export async function syncRoutes(
  app: FastifyInstance,
  notificationGateway: NotificationGateway,
): Promise<void> {
  // ---------- GET /api/sync/snapshot?since=<iso>&mindestSince=<iso> ----------
  app.get<{ Querystring: { since?: string; mindestSince?: string } }>(
    '/api/sync/snapshot',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      // During a restore the database is a mixture of old and new state —
      // a snapshot in that window would be neither. The client retries on
      // its next tick (the restore epoch makes it rebuild afterwards).
      if (restoreGesperrt()) {
        return reply.code(503).send({
          code: 'RESTORE_IN_PROGRESS',
          message: 'Es läuft gerade ein Restore — bitte kurz warten.',
        })
      }
      const parsed = snapshotQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const since = parsed.data.since ? new Date(parsed.data.since) : new Date(0)
      const sinceIso = since.toISOString()
      // mindestSince: optionaler Filter für Mindestbestand-Ereignisse.
      // Default = Anbeginn der Zeit (alle Events). Der Client sendet den
      // zuletzt gesehenen Event-Timestamp, um nur die Änderungen zu ziehen.
      const mindestSince = parsed.data.mindestSince
        ? new Date(parsed.data.mindestSince)
        : new Date(0)
      const mindestSinceIso = mindestSince.toISOString()
      const db = getDb()
      const user = req.authUser
      if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })

      const [
        artikelRows,
        standortRows,
        projektRows,
        buchungRows,
        einstellungRows,
        eventRows,
        herstellerRows,
        mindestbestandRows,
        akkuNetzteilRows,
        akkuProjektRows,
        akkuBestellungRows,
        etikettenBogenLayoutRows,
        inventurStichtageRows,
        inventurPositionenRows,
        restoreEpoch,
      ] = await Promise.all([
        db
          .select()
          .from(artikel)
          .where(sql`${artikel.geaendertAm} > ${sinceIso}`),
        db
          .select()
          .from(standorte)
          .where(sql`${standorte.geaendertAm} > ${sinceIso}`),
        db
          .select()
          .from(projekte)
          .where(sql`${projekte.geaendertAm} > ${sinceIso}`),
        db
          .select()
          .from(buchungen)
          .where(sql`${buchungen.erstelltAm} > ${sinceIso}`),
        // Einstellungen: alle globalen + die des eingeloggten Users.
        // Server-interne Marker (`sync.*`, `backup.*`, `server.restoreEpoch`)
        // bleiben draußen — sonst wären sie in der IndexedDB der Clients und
        // koennten per Outbox/Reseed alten Stand zurueck auf den Server
        // schreiben (z. B. ein bereits verbrauchter Backup-Tages-Slot).
        db
          .select()
          .from(einstellungen)
          .where(
            and(
              sql`${einstellungen.geaendertAm} > ${sinceIso}`,
              or(isNull(einstellungen.userId), eq(einstellungen.userId, user.sub)),
              notInArray(einstellungen.key, [...INTERN_EINSTELLUNGS_KEYS]),
            ),
          ),
        // Mindestbestand-Ereignisse: nach `erstellt_am > mindestSince`.
        // Max500 — falls die Tabelle groß wird, paginiert der Client
        // über den Marker `mindestbestand.lastPullAt`.
        db
          .select()
          .from(mindestbestandEreignisse)
          .where(sql`${mindestbestandEreignisse.erstelltAm} > ${mindestSinceIso}`)
          .orderBy(sql`${mindestbestandEreignisse.erstelltAm} ASC`)
          .limit(500),
        // Hersteller-Stammdaten (Bestellkontakt) — inkrementell wie die
        // übrigen Stammdaten.
        db
          .select()
          .from(hersteller)
          .where(sql`${hersteller.geaendertAm} > ${sinceIso}`),
        // Mindestbestand je (Artikel, Standort) — LWW ueber `geaendert_am`.
        db
          .select()
          .from(artikelStandortMindestbestaende)
          .where(sql`${artikelStandortMindestbestaende.geaendertAm} > ${sinceIso}`),
        // Akkutausch: Netzteile — LWW ueber `geaendert_am`.
        db
          .select()
          .from(akkuNetzteile)
          .where(sql`${akkuNetzteile.geaendertAm} > ${sinceIso}`),
        // Akkutausch: Projektakkus — LWW ueber `geaendert_am`.
        db
          .select()
          .from(akkuProjekte)
          .where(sql`${akkuProjekte.geaendertAm} > ${sinceIso}`),
        // Akkutausch: Bestell-Snapshots — filter on server time. A snapshot
        // that was undone after `since` is pulled again, otherwise the undo
        // would never arrive on the other devices.
        db
          .select()
          .from(akkuBestellungen)
          .where(
            or(
              sql`${akkuBestellungen.bestelltAm} > ${sinceIso}`,
              sql`${akkuBestellungen.stornoAm} > ${sinceIso}`,
            ),
          ),
        // Benutzerdefiniertes Bogen-Layout (pro User).
        db
          .select()
          .from(etikettenBogenLayout)
          .where(
            and(
              sql`${etikettenBogenLayout.geaendertAm} > ${sinceIso}`,
              eq(etikettenBogenLayout.userId, user.sub),
            ),
          ),
        // Inventur-Stichtage — append-only, Tabelle ist klein, voller Stand.
        db.select().from(inventurStichtage).orderBy(inventurStichtage.erstelltAm),
        // Inventur-Positionen — voller Stand.
        db.select().from(inventurPositionen).orderBy(inventurPositionen.erstelltAm),
        // Restore-Epoche (null, wenn nie restauriert). Der Client vergleicht
        // sie mit seinem lokalen Marker und baut bei Abweichung die komplette
        // IndexedDB neu auf — inkrementeller Sync kann nach einem pg_restore
        // nie konvergieren (restaurierte Zeilen tragen alte `geaendert_am`,
        // es gibt keine Tombstones, und die Outbox der Vor-Restore-Wuerde
        // geloeschten Stand zurueckpushen).
        leseRestoreEpoch(),
      ])

      return reply.send({
        serverTime: new Date().toISOString(),
        since: since.toISOString(),
        // mindestSince wird mitgeschickt, damit der Client den Marker
        // bei Bedarf aktualisieren kann (z. B. nach Pagination).
        mindestSince: mindestSinceIso,
        // Restore-Epoche — siehe `leseRestoreEpoch()` oben.
        restoreEpoch,
        // Einkaufspreise sind vertraulich und werden nur an Admins
        // ausgeliefert. Fuer alle anderen Rollen steht das Feld auf null.
        artikel: stripEinkaufspreis(
          artikelRows,
          await hatBerechtigung(user.rollen, 'einkaufspreis'),
        ),
        standorte: standortRows,
        commission: projektRows,
        buchungen: buchungRows,
        // Der Rabattsatz des Lieferanten ist dieselbe Information wie der
        // Einkaufspreis — nur Admins bekommen ihn (und dann als Zahl).
        hersteller: mappeHerstellerRabattsatz(
          herstellerRows,
          await hatBerechtigung(user.rollen, 'einkaufspreis'),
        ),
        artikelStandortMindestbestaende: mindestbestandRows.map((r) => ({
          artikelId: r.artikelId,
          standortId: r.standortId,
          mindestbestand: r.mindestbestand,
          geaendertAm: r.geaendertAm.toISOString(),
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        // Akkutausch: Kapazitaeten liegen als NUMERIC in Postgres — der
        // Treiber liefert sie als String, der Client erwartet eine Zahl.
        // `null` bleibt `null` (unvollstaendige Geraete aus CSV-Importen).
        akkuNetzteile: akkuNetzteilRows.map((r) => ({
          id: r.id,
          anlage: r.anlage,
          objekt: r.objekt,
          name: r.name,
          einbaudatum: r.einbaudatum,
          intervallJahre: r.intervallJahre,
          kapazitaetAh: r.kapazitaetAh === null ? null : Number(r.kapazitaetAh),
          anzahl: r.anzahl,
          gruppe: r.gruppe,
          plz: r.plz,
          vdsAnerkennung: r.vdsAnerkennung,
          bemerkung: r.bemerkung,
          geloescht: r.geloescht,
          geaendertAm: r.geaendertAm.toISOString(),
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        akkuProjekte: akkuProjektRows.map((r) => ({
          id: r.id,
          projekt: r.projekt,
          menge: r.menge,
          artAh: Number(r.artAh),
          quartal: r.quartal,
          jahr: r.jahr,
          geloescht: r.geloescht,
          geaendertAm: r.geaendertAm.toISOString(),
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        akkuBestellungen: akkuBestellungRows.map((r) => ({
          id: r.id,
          jahr: r.jahr,
          quartal: r.quartal,
          bestelltAm: r.bestelltAm.toISOString(),
          bestelltVon: r.bestelltVon,
          bestelltVonKuerzel: r.bestelltVonKuerzel,
          inventurDatum: r.inventurDatum,
          inventurVonKuerzel: r.inventurVonKuerzel,
          standortId: r.standortId,
          storno: r.storno,
          stornoAm: r.stornoAm ? r.stornoAm.toISOString() : null,
          stornoVon: r.stornoVon,
          stornoVonKuerzel: r.stornoVonKuerzel,
          zeilen: r.zeilen,
        })),
        inventurStichtage: inventurStichtageRows.map((r) => ({
          id: r.id,
          stichtag: r.stichtag,
          status: r.status,
          festgehaltenVon: r.festgehaltenVon,
          festgehaltenVonName: r.festgehaltenVonName,
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        inventurPositionen: inventurPositionenRows.map((r) => ({
          id: r.id,
          stichtageId: r.stichtageId,
          artikelId: r.artikelId,
          standortId: r.standortId,
          titel: r.titel,
          typ: r.typ,
          verpackungseinheit: r.verpackungseinheit,
          menge: r.menge,
          einkaufspreisCent: r.einkaufspreisCent,
          listenpreisCent: r.listenpreisCent,
          wert: r.wert,
          inventurGeprueft: r.inventurGeprueft,
          negativerBestand: r.negativerBestand,
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        etikettenBogenLayout: etikettenBogenLayoutRows.map((r) => ({
          id: r.id,
          userId: r.userId,
          layout: r.layout,
          geaendertAm: r.geaendertAm.toISOString(),
          erstelltAm: r.erstelltAm.toISOString(),
        })),
        einstellungen: einstellungRows.map((r) => ({
          key: r.key,
          userId: r.userId,
          value: r.value,
          geaendertAm: r.geaendertAm.toISOString(),
        })),
        // Server-only Felder (zustellung_admin_ids, konsumiert_von_mail)
        // werden NICHT mit ausgeliefert — die PWA hat damit nichts zu tun.
        mindestbestandEreignisse: eventRows.map((r) => ({
          id: r.id,
          artikelId: r.artikelId,
          standortId: r.standortId,
          ausloeserBuchungId: r.ausloeserBuchungId,
          bestandDanach: r.bestandDanach,
          mindestbestand: r.mindestbestand,
          defizit: r.defizit,
          erstelltAm: r.erstelltAm.toISOString(),
        })),
      })
    },
  )

  // ---------- GET /api/sync/status ----------
  // Liefert Server-Zeit + Row-Counts pro Tabelle. Wird vom Client genutzt,
  // um die Divergenz zwischen lokaler IndexedDB und Postgres anzuzeigen.
  app.get('/api/sync/status', { preHandler: app.requireAuth }, async (_req, reply) => {
    const db = getDb()
    const counts = await countRows(db)
    return reply.send({
      serverTime: new Date().toISOString(),
      counts,
    })
  })

  // ---------- GET /api/sync/restore-epoch ----------
  // Lightweight probe for the restore epoch. The sync worker calls it BEFORE
  // pushing: a server-side pg_restore replaced the whole database, and the
  // stale local outbox would push pre-restore state back into the restored
  // server. On mismatch the client wipes its IndexedDB and pulls a full
  // snapshot (see src/services/sync/worker.ts).
  app.get('/api/sync/restore-epoch', { preHandler: app.requireAuth }, async (_req, reply) => {
    return reply.send({ restoreEpoch: await leseRestoreEpoch() })
  })

  // ---------- POST /api/sync/device-heartbeat ----------
  // Ein Endgeraet meldet sich mit einer clientseitig erzeugten UUID. Der
  // Server ordnet das Geraet dem angemeldeten User zu und speichert einen
  // Fingerprint. Antwortet mit `needsReset`, wenn das Geraet einen
  // serverseitig ausgeloesten lokalen DB-Reset ausfuehren soll
  // (siehe AGENTS.md "Geraete-Reset"). Der Client merkt sich den zuletzt
  // angewendeten Reset, damit der Befehl genau einmal pro Flag wirksam wird.
  const deviceHeartbeatSchema = z.object({
    deviceId: z.string().min(1).max(128),
    appVersion: z.string().max(64).optional().default(''),
    lastAppliedResetAt: z.string().datetime().optional(),
  })

  app.post(
    '/api/sync/device-heartbeat',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = deviceHeartbeatSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { deviceId, appVersion, lastAppliedResetAt } = parsed.data
      const userId = req.authUser!.sub
      const db = getDb()
      const fingerprint = JSON.stringify({
        userAgent: req.headers['user-agent'],
        appVersion,
        ip: req.ip,
      })
      await db
        .insert(geraete)
        .values({
          id: deviceId,
          userId,
          fingerprint,
          zuletztGesehenAm: new Date(),
        })
        .onConflictDoUpdate({
          target: geraete.id,
          set: {
            userId,
            fingerprint,
            zuletztGesehenAm: new Date(),
          },
        })
      const row = await db
        .select({ resetAm: geraete.resetAm })
        .from(geraete)
        .where(eq(geraete.id, deviceId))
        .limit(1)
      const resetAm = row[0]?.resetAm?.toISOString() ?? null
      let needsReset = resetAm !== null && (!lastAppliedResetAt || resetAm > lastAppliedResetAt)
      // Der Client bestaetigt mit lastAppliedResetAt, dass er den Reset fuer den
      // gegebenen Zeitstempel bereits durchgefuehrt hat. Dann wird das
      // Server-Flag wieder aufgehoben, damit im Entwicklermenue sichtbar
      // bleibt, welche Geraete den Reset noch ausstehen haben und welche
      // ihn erfolgreich durchlaufen haben.
      if (resetAm !== null && lastAppliedResetAt !== undefined && resetAm <= lastAppliedResetAt) {
        await db.update(geraete).set({ resetAm: null }).where(eq(geraete.id, deviceId))
        needsReset = false
      }
      return reply.send({ deviceId, needsReset, resetAm })
    },
  )

  // ---------- POST /api/sync/sync-error-report ----------
  // Ein Client pusht bei einem Sync-Fehler einen strukturierten Report
  // (code, message, diagnostics, ...). Der Server ordnet den Report dem
  // angemeldeten User und seinem Endgeraet zu. Pro Endgeraet werden nur
  // die letzten 2 Reports aufbewahrt (aelteste werden beim Insert geloescht).
  const syncErrorReportSchema = z.object({
    deviceId: z.string().min(1).max(128),
    occurredAt: z.string().datetime(),
    source: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
    httpStatus: z.number().int().optional(),
    stack: z.string().optional(),
    payload: z.record(z.string(), z.any()).optional().nullable(),
    diagnostics: z.record(z.string(), z.any()).optional().nullable(),
  })

  app.post(
    '/api/sync/sync-error-report',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const parsed = syncErrorReportSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { deviceId, occurredAt, source, code, message, httpStatus, stack, payload, diagnostics } =
        parsed.data
      const userId = req.authUser!.sub
      const db = getDb()

      // Geraet muss existieren und dem User gehoeren.
      const device = await db
        .select({ id: geraete.id })
        .from(geraete)
        .where(eq(geraete.id, deviceId))
        .limit(1)
      if (!device[0]) {
        return reply.code(404).send({ code: 'DEVICE_NOT_FOUND', message: 'Endgeraet nicht bekannt' })
      }

      const inserted = await db
        .insert(syncErrorReports)
        .values({
          deviceId,
          userId,
          occurredAt: new Date(occurredAt),
          source,
          code,
          message,
          httpStatus: httpStatus ?? null,
          stack: stack ?? null,
          payload: payload ?? null,
          diagnostics: diagnostics ?? null,
        })
        .returning({ id: syncErrorReports.id, createdAt: syncErrorReports.createdAt })

      const reportId = inserted[0]
      if (!reportId) {
        return reply.code(500).send({ code: 'INSERT_FAILED', message: 'Report konnte nicht gespeichert werden' })
      }

      // Retention: pro Endgeraet nur die letzten 2 Reports behalten (aelteste
      // werden geloescht).
      const all = await db
        .select({ id: syncErrorReports.id })
        .from(syncErrorReports)
        .where(eq(syncErrorReports.deviceId, deviceId))
        .orderBy(syncErrorReports.createdAt)
      if (all.length > 2) {
        const toDelete = all.slice(0, all.length - 2).map((r) => r.id)
        await db.delete(syncErrorReports).where(inArray(syncErrorReports.id, toDelete))
      }

      return reply.send({ id: reportId.id, createdAt: reportId.createdAt.toISOString() })
    },
  )

  // ---------- DELETE /api/sync/sync-error-report ----------
  // Loescht die Sync-Fehler-Reports eines Endgeraets. Der Client ruft das
  // auf, wenn der Sync wieder erfolgreich laeuft — der Fehlerspeicher soll
  // dann wieder leer sein und nicht alte Fehler anzeigen.
  app.delete(
    '/api/sync/sync-error-report',
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const deviceId = (req.query as { deviceId?: unknown } | undefined)?.deviceId
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'deviceId erforderlich' })
      }
      const userId = req.authUser!.sub
      const db = getDb()

      // Geraet muss dem angemeldeten User gehoeren.
      const device = await db
        .select({ id: geraete.id })
        .from(geraete)
        .where(eq(geraete.id, deviceId))
        .limit(1)
      if (!device[0]) {
        return reply.code(404).send({ code: 'DEVICE_NOT_FOUND', message: 'Endgeraet nicht bekannt' })
      }

      // Nur Reports des angemeldeten Users loeschen.
      const deleted = await db
        .delete(syncErrorReports)
        .where(
          and(
            eq(syncErrorReports.deviceId, deviceId),
            eq(syncErrorReports.userId, userId),
          ),
        )
        .returning({ id: syncErrorReports.id })

      return reply.send({ deviceId, deleted: deleted.length })
    },
  )

  // ---------- POST /api/sync/reconcile ----------
  // Cheap existence check for local record IDs. The client uses it to
  // detect rows that exist locally but never reached the server (e.g. after
  // a partial/aborted push or a server-side deletion). Bookings are the
  // default for backward compatibility; master data can be checked by
  // passing `entity`.
  app.post('/api/sync/reconcile', { preHandler: app.requireAuth }, async (req, reply) => {
    const parsed = reconcileSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
    }
    const { ids } = parsed.data
    const db = getDb()
    let presentIds: Set<string>
    switch (parsed.data.entity) {
      case 'artikel': {
        const rows = await db
          .select({ id: artikel.id })
          .from(artikel)
          .where(inArray(artikel.id, ids))
        presentIds = new Set(rows.map((r) => r.id))
        break
      }
      case 'standort': {
        const rows = await db
          .select({ id: standorte.id })
          .from(standorte)
          .where(inArray(standorte.id, ids))
        presentIds = new Set(rows.map((r) => r.id))
        break
      }
      case 'kommission': {
        const rows = await db
          .select({ id: projekte.id })
          .from(projekte)
          .where(inArray(projekte.id, ids))
        presentIds = new Set(rows.map((r) => r.id))
        break
      }
      case 'hersteller': {
        const rows = await db
          .select({ id: hersteller.id })
          .from(hersteller)
          .where(inArray(hersteller.id, ids))
        presentIds = new Set(rows.map((r) => r.id))
        break
      }
      case 'artikel_standort_mindestbestand': {
        // Identitaet ist das Paar (artikelId, standortId) — der Client
        // uebergibt "artikelId#standortId". Wir fragen die beteiligten
        // Artikel-/Standort-IDs ab (Index-Nutzung) und filtern danach
        // auf die tatsaechlich vorhandenen Paare.
        const artikelIds = [
          ...new Set(ids.map((roh) => roh.split('#')[0]).filter((v): v is string => !!v)),
        ]
        const standortIds = [
          ...new Set(ids.map((roh) => roh.split('#')[1]).filter((v): v is string => !!v)),
        ]
        if (artikelIds.length === 0 || standortIds.length === 0) {
          presentIds = new Set()
          break
        }
        const rows = await db
          .select({
            artikelId: artikelStandortMindestbestaende.artikelId,
            standortId: artikelStandortMindestbestaende.standortId,
          })
          .from(artikelStandortMindestbestaende)
          .where(
            and(
              inArray(artikelStandortMindestbestaende.artikelId, artikelIds),
              inArray(artikelStandortMindestbestaende.standortId, standortIds),
            ),
          )
        const vorhanden = new Set(rows.map((r) => `${r.artikelId}#${r.standortId}`))
        presentIds = new Set(ids.filter((roh) => vorhanden.has(roh)))
        break
      }
      case 'buchung':
      default: {
        const rows = await db
          .select({ id: buchungen.id })
          .from(buchungen)
          .where(inArray(buchungen.id, ids))
        presentIds = new Set(rows.map((r) => r.id))
        break
      }
    }
    return reply.send({
      // The client checks this echo: an older server (without `entity`)
      // answers without it — then the client knows that the per-entity
      // ID check is not supported and does not interpret the answer.
      entity: parsed.data.entity,
      present: ids.filter((id) => presentIds.has(id)),
      missing: ids.filter((id) => !presentIds.has(id)),
    })
  })

  // ---------- POST /api/sync/push ----------
  app.post('/api/sync/push', { preHandler: app.requireAuth }, async (req, reply) => {
    // A push during a restore would write the pre-restore state back into
    // the freshly restored tables. The client retries on its next tick.
    if (restoreGesperrt()) {
      return reply.code(503).send({
        code: 'RESTORE_IN_PROGRESS',
        message: 'Es läuft gerade ein Restore — bitte kurz warten.',
      })
    }
    const parsed = pushPayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
    }
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })

    const db = getDb()
    const result = await resolvePush(db, parsed.data.ops, user.sub, user.rollen, notificationGateway)

    return reply.send(result)
  })

  // ---------- POST /api/inventur/abschliessen ----------
  // Friert den Bestand zum Stichtag als Snapshot für die Buchhaltung ein.
  // Idempotent pro Stichtag-Datum: ein zweiter Aufruf für dasselbe Datum
  // liefert den bestehenden Stand zurück, ohne neue Positionen anzulegen.
  app.post('/api/inventur/abschliessen', { preHandler: app.requireAuth }, async (req, reply) => {
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    if (!(await hatBerechtigung(user.rollen, 'inventur.abschliessen'))) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: 'inventur.abschliessen erforderlich' })
    }
    const body = req.body as { stichtag?: string }
    if (!body.stichtag || !/^\d{2}-\d{2}$/.test(body.stichtag)) {
      return reply.code(400).send({ code: 'VALIDATION', message: 'stichtag im Format MM-TT erforderlich' })
    }
    const parts = body.stichtag.split('-')
    const monat = Number.parseInt(parts[0] ?? '', 10)
    const tag = Number.parseInt(parts[1] ?? '', 10)
    const jetzt = new Date()
    // Stichtag = aktuelles Jahr, UTC-Tagesende 23:59:59.999
    const stichtagBis = new Date(Date.UTC(jetzt.getUTCFullYear(), monat - 1, tag, 23, 59, 59, 999))

    const db = getDb()
    const bestehend = await db
      .select({ id: inventurStichtage.id, status: inventurStichtage.status })
      .from(inventurStichtage)
      .where(eq(inventurStichtage.stichtag, body.stichtag))
      .limit(1)
    if (bestehend.length > 0 && bestehend[0]) {
      const posCount = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(inventurPositionen)
        .where(eq(inventurPositionen.stichtageId, bestehend[0].id))
      return reply.send({
        stichtag: body.stichtag,
        status: bestehend[0].status,
        positionen: posCount[0]?.c ?? 0,
        bereitsVorhanden: true,
      })
    }

    // Alle Bestände zum Stichtag: nur nicht-stornierte Buchungen <= Stichtag.
    const bestandRows = await db
      .select({
        artikelId: buchungen.artikelId,
        standortId: buchungen.standortId,
        menge: sql<number>`coalesce(sum(${buchungen.menge}), 0)::int`,
      })
      .from(buchungen)
      .where(
        and(
          eq(buchungen.storno, false),
          sql`${buchungen.erstelltAm} <= ${stichtagBis.toISOString()}`,
        ),
      )
      .groupBy(buchungen.artikelId, buchungen.standortId)

    const artikelIds = [...new Set(bestandRows.map((r) => r.artikelId))]
    const artikelRows = await db
      .select({
        id: artikel.id,
        titel: artikel.titel,
        typ: artikel.typ,
        verpackungseinheit: artikel.verpackungseinheit,
        einkaufspreis: artikel.einkaufspreis,
        listenpreis: artikel.listenpreis,
      })
      .from(artikel)
      .where(inArray(artikel.id, artikelIds))
    const artikelMap = new Map(artikelRows.map((a) => [a.id, a]))

    const stichtageId = randomUUID()
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO inventur_stichtage (id, stichtag, status, festgehalten_von, festgehalten_von_name, erstellt_am)
        VALUES (${stichtageId}, ${body.stichtag!}, 'abgeschlossen', ${user.sub}, NULL, ${now})`)
      for (const row of bestandRows) {
        const art = artikelMap.get(row.artikelId)
        const ve = art?.verpackungseinheit ?? 1
        const ek = art?.einkaufspreis ?? null
        const lp = art?.listenpreis ?? null
        const wert = ek !== null ? Math.round((Number(row.menge) / ve) * ek) : 0
        await tx.execute(sql`INSERT INTO inventur_positionen (id, stichtage_id, artikel_id, standort_id, titel, typ, verpackungseinheit, menge, einkaufspreis_cent, listenpreis_cent, wert, inventur_geprueft, negativer_bestand, erstellt_am)
          VALUES (${randomUUID()}, ${stichtageId}, ${row.artikelId}, ${row.standortId}, ${art?.titel ?? ''}, ${art?.typ ?? ''}, ${ve}, ${Number(row.menge)}, ${ek}, ${lp}, ${wert}, FALSE, ${Number(row.menge) < 0}, ${now})`)
      }
      await tx.execute(sql`INSERT INTO audit_log (id, aktion, entitaet, entitaet_id, benutzer_id, daten, zeit)
        VALUES (${randomUUID()}, 'abschliessen', 'inventur_stichtag', ${stichtageId}, ${user.sub}, ${JSON.stringify({ stichtag: body.stichtag, positionen: bestandRows.length })}, ${now})`)
    })

    return reply.send({
      stichtag: body.stichtag,
      status: 'abgeschlossen',
      positionen: bestandRows.length,
      bereitsVorhanden: false,
    })
  })

  // ---------- POST /api/inventur/archiv ----------
  // Liefert alte Buchungen aus dem Journal mit Filter + Paging.
  // Zeigt alle Buchungstypen (inkl. Stornos) als Historie.
  app.post('/api/inventur/archiv', { preHandler: app.requireAuth }, async (req, reply) => {
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    if (!(await hatBerechtigung(user.rollen, 'inventur.lesen'))) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: 'inventur.lesen erforderlich' })
    }
    const body = req.body as {
      artikelId?: string
      standortId?: string
      standortZielId?: string
      typ?: string
      von?: string
      bis?: string
      erstelltVon?: string
      limit?: number
      offset?: number
    }
    const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 500)
    const offset = Math.max(Number(body.offset ?? 0), 0)

    const db = getDb()
    const conditions: Array<Parameters<typeof and>[0]> = []
    if (body.artikelId) conditions.push(eq(buchungen.artikelId, body.artikelId))
    if (body.standortId) conditions.push(eq(buchungen.standortId, body.standortId))
    if (body.standortZielId) conditions.push(eq(buchungen.standortZielId, body.standortZielId))
    if (body.typ) conditions.push(sql`${buchungen.typ} = ${body.typ}`)
    if (body.erstelltVon) conditions.push(eq(buchungen.erstelltVon, body.erstelltVon))
    if (body.von) conditions.push(sql`${buchungen.erstelltAm} >= ${String(body.von)}`)
    if (body.bis) conditions.push(sql`${buchungen.erstelltAm} <= ${String(body.bis)}`)

    const [rows, countRow] = await Promise.all([
      db
        .select()
        .from(buchungen)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(buchungen.erstelltAm)
        .limit(limit)
        .offset(offset),
      db
        .select({ c: sql<number>`count(*)::int` })
        .from(buchungen)
        .where(conditions.length > 0 ? and(...conditions) : undefined),
    ])

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        artikelId: r.artikelId,
        standortId: r.standortId,
        standortZielId: r.standortZielId,
        typ: r.typ,
        menge: r.menge,
        paarId: r.paarId,
        projekt: r.projekt,
        erstelltAm: r.erstelltAm.toISOString(),
        clientEingabeAm: r.clientEingabeAm?.toISOString() ?? null,
        erstelltVon: r.erstelltVon,
        kommentar: r.kommentar,
        mitteilungAn: r.mitteilungAn,
        stornoVon: r.stornoVon,
        storno: r.storno,
        storniertDurch: r.storniertDurch,
      })),
      limit,
      offset,
      total: countRow[0]?.c ?? 0,
    })
  })
}
