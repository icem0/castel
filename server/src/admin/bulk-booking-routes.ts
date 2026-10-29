// Admin-Routes: Werkzeuge, die nur fuer Admins erreichbar sind.
//
// Neu:
//   * POST /api/admin/buchungen/filter     - filtert Buchungen basierend auf Artikeln,
//                                            Standorten, Datumsbereichen, Typ, etc.
//   * POST /api/admin/buchungen/bulk-delete - löscht mehrere Buchungen mit Sicherheitsabfrage

import type { FastifyInstance } from 'fastify'
import { and, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  artikel,
  buchungen,
  einstellungen,
  standorte,
} from '../db/schema.js'
import { istInterneEinstellung } from './einstellungen-intern.js'

export async function bulkBookingRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/buchungen/filter
  app.post(
    '/api/admin/buchungen/filter',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()

      // Query parameters for filtering
      const {
        artikelId,
        standortId,
        typ,
        datumVon,
        datumBis,
        storno,
        projekt,
        begrenzt,
        page = 1,
        pageSize = 100,
      } = req.body as {
        artikelId?: string
        standortId?: string
        typ?: string
        datumVon?: string
        datumBis?: string
        storno?: boolean
        projekt?: string
        begrenzt?: boolean
        page: number
        pageSize: number
      }

      // Build where conditions
      const conditions = []

      if (artikelId) {
        conditions.push(eq(buchungen.artikelId, artikelId))
      }

      if (standortId) {
        conditions.push(eq(buchungen.standortId, standortId))
      }

      if (typ) {
        conditions.push(eq(buchungen.typ, typ))
      }

      if (datumVon) {
        const vonDate = new Date(datumVon)
        conditions.push(sql`${buchungen.erstelltAm} >= ${vonDate.toISOString()}`)
      }

      if (datumBis) {
        const bisDate = new Date(datumBis)
        conditions.push(sql`${buchungen.erstelltAm} <= ${bisDate.toISOString()}`)
      }

      if (storno !== undefined) {
        conditions.push(eq(buchungen.storno, storno))
      }

      if (projekt) {
        conditions.push(eq(buchungen.projekt, projekt))
      }

      if (begrenzt !== undefined) {
        // When limited is true, only show active bookings (non-storno)
        conditions.push(eq(buchungen.storno, false))
      }

      // Build the base query
      let baseQuery = db
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

      if (conditions.length > 0) {
        baseQuery = baseQuery.where(and(...conditions))
      }

      // Count total for pagination
      const countQuery = db
        .select({ count: count() })
        .from(buchungen)
        .leftJoin(artikel, eq(buchungen.artikelId, artikel.id))
        .leftJoin(standorte, eq(buchungen.standortId, standorte.id))

      if (conditions.length > 0) {
        countQuery.where(and(...conditions))
      }

      const [{ count: total }] = await countQuery

      // Apply pagination
      const offset = (page - 1) * pageSize
      const buchungenQuery = baseQuery
        .orderBy(buchungen.erstelltAm)
        .limit(pageSize)
        .offset(offset)

      const filteredBuchungen = await buchungenQuery

      // Get unique articles and locations for filter dropdowns
      const artikelnFilter = await db
        .select({ id: artikel.id, titel: artikel.titel })
        .from(artikel)
        .orderBy(artikel.titel)
        .limit(50)

      const standorteFilter = await db
        .select({ id: standorte.id, name: standorte.name })
        .from(standorte)
        .orderBy(standorte.name)
        .limit(50)

      // Get booking types for filter dropdown
      const typenSet = new Set<string>()
      const allBuchungen = await db.select({ typ: buchungen.typ }).from(buchungen)
      allBuchungen.forEach((b) => typenSet.add(b.typ))

      const buchungTypen = Array.from(typenSet).sort()

      return reply.send({
        buchungen: filteredBuchungen.map((b) => ({
          id: b.id,
          artikelId: b.artikelId,
          artikelTitel: b.artikelTitel,
          standortId: b.standortId,
          standortName: b.standortName,
          typ: b.typ,
          menge: b.menge,
          erstelltAm: b.erstelltAm.toISOString(),
          clientEingabeAm: b.clientEingabeAm?.toISOString() || null,
          erstelltVon: b.erstelltVon,
          storno: b.storno,
          stornoVon: b.stornoVon,
          storniertDurch: b.storniertDurch,
          projekt: b.projekt,
        })),
        pagination: {
          page,
          pageSize,
          total,
          pages: Math.ceil(total / pageSize),
        },
        filterOptions: {
          artikel: artikelnFilter,
          standorte: standorteFilter,
          typen: buchungTypen,
        },
      })
    },
  )

  // POST /api/admin/buchungen/bulk-delete
  app.post(
    '/api/admin/buchungen/bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const db = getDb()

      // Check server internal settings first
      const { bulkDeleteAllowed } = req.body as {
        bulkDeleteAllowed?: boolean
      }

      if (!bulkDeleteAllowed) {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'Bitte bestätigen Sie die Löschung durch Setzen von bulkDeleteAllowed auf true',
        })
      }

      const { buchungsIds } = req.body as {
        buchungsIds: string[]
      }

      if (!Array.isArray(buchungsIds) || buchungsIds.length === 0) {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'Bitte geben Sie mindestens eine Buchungs-ID zum Löschen an',
        })
      }

      if (buchungsIds.length > 1000) {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'Sie können maximal 1000 Buchungen gleichzeitig löschen',
        })
      }

      // Check if all bookings exist
      const existingBuchungen = await db
        .select({
          id: buchungen.id,
          artikelId: buchungen.artikelId,
          standortId: buchungen.standortId,
          storno: buchungen.storno,
        })
        .from(buchungen)
        .where(inArray(buchungen.id, buchungsIds))

      if (existingBuchungen.length !== buchungsIds.length) {
        const gefundeneIds = new Set(existingBuchungen.map((b) => b.id))
        const nichtGefundeneIds = buchungsIds.filter((id) => !gefundeneIds.has(id))

        return reply.code(404).send({
          code: 'NOT_FOUND',
          message: `Folgende Buchungen wurden nicht gefunden: ${nichtGefundeneIds.join(', ')}`,
        })
      }

      // Check for dependencies
      // Check if any of the bookings have storno dependencies
      const stornoBuchungen = existingBuchungen.filter((b) => b.storno)
      if (stornoBuchungen.length > 0) {
        // For storno bookings, we need to check if they have a reference
        // and if the referenced booking still exists
        const stornoVonIds = stornoBuchungen
          .filter((b) => b.stornoVon)
          .map((b) => b.stornoVon)

        if (stornoVonIds.length > 0) {
          const referenzierteBuchungen = await db
            .select({ id: buchungen.id })
            .from(buchungen)
            .where(inArray(buchungen.id, stornoVonIds))

          const existierendeReferenzen = new Set(referenzierteBuchungen.map((b) => b.id))
          const stornoMitNichtExistierenderReferenz = stornoBuchungen.filter(
            (b) => b.stornoVon && !existierendeReferenzen.has(b.stornoVon)
          )

          if (stornoMitNichtExistierenderReferenz.length > 0) {
            return reply.code(400).send({
              code: 'DEPENDENCY',
              message: `Löschen nicht möglich: Folgende Storno-Buchungen verweisen auf nicht existierende Einträge: ${stornoMitNichtExistierenderReferenz.map((b) => b.id).join(', ')}`,
            })
          }
        }
      }

      // Delete the bookings
      await db.delete(buchungen).where(inArray(buchungen.id, buchungsIds))

      return reply.send({
        deletedCount: buchungsIds.length,
        message: `Erfolgreich gelöscht: ${buchungsIds.length} Buchung(en)`,
      })
    },
  )
}
