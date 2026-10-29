// Admin-Routes: Bulk-Werkzeuge fuer den Entwickler-Bereich (nur Admins).
//
//   * POST /api/admin/buchungen/filter            - filtert Buchungen nach
//                                                    Artikel, Standort,
//                                                    Datumsbereich, Typ, etc.
//   * POST /api/admin/buchungen/bulk-delete        - Sicherheitsabfrage:
//                                                    zaehlt die getroffenen
//                                                    Buchungen, loescht NICHT.
//   * POST /api/admin/buchungen/execute-bulk-delete - fuehrt die Loeschung aus.
//   * POST /api/admin/standorte/bulk-rename         - benennt mehrere Standorte um.
//   * POST /api/admin/standorte/bulk-archive         - archiviert / holt mehrere
//                                                    Standorte zurueck. Das
//                                                    Hauptlager (standard) ist
//                                                    geschuetzt und wird abgelehnt.

import type { FastifyInstance } from 'fastify'
import { and, count, eq, gte, inArray, lte, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { artikel, buchungen, standorte } from '../db/schema.js'

type FilterBody = {
  artikelId?: string
  standortId?: string
  typ?: string
  datumVon?: string
  datumBis?: string
  storno?: boolean
  projekt?: string
}

export async function bulkBookingRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/buchungen/filter
  app.post(
    '/api/admin/buchungen/filter',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()

      const { artikelId, standortId, typ, datumVon, datumBis, storno, projekt } =
        req.body as FilterBody

      const conditions: SQL[] = []
      if (artikelId) conditions.push(eq(buchungen.artikelId, artikelId))
      if (standortId) conditions.push(eq(buchungen.standortId, standortId))
      if (typ) conditions.push(eq(buchungen.typ, typ as never))
      if (datumVon) conditions.push(gte(buchungen.erstelltAm, new Date(datumVon)))
      if (datumBis) conditions.push(lte(buchungen.erstelltAm, new Date(datumBis)))
      if (storno !== undefined) conditions.push(eq(buchungen.storno, storno))
      if (projekt) conditions.push(eq(buchungen.projekt, projekt))
      const where = conditions.length > 0 ? and(...conditions) : undefined

      const rows = await db
        .select({
          id: buchungen.id,
          artikelId: buchungen.artikelId,
          artikelTitel: artikel.titel,
          standortId: buchungen.standortId,
          standortName: standorte.name,
          typ: buchungen.typ,
          menge: buchungen.menge,
          erstelltAm: buchungen.erstelltAm,
          clientEingabeAm: buchungen.clientEingabeAm,
          erstelltVon: buchungen.erstelltVon,
          storno: buchungen.storno,
          stornoVon: buchungen.stornoVon,
          storniertDurch: buchungen.storniertDurch,
          projekt: buchungen.projekt,
        })
        .from(buchungen)
        .leftJoin(artikel, eq(buchungen.artikelId, artikel.id))
        .leftJoin(standorte, eq(buchungen.standortId, standorte.id))
        .where(where)
        .orderBy(buchungen.erstelltAm)

      // Auswahlmoeglichkeiten fuer die Filter-Felder im UI.
      const [artikelOptionen, standortOptionen, typRows] = await Promise.all([
        db.select({ id: artikel.id, titel: artikel.titel }).from(artikel).orderBy(artikel.titel),
        db.select({ id: standorte.id, name: standorte.name }).from(standorte).orderBy(standorte.name),
        db
          .selectDistinct({ typ: buchungen.typ })
          .from(buchungen)
          .orderBy(buchungen.typ),
      ])

      return reply.send({
        buchungen: rows.map((b) => ({
          ...b,
          erstelltAm: b.erstelltAm.toISOString(),
          clientEingabeAm: b.clientEingabeAm?.toISOString() ?? null,
        })),
        filterOptions: {
          artikel: artikelOptionen,
          standorte: standortOptionen,
          typen: typRows.map((t) => t.typ),
        },
      })
    },
  )

  // POST /api/admin/buchungen/bulk-delete
  // Sicherheitsabfrage: prueft die IDs und liefert die Anzahl, ohne zu loeschen.
  app.post(
    '/api/admin/buchungen/bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids } = req.body as { ids: string[] }

      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'Keine IDs angegeben' })
      }

      const db = getDb()
      const anzahl = await db
        .select({ c: count() })
        .from(buchungen)
        .where(inArray(buchungen.id, ids))

      return reply.send({ count: anzahl[0]?.c ?? 0, ids })
    },
  )

  // POST /api/admin/buchungen/execute-bulk-delete
  app.post(
    '/api/admin/buchungen/execute-bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids } = req.body as { ids: string[] }

      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'Keine IDs angegeben' })
      }

      const db = getDb()
      const deleted = await db
        .delete(buchungen)
        .where(inArray(buchungen.id, ids))
        .returning({ id: buchungen.id })

      return reply.send({ deletedCount: deleted.length })
    },
  )

  // POST /api/admin/standorte/bulk-rename
  app.post(
    '/api/admin/standorte/bulk-rename',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids, newName } = req.body as { ids: string[]; newName: string }

      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'Keine Standorte ausgewaehlt' })
      }
      if (!newName || newName.trim().length === 0) {
        return reply
          .code(400)
          .send({ code: 'VALIDATION', message: 'Neuer Name ist erforderlich' })
      }

      const db = getDb()
      const updated = await db
        .update(standorte)
        .set({ name: newName.trim(), geaendertAm: new Date() })
        .where(inArray(standorte.id, ids))
        .returning({ id: standorte.id })

      return reply.send({ success: true, updated: updated.length })
    },
  )

  // POST /api/admin/standorte/bulk-archive
  // Das Hauptlager (standard = true) ist geschuetzt und darf nicht archiviert
  // werden (PROTECTED_STANDORT). Wird es ausgewaehlt, bricht der Request ab.
  app.post(
    '/api/admin/standorte/bulk-archive',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const { ids, archiviert } = req.body as { ids: string[]; archiviert: boolean }

      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ code: 'VALIDATION', message: 'Keine Standorte ausgewaehlt' })
      }

      const db = getDb()

      const geschuetzt = await db
        .select({ id: standorte.id })
        .from(standorte)
        .where(and(inArray(standorte.id, ids), eq(standorte.standard, true)))

      if (geschuetzt.length > 0) {
        return reply.code(409).send({
          code: 'PROTECTED_STANDORT',
          message: 'Standardlager darf nicht archiviert werden',
        })
      }

      const updated = await db
        .update(standorte)
        .set({ archiviert, geaendertAm: new Date() })
        .where(inArray(standorte.id, ids))
        .returning({ id: standorte.id })

      return reply.send({ success: true, updated: updated.length })
    },
  )
}
