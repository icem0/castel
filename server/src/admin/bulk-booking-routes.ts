// Admin routes for the developer area: filter and bulk-delete bookings.
//
//   * POST /api/admin/buchungen/filter       - filter bookings and return the
//                                              options used by the UI filters.
//   * POST /api/admin/buchungen/bulk-delete  - hard-delete selected bookings.
//
// WARNING: deleting bookings bypasses the append-only sync protocol. Clients
// that still hold the deleted rows keep them locally (reconcileBookings never
// removes server-missing rows). This tool is meant for cleaning up test data;
// clients must reset their local database afterwards.

import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, inArray, isNotNull, lte, type SQL } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { artikel, buchungen, mindestbestandEreignisse, standorte } from '../db/schema.js'

const MAX_BULK_IDS = 5000

type FilterBody = {
  artikelId?: unknown
  standortId?: unknown
  typ?: unknown
  datumVon?: unknown
  datumBis?: unknown
  storno?: unknown
  projekt?: unknown
}

type BulkDeleteBody = {
  ids?: unknown
  bestaetigt?: unknown
}

function alsText(wert: unknown): string | null {
  return typeof wert === 'string' && wert.length > 0 ? wert : null
}

function alsDatum(wert: unknown): Date | null | undefined {
  if (wert === undefined || wert === null || wert === '') return null
  if (typeof wert !== 'string') return undefined
  const datum = new Date(wert)
  return Number.isNaN(datum.getTime()) ? undefined : datum
}

function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BULK_IDS) return null
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length !== raw.length) return null
  return [...new Set(ids)]
}

export async function bulkBookingRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/admin/buchungen/filter
  app.post(
    '/api/admin/buchungen/filter',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const body = (req.body ?? {}) as FilterBody

      const artikelId = alsText(body.artikelId)
      const standortId = alsText(body.standortId)
      const typ = alsText(body.typ)
      const projekt = alsText(body.projekt)
      const datumVon = alsDatum(body.datumVon)
      const datumBis = alsDatum(body.datumBis)

      if (datumVon === undefined || datumBis === undefined) {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'datumVon/datumBis müssen gültige ISO-Zeitstempel sein',
        })
      }
      if (body.storno !== undefined && typeof body.storno !== 'boolean') {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'storno muss ein Boolean sein',
        })
      }

      const db = getDb()
      const conditions: SQL[] = []
      if (artikelId) conditions.push(eq(buchungen.artikelId, artikelId))
      if (standortId) conditions.push(eq(buchungen.standortId, standortId))
      if (typ) conditions.push(eq(buchungen.typ, typ as never))
      if (datumVon) conditions.push(gte(buchungen.erstelltAm, datumVon))
      if (datumBis) conditions.push(lte(buchungen.erstelltAm, datumBis))
      if (typeof body.storno === 'boolean') conditions.push(eq(buchungen.storno, body.storno))
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
        .orderBy(desc(buchungen.erstelltAm))

      const [artikelOptionen, standortOptionen, typRows, projektRows] = await Promise.all([
        db.select({ id: artikel.id, titel: artikel.titel }).from(artikel).orderBy(artikel.titel),
        db
          .select({ id: standorte.id, name: standorte.name })
          .from(standorte)
          .orderBy(standorte.name),
        db.selectDistinct({ typ: buchungen.typ }).from(buchungen).orderBy(buchungen.typ),
        db
          .selectDistinct({ projekt: buchungen.projekt })
          .from(buchungen)
          .where(isNotNull(buchungen.projekt))
          .orderBy(buchungen.projekt),
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
          projekte: projektRows
            .map((p) => p.projekt)
            .filter((p): p is string => typeof p === 'string'),
        },
      })
    },
  )

  // POST /api/admin/buchungen/bulk-delete
  // Requires an explicit confirmation flag. Dependent minimum-stock events are
  // removed first because their FK points at buchungen.id.
  app.post(
    '/api/admin/buchungen/bulk-delete',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const body = (req.body ?? {}) as BulkDeleteBody

      if (body.bestaetigt !== true) {
        return reply.code(400).send({
          code: 'CONFIRMATION_REQUIRED',
          message: 'Löschen erfordert bestaetigt: true',
        })
      }

      const ids = parseIds(body.ids)
      if (!ids) {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: `ids muss ein Array mit 1 bis ${MAX_BULK_IDS} UUIDs sein`,
        })
      }

      const db = getDb()
      const result = await db.transaction(async (tx) => {
        const ereignisse = await tx
          .delete(mindestbestandEreignisse)
          .where(inArray(mindestbestandEreignisse.ausloeserBuchungId, ids))
          .returning({ id: mindestbestandEreignisse.id })

        const geloescht = await tx
          .delete(buchungen)
          .where(inArray(buchungen.id, ids))
          .returning({ id: buchungen.id })

        return {
          deletedIds: geloescht.map((b) => b.id),
          mindestbestandEreignisseDeleted: ereignisse.length,
        }
      })

      return reply.send({
        deletedCount: result.deletedIds.length,
        deletedIds: result.deletedIds,
        mindestbestandEreignisseDeleted: result.mindestbestandEreignisseDeleted,
      })
    },
  )
}
