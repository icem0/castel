// Sync-Routes: GET /api/sync/snapshot, GET /api/sync/status, POST /api/sync/push.

import type { FastifyInstance } from 'fastify'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  artikel,
  artikelStandortMindestbestaende,
  akkuBestellungen,
  akkuNetzteile,
  akkuProjekte,
  buchungen,
  einstellungen,
  hersteller,
  mindestbestandEreignisse,
  projekte,
  standorte,
} from '../db/schema.js'
import { pushPayloadSchema, reconcileSchema, snapshotQuerySchema } from '../domain/validierung.js'
import { resolvePush } from './resolver.js'
import { mappeHerstellerRabattsatz, stripEinkaufspreis } from './preise.js'
import type { NotificationGateway } from '../services/notification-gateway.js'

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
}> {
  const [a, s, p, b, h, m, n, q, ab] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(artikel),
    db.select({ c: sql<number>`count(*)::int` }).from(standorte),
    db.select({ c: sql<number>`count(*)::int` }).from(projekte),
    db.select({ c: sql<number>`count(*)::int` }).from(buchungen),
    db.select({ c: sql<number>`count(*)::int` }).from(hersteller),
    db.select({ c: sql<number>`count(*)::int` }).from(artikelStandortMindestbestaende),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuNetzteile),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuProjekte),
    db.select({ c: sql<number>`count(*)::int` }).from(akkuBestellungen),
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
        // Einstellungen: alle globalen + die des eingeloggten Users
        db
          .select()
          .from(einstellungen)
          .where(
            and(
              sql`${einstellungen.geaendertAm} > ${sinceIso}`,
              or(isNull(einstellungen.userId), eq(einstellungen.userId, user.sub)),
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
      ])

      return reply.send({
        serverTime: new Date().toISOString(),
        since: since.toISOString(),
        // mindestSince wird mitgeschickt, damit der Client den Marker
        // bei Bedarf aktualisieren kann (z. B. nach Pagination).
        mindestSince: mindestSinceIso,
        // Einkaufspreise sind vertraulich und werden nur an Admins
        // ausgeliefert. Fuer alle anderen Rollen steht das Feld auf null.
        artikel: stripEinkaufspreis(artikelRows, user.rolle === 'admin'),
        standorte: standortRows,
        commission: projektRows,
        buchungen: buchungRows,
        // Der Rabattsatz des Lieferanten ist dieselbe Information wie der
        // Einkaufspreis — nur Admins bekommen ihn (und dann als Zahl).
        hersteller: mappeHerstellerRabattsatz(herstellerRows, user.rolle === 'admin'),
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
    const parsed = pushPayloadSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
    }
    const user = req.authUser
    if (!user) return reply.code(401).send({ code: 'UNAUTHORIZED' })

    const db = getDb()
    const result = await resolvePush(db, parsed.data.ops, user.sub, user.rolle, notificationGateway)

    return reply.send(result)
  })
}
