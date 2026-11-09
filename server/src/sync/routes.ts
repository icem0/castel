// Sync-Routes: GET /api/sync/snapshot, GET /api/sync/status, POST /api/sync/push.

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  artikel,
  artikelStandortMindestbestaende,
  akkuBestellungen,
  akkuNetzteile,
  akkuProjekte,
  bestand,
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
  users,
} from '../db/schema.js'
import { upsertBestandRow } from '../domain/bestand.js'
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

/**
 * Liefert den Anfang des Sync-Fensters (`inventur.sichtbarAb`) als ISO-String.
 * Nicht gesetzt → Epoche (alles ist sichtbar). Snapshot und Zählung müssen
 * dieselbe Grenze verwenden, sonst meldet der Client falsche Divergenzen.
 */
async function leseSyncFensterIso(db: ReturnType<typeof getDb>): Promise<string> {
  const row = await db
    .select({ value: einstellungen.value })
    .from(einstellungen)
    .where(and(eq(einstellungen.key, 'inventur.sichtbarAb'), isNull(einstellungen.userId)))
    .limit(1)
  return row[0]?.value ?? '1970-01-01T00:00:00.000Z'
}

async function countRows(
  db: ReturnType<typeof getDb>,
  fensterIso: string,
): Promise<{
  artikel: number
  standorte: number
  commission: number
  buchungen: number
  bestand: number
  hersteller: number
  artikelStandortMindestbestand: number
  akkuNetzteile: number
  akkuProjekte: number
  akkuBestellungen: number
  etikettenBogenLayout: number
  inventurStichtage: number
  inventurPositionen: number
}> {
  const [a, s, p, b, bs, h, m, n, q, ab, ebl, ist, ip] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(artikel),
    db.select({ c: sql<number>`count(*)::int` }).from(standorte),
    db.select({ c: sql<number>`count(*)::int` }).from(projekte),
    // Buchungen nur ab dem Sync-Fenster — genau wie der Snapshot sie ausliefert.
    // Aeltere bleiben im Journal, werden aber nicht an Clients gesendet.
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(buchungen)
      .where(sql`${buchungen.erstelltAm} >= ${fensterIso}`),
    db.select({ c: sql<number>`count(*)::int` }).from(bestand),
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
    bestand: bs[0]?.c ?? 0,
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

      // Sync-Fenster: Buchungen, die älter sind als `inventur.sichtbarAb`
      // (serverseitig gesetzt durch den Rebase-Endpunkt), werden nicht mehr
      // an Clients ausgeliefert — sie verbleiben im Archiv auf dem Server.
      // Nicht gesetzt → alles wird ausgeliefert (Vor-Rebase-Zustand).
      const fensterIso = await leseSyncFensterIso(db)

      const [
        artikelRows,
        standortRows,
        projektRows,
        buchungRows,
        bestandRows,
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
          .where(
            and(
              sql`${buchungen.erstelltAm} > ${sinceIso}`,
              sql`${buchungen.erstelltAm} >= ${fensterIso}`,
            ),
          ),
        db.select().from(bestand).where(sql`${bestand.geaendertAm} > ${sinceIso}`),
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

      // Confidentiality of the inventory snapshot: without `inventur.lesen`
      // the tables stay empty, and the purchase prices and the value
      // columns (`einkaufreensCent`, `wert`) in `inventurPositionen` are
      // only delivered with the `einkaufpreis` permission — analogously to
      // the `artikel` and `hersteller` mapping below (SEC-004).
      const hatInventurLesen = await hatBerechtigung(user.rollen, 'inventur.lesen')
      const hatEinkaufpreis = await hatBerechtigung(user.rollen, 'einkaufpreis')

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
        bestand: bestandRows.map((r) => ({
          artikelId: r.artikelId,
          standortId: r.standortId,
          menge: r.menge,
          geaendertAm: r.geaendertAm.toISOString(),
        })),
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
        inventurStichtage: (hatInventurLesen ? inventurStichtageRows : []).map((r) => {
          // Spalte speichert das gelöste Voll-Datum (YYYY-MM-DD), das Client-
          // Kontrakt ist DD.MM.YYYY — letzteres daraus ableiten.
          const [j, m, t] = r.stichtag.split('-')
          return {
            id: r.id,
            stichtag: `${t}.${m}.${j}`,
            status: r.status,
            festgehaltenVon: r.festgehaltenVon,
            festgehaltenVonName: r.festgehaltenVonName,
            erstelltAm: r.erstelltAm.toISOString(),
          }
        }),
        inventurPositionen: (hatInventurLesen ? inventurPositionenRows : []).map((r) => ({
          id: r.id,
          stichtageId: r.stichtageId,
          artikelId: r.artikelId,
          standortId: r.standortId,
          titel: r.titel,
          typ: r.typ,
          verpackungseinheit: r.verpackungseinheit,
          menge: r.menge,
          einkaufspreisCent: hatEinkaufpreis ? r.einkaufspreisCent : null,
          listenpreisCent: r.listenpreisCent,
          wert: hatEinkaufpreis ? r.wert : null,
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
    const counts = await countRows(db, await leseSyncFensterIso(db))
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
      // Ownership: the device row follows the user who logs in last (a
      // shared browser changes the owner — the heartbeat must not fail
      // there). The admin's reset flag, however, belongs to the device and
      // is neither delivered to nor cleared by a foreign user (SEC-011).
      const owner = await db
        .select({ userId: geraete.userId })
        .from(geraete)
        .where(eq(geraete.id, deviceId))
        .limit(1)
      const istEigenesGeraet = !owner[0] || owner[0].userId === userId
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
      // The reset flag is only handed to the device's own user.
      const resetAm = istEigenesGeraet ? (row[0]?.resetAm?.toISOString() ?? null) : null
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
    // The client sends explicit nulls (e.g. divergence reports have no HTTP
    // status and no stack). Strict `.optional()` rejected them with 400 and
    // the report was silently dropped.
    httpStatus: z.number().int().nullish(),
    stack: z.string().nullish(),
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
        .select({ id: geraete.id, userId: geraete.userId })
        .from(geraete)
        .where(eq(geraete.id, deviceId))
        .limit(1)
      if (!device[0]) {
        return reply.code(404).send({ code: 'DEVICE_NOT_FOUND', message: 'Endgeraet nicht bekannt' })
      }
      if (device[0].userId !== userId) {
        // The device row follows the user who logged in last (shared
        // browser). Reports of the previous owner stay valid — only a user
        // who never reported for this device may not plant a report on it
        // (SEC-010).
        const eigene = await db
          .select({ id: syncErrorReports.id })
          .from(syncErrorReports)
          .where(
            and(
              eq(syncErrorReports.deviceId, deviceId),
              eq(syncErrorReports.userId, userId),
            ),
          )
          .limit(1)
        if (eigene.length === 0) {
          return reply
            .code(403)
            .send({ code: 'DEVICE_FOREIGN', message: 'Endgerät gehört einem anderen Benutzer' })
        }
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
      app.log.warn(
        { userId: req.authUser?.sub, issues: parsed.error.issues },
        '[sync/push] SCHEMA_MISMATCH — ganzer Batch abgelehnt',
      )
      return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
    }
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })

    const db = getDb()
    const deviceId = parsed.data.deviceId
    const result = await resolvePush(db, parsed.data.ops, user.sub, user.rollen, notificationGateway, app.log)

    // Serverseitiges Logging aller per-Op-Fehler und Konflikte — auch wenn
    // der Client keinen eigenen sync-error-report nachschickt (z. B. weil
    // er offline ist oder der Report-Versand fehlschlägt).
    if (result.errors.length > 0 || result.conflicts.length > 0) {
      app.log.warn(
        {
          userId: user.sub,
          deviceId: deviceId ?? null,
          errorCount: result.errors.length,
          conflictCount: result.conflicts.length,
          errorCodes: result.errors.map((e) => e.code),
          conflictReasons: result.conflicts.map((c) => c.reason),
        },
        `[sync/push] ${result.errors.length} Fehler, ${result.conflicts.length} Konflikte`,
      )

      // sync_error_reports-Fallback: wenn der Client seine deviceId mitschickt,
      // schreibt der Server selbst einen Report pro Fehler — damit der Fehler
      // auch dann im System landet, wenn der Client keinen eigenen Report
      // absetzt (offline, Report-Versand fehlgeschlagen, etc.).
      if (deviceId) {
        const now = new Date()
        try {
          // Ownership: reports may only be filed for a device of the
          // calling user (SEC-010).
          const dev = await db
            .select({ userId: geraete.userId })
            .from(geraete)
            .where(eq(geraete.id, deviceId))
            .limit(1)
          if (dev[0] && dev[0].userId !== user.sub) {
            app.log.warn(
              { userId: user.sub, deviceId },
              '[sync/push] sync_error_reports-Fallback uebersprungen (Geraet gehoert einem anderen User)',
            )
            return reply.send(result)
          }
          for (const err of result.errors) {
            await db
              .insert(syncErrorReports)
              .values({
                deviceId,
                userId: user.sub,
                occurredAt: now,
                source: 'sync/push',
                code: err.code,
                message: err.message,
                httpStatus: null,
                stack: err.stack ?? null,
                payload: err.payload ?? null,
                diagnostics: null,
              })
          }
          // Auch Konflikte (z. B. UNRESOLVED_DIVERGENCE) als Report speichern,
          // damit der Admin sie im Overblick sieht.
          for (const conflict of result.conflicts) {
            await db
              .insert(syncErrorReports)
              .values({
                deviceId,
                userId: user.sub,
                occurredAt: now,
                source: 'sync/push',
                code: 'CONFLICT',
                message: conflict.reason,
                httpStatus: null,
                stack: null,
                payload: null,
                diagnostics: null,
              })
          }
          // Retention: pro Endgeraet nur die letzten 20 serverseitigen Reports
          // behalten (aelteste werden geloescht), damit die Tabelle nicht
          // unkontrolliert waechst.
          const all = await db
            .select({ id: syncErrorReports.id, createdAt: syncErrorReports.createdAt })
            .from(syncErrorReports)
            .where(eq(syncErrorReports.deviceId, deviceId))
            .orderBy(syncErrorReports.createdAt)
          if (all.length > 20) {
            const toDelete = all.slice(0, all.length - 20).map((r) => r.id)
            await db.delete(syncErrorReports).where(inArray(syncErrorReports.id, toDelete))
          }
        } catch (e) {
          // Der Fehler-Report darf den Push-Antwort nicht blockieren.
          app.log.error({ err: e, deviceId, userId: user.sub }, '[sync/push] sync_error_reports-Fallback fehlgeschlagen')
        }
      }
    }

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
    if (!body.stichtag || !/^\d{2}\.\d{2}\.\d{4}$/.test(body.stichtag)) {
      return reply.code(400).send({ code: 'VALIDATION', message: 'stichtag im Format DD.MM.YYYY erforderlich' })
    }
    const parts = body.stichtag.split('.')
    const tag = Number.parseInt(parts[0] ?? '', 10)
    const monat = Number.parseInt(parts[1] ?? '', 10)
    const jahr = Number.parseInt(parts[2] ?? '', 10)
    // Calendar check: the format regex alone accepts dates that do not
    // exist (31.02.2026) — PostgreSQL would then abort with
    // "invalid input syntax for type date" (500) (SEC-026).
    const probe = new Date(Date.UTC(jahr, monat - 1, tag))
    if (
      Number.isNaN(probe.getTime()) ||
      probe.getUTCFullYear() !== jahr ||
      probe.getUTCMonth() !== monat - 1 ||
      probe.getUTCDate() !== tag
    ) {
      return reply
        .code(400)
        .send({ code: 'VALIDATION', message: 'stichtag ist kein gültiges Kalenderdatum' })
    }
    // Stichtag = gelöstes Voll-Datum YYYY-MM-DD in der DATE-Spalte (Jahr kommt
    // aus dem eingegebenen DD.MM.YYYY), der Query-Filter läuft bis
    // UTC-Tagesende 23:59:59.999.
    const stichtagFull = `${String(jahr).padStart(4, '0')}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`
    const stichtagBis = new Date(Date.UTC(jahr, monat - 1, tag, 23, 59, 59, 999))

    const db = getDb()
    const bestehend = await db
      .select({ id: inventurStichtage.id, status: inventurStichtage.status })
      .from(inventurStichtage)
      .where(eq(inventurStichtage.stichtag, stichtagFull))
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
        VALUES (${stichtageId}, ${stichtagFull}, 'abgeschlossen', ${user.sub}, NULL, ${now.toISOString()})`)
      for (const row of bestandRows) {
        const art = artikelMap.get(row.artikelId)
        const ve = art?.verpackungseinheit ?? 1
        const ek = art?.einkaufspreis ?? null
        const lp = art?.listenpreis ?? null
        const wert = ek !== null ? Math.round((Number(row.menge) / ve) * ek) : 0
        await tx.execute(sql`INSERT INTO inventur_positionen (id, stichtage_id, artikel_id, standort_id, titel, typ, verpackungseinheit, menge, einkaufspreis_cent, listenpreis_cent, wert, inventur_geprueft, negativer_bestand, erstellt_am)
          VALUES (${randomUUID()}, ${stichtageId}, ${row.artikelId}, ${row.standortId}, ${art?.titel ?? ''}, ${art?.typ ?? ''}, ${ve}, ${Number(row.menge)}, ${ek}, ${lp}, ${wert}, FALSE, ${Number(row.menge) < 0}, ${now.toISOString()})`)
      }
      await tx.execute(sql`INSERT INTO audit_log (id, aktion, entitaet, entitaet_id, benutzer_id, daten, zeit)
        VALUES (${randomUUID()}, 'abschliessen', 'inventur_stichtag', ${stichtageId}, ${user.sub}, ${JSON.stringify({ stichtag: body.stichtag, positionen: bestandRows.length })}, ${now.toISOString()})`)
    })

    return reply.send({
      stichtag: body.stichtag,
      status: 'abgeschlossen',
      positionen: bestandRows.length,
      bereitsVorhanden: false,
    })
  })

  // ---------- POST /api/inventur/rebase ----------
  // Nimmt den aktuellen Bestand je (Artikel, Standort) als Basis ("Bestand
  // übernehmen"): legt für Paare ohne nicht-stornierte Inventur-Buchung der
  // letzten 10 Tage eine Inventur-Marker-Buchung (Menge 0, Basislinie) an,
  // friert die aktuellen Werte in der materialisierten `bestand`-Tabelle ein
  // und verschiebt das Sync-Fenster `inventur.sichtbarAb` auf jetzt. Ältere
  // Buchungen bleiben serverseitig im Archiv und werden nicht mehr an
  // Clients ausgeliefert (PWA-Datensatz wird nicht aufgebläht).
  app.post('/api/inventur/rebase', { preHandler: app.requireAuth }, async (req, reply) => {
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    if (!(await hatBerechtigung(user.rollen, 'inventur.abschliessen'))) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: 'inventur.abschliessen erforderlich' })
    }

    const jetzt = new Date()
    const zehnTageMs = 10 * 24 * 60 * 60 * 1000
    const db = getDb()

    const [artikelRows, standortRows] = await Promise.all([
      db.select({ id: artikel.id }).from(artikel),
      db.select({ id: standorte.id }).from(standorte),
    ])

    // Aktueller Bestand je Paar aus dem gesamten Journal (nicht storniert).
    const sumRows = await db
      .select({
        artikelId: buchungen.artikelId,
        standortId: buchungen.standortId,
        menge: sql<number>`coalesce(sum(${buchungen.menge}), 0)::int`,
      })
      .from(buchungen)
      .where(eq(buchungen.storno, false))
      .groupBy(buchungen.artikelId, buchungen.standortId)
    const sumMap = new Map<string, number>()
    for (const r of sumRows) sumMap.set(`${r.artikelId}#${r.standortId}`, Number(r.menge))

    // Neueste nicht-stornierte Inventur-Buchung je Paar (bestehende Basislinie).
    const markerRows = await db
      .select({
        artikelId: buchungen.artikelId,
        standortId: buchungen.standortId,
        latest: sql<Date>`max(${buchungen.erstelltAm})`,
      })
      .from(buchungen)
      .where(and(eq(buchungen.typ, 'inventur'), eq(buchungen.storno, false)))
      .groupBy(buchungen.artikelId, buchungen.standortId)
    const latestMarker = new Map<string, Date>()
    for (const r of markerRows) {
      if (!r.latest) continue
      const d = r.latest instanceof Date ? r.latest : new Date(r.latest)
      if (Number.isNaN(d.getTime())) continue
      latestMarker.set(`${r.artikelId}#${r.standortId}`, d)
    }

    const bestandZeilen: Array<{ artikelId: string; standortId: string; menge: number }> = []
    let erstellteMarker = 0
    let uebersprungeneMarker = 0

    for (const a of artikelRows) {
      for (const s of standortRows) {
        const menge = sumMap.get(`${a.id}#${s.id}`) ?? 0
        bestandZeilen.push({ artikelId: a.id, standortId: s.id, menge })
        const letzte = latestMarker.get(`${a.id}#${s.id}`)
        if (letzte instanceof Date && jetzt.getTime() - letzte.getTime() <= zehnTageMs) {
          uebersprungeneMarker += 1
          continue
        }
        // Marker-Buchung mit Menge 0: dokumentiert die Inventur, verändert
        // den Bestand nicht und wird vom Client als Basislinie gesehen.
        await db
          .insert(buchungen)
          .values({
            id: randomUUID(),
            artikelId: a.id,
            standortId: s.id,
            standortZielId: null,
            typ: 'inventur',
            menge: 0,
            paarId: null,
            projekt: null,
            erstelltAm: jetzt,
            clientEingabeAm: jetzt,
            erstelltVon: user.sub,
            kommentar: null,
            mitteilungAn: null,
            stornoVon: null,
            storno: false,
            storniertDurch: null,
          } as never)
        erstellteMarker += 1
      }
    }

    const fensterAb = jetzt.toISOString()
    await db.transaction(async (tx) => {
      // Materialisierten Bestand für alle Paare auf den aktuellen Stand bringen.
      for (const z of bestandZeilen) {
        await upsertBestandRow(tx, z.artikelId, z.standortId, z.menge)
      }
      // Sync-Fenster setzen (server-interner Key, nie an Clients ausgeliefert).
      await tx.execute(sql`INSERT INTO einstellungen (key, user_id, value, geaendert_am)
        VALUES ('inventur.sichtbarAb', NULL, ${fensterAb}, ${jetzt.toISOString()})
        ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE SET value = EXCLUDED.value, geaendert_am = EXCLUDED.geaendert_am`)
      const rebaseId = randomUUID()
      await tx.execute(sql`INSERT INTO audit_log (id, aktion, entitaet, entitaet_id, benutzer_id, daten, zeit)
        VALUES (${randomUUID()}, 'inventur.rebase', 'bestand', ${rebaseId}, ${user.sub},
          ${JSON.stringify({ marker: erstellteMarker, uebersprungen: uebersprungeneMarker, paare: bestandZeilen.length, fensterAb })}, ${jetzt.toISOString()})`)
    })

    return reply.send({
      erstellteMarker,
      uebersprungeneMarker,
      paare: bestandZeilen.length,
      fensterAb,
    })
  })

  // ---------- GET /api/inventur/archiv/optionen ----------
  // Liefert die Filter-Optionen für das Buchungsarchiv: Artikel, Standorte, User.
  app.get('/api/inventur/archiv/optionen', { preHandler: app.requireAuth }, async (req, reply) => {
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })
    if (!(await hatBerechtigung(user.rollen, 'inventur.lesen'))) {
      return reply.code(403).send({ code: 'FORBIDDEN', message: 'inventur.lesen erforderlich' })
    }

    const db = getDb()

    const [artikelListe, standorteListe, userListe] = await Promise.all([
      db.select({ id: artikel.id, titel: artikel.titel }).from(artikel).orderBy(artikel.titel),
      db.select({ id: standorte.id, name: standorte.name }).from(standorte).orderBy(standorte.name),
      db
        .select({ id: users.id, anzeigename: users.anzeigename })
        .from(users)
        .orderBy(users.anzeigename),
    ])

    return reply.send({
      artikel: artikelListe.map((a) => ({ id: a.id, label: a.titel ?? a.id })),
      standorte: standorteListe.map((s) => ({ id: s.id, label: s.name ?? s.id })),
      // No e-mail address: the filter list is not a user directory (SEC-012).
      user: userListe.map((u) => ({
        id: u.id,
        label: u.anzeigename || u.id,
      })),
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
      projekt?: string
      limit?: number
      offset?: number
    }
    const limit = Math.min(Math.max(Number(body.limit ?? 50), 1), 10000)
    // Offset is capped: a huge offset forces the database to scan (and
    // discard) the whole journal on every request (SEC-013).
    const offset = Math.min(Math.max(Number(body.offset ?? 0), 0), 100_000)
    // Date filters must be ISO dates — otherwise PostgreSQL aborts with
    // "invalid input syntax" (500) on every request (SEC-013).
    const isoDatum = /^\d{4}-\d{2}-\d{2}([T ].*)?$/
    if ((body.von && !isoDatum.test(body.von)) || (body.bis && !isoDatum.test(body.bis))) {
      return reply.code(400).send({
        code: 'VALIDATION',
        message: 'von/bis müssen ISO-Daten sein (YYYY-MM-DD)',
      })
    }

    const db = getDb()
    const conditions: Array<Parameters<typeof and>[0]> = []
    if (body.artikelId) conditions.push(eq(buchungen.artikelId, body.artikelId))
    if (body.standortId) conditions.push(eq(buchungen.standortId, body.standortId))
    if (body.standortZielId) conditions.push(eq(buchungen.standortZielId, body.standortZielId))
    if (body.typ) conditions.push(sql`${buchungen.typ} = ${body.typ}`)
    if (body.projekt) conditions.push(sql`${buchungen.projekt} = ${body.projekt}`)
    if (body.erstelltVon) conditions.push(eq(buchungen.erstelltVon, body.erstelltVon))
    if (body.von) conditions.push(sql`${buchungen.erstelltAm} >= ${String(body.von)}`)
    if (body.bis) conditions.push(sql`${buchungen.erstelltAm} <= ${String(body.bis)}`)

    const [rows, countRow] = await Promise.all([
      db
        .select({
          id: buchungen.id,
          artikelId: buchungen.artikelId,
          standortId: buchungen.standortId,
          standortZielId: buchungen.standortZielId,
          typ: buchungen.typ,
          menge: buchungen.menge,
          paarId: buchungen.paarId,
          projekt: buchungen.projekt,
          erstelltAm: buchungen.erstelltAm,
          clientEingabeAm: buchungen.clientEingabeAm,
          erstelltVon: buchungen.erstelltVon,
          kommentar: buchungen.kommentar,
          mitteilungAn: buchungen.mitteilungAn,
          stornoVon: buchungen.stornoVon,
          storno: buchungen.storno,
          storniertDurch: buchungen.storniertDurch,
          artikelTitel: artikel.titel,
          standortName: standorte.name,
        })
        .from(buchungen)
        .leftJoin(artikel, eq(buchungen.artikelId, artikel.id))
        .leftJoin(standorte, eq(buchungen.standortId, standorte.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(buchungen.erstelltAm))
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
        artikelTitel: r.artikelTitel ?? null,
        standortName: r.standortName ?? null,
      })),
      limit,
      offset,
      total: countRow[0]?.c ?? 0,
    })
  })
}
