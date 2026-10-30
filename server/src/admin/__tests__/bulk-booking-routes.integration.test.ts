// Integration test for the developer bulk-delete of bookings.
//
// A hard DELETE bypasses the append-only sync protocol: the incremental
// snapshot only upserts, so every client that still holds the row keeps it as
// a ghost forever and `reconcileBookings` cries `SERVER_MISSING` on every
// tick. The only way out is the restore epoch (`server.restoreEpoch`) — the
// worker wipes the local IndexedDB and pulls a full snapshot when it changes.
// This test pins that the bulk-delete route actually bumps it.
//
// Requires DATABASE_URL pointing at a migrated test database (CASTEL_TEST_DB=1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { closeDb, getDb } from '../../db/client.js'
import {
  artikel,
  buchungen,
  einstellungen,
  mindestbestandEreignisse,
  standorte,
} from '../../db/schema.js'
import { leseRestoreEpoch } from '../backup.js'
import { bulkBookingRoutes } from '../bulk-booking-routes.js'

const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

const EPOCHE_KEY = 'server.restoreEpoch'

const TEST_ARTIKEL_ID = 'bulk-delete-test-artikel'
const TEST_STANDORT_ID = 'bulk-delete-test-standort'

let app: FastifyInstance

async function epochLeschen(): Promise<void> {
  await getDb()
    .delete(einstellungen)
    .where(and(eq(einstellungen.key, EPOCHE_KEY), isNull(einstellungen.userId)))
}

async function domainZuruecksetzen(): Promise<void> {
  const db = getDb()
  await db
    .delete(mindestbestandEreignisse)
    .where(eq(mindestbestandEreignisse.artikelId, TEST_ARTIKEL_ID))
  await db.delete(buchungen).where(eq(buchungen.artikelId, TEST_ARTIKEL_ID))
  await epochLeschen()
}

async function buchungAnlegen(id: string, mitEreignis = false): Promise<void> {
  const db = getDb()
  await db.insert(buchungen).values({
    id,
    artikelId: TEST_ARTIKEL_ID,
    standortId: TEST_STANDORT_ID,
    typ: 'entnahme',
    menge: -1,
    erstelltAm: new Date(),
    erstelltVon: 'bulk-delete-test',
  })
  if (mitEreignis) {
    await db.insert(mindestbestandEreignisse).values({
      id: `ereignis-${id}`,
      artikelId: TEST_ARTIKEL_ID,
      standortId: TEST_STANDORT_ID,
      ausloeserBuchungId: id,
      bestandDanach: 0,
      mindestbestand: 5,
      defizit: 5,
      erstelltAm: new Date(),
    })
  }
}

async function zahl(table: 'buchungen' | 'mindestbestandEreignisse'): Promise<number> {
  const db = getDb()
  const rows =
    table === 'buchungen'
      ? await db
          .select({ id: buchungen.id })
          .from(buchungen)
          .where(eq(buchungen.artikelId, TEST_ARTIKEL_ID))
      : await db
          .select({ id: mindestbestandEreignisse.id })
          .from(mindestbestandEreignisse)
          .where(eq(mindestbestandEreignisse.artikelId, TEST_ARTIKEL_ID))
  return rows.length
}

describe.skipIf(!HAT_DB)('Buchungen-Bulk-Delete (Integration, echte Postgres)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: { level: 'error' } })
    await app.register(async (instance) => {
      // Auth is stubbed — authorization is covered by the auth tests. What
      // matters here is the side effect on the restore epoch.
      instance.decorate('requireAdmin', async () => {})
      await bulkBookingRoutes(instance)
    })
    await app.ready()

    const db = getDb()
    const jetzt = new Date()
    await db
      .insert(artikel)
      .values({
        id: TEST_ARTIKEL_ID,
        titel: 'Bulk-Delete Testartikel',
        geaendertAm: jetzt,
        erstelltAm: jetzt,
      })
      .onConflictDoNothing()
    await db
      .insert(standorte)
      .values({
        id: TEST_STANDORT_ID,
        name: 'Bulk-Delete Teststandort',
        typ: 'lager',
        geaendertAm: jetzt,
        erstelltAm: jetzt,
      })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    await domainZuruecksetzen()
    await app.close()
    await closeDb()
  })

  it('hartes Loeschen setzt die Restore-Epoche, damit alle Clients neu aufbauen', async () => {
    await domainZuruecksetzen()
    await buchungAnlegen('bulk-1', true)
    expect(await zahl('buchungen')).toBe(1)
    expect(await zahl('mindestbestandEreignisse')).toBe(1)
    expect(await leseRestoreEpoch()).toBeNull()

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/buchungen/bulk-delete',
      payload: { ids: ['bulk-1'], bestaetigt: true },
    })
    expect(res.statusCode).toBe(200)
    const json = res.json() as {
      deletedCount: number
      mindestbestandEreignisseDeleted: number
      restoreEpoch: string | null
    }
    expect(json.deletedCount).toBe(1)
    expect(json.mindestbestandEreignisseDeleted).toBe(1)

    // The epoch is the trigger every client reacts to — it must be persisted,
    // not only echoed.
    expect(typeof json.restoreEpoch).toBe('string')
    expect(await leseRestoreEpoch()).toBe(json.restoreEpoch)

    expect(await zahl('buchungen')).toBe(0)
    expect(await zahl('mindestbestandEreignisse')).toBe(0)
  })

  it('Loeschen ohne Treffer laesst die Epoche unangetastet', async () => {
    await domainZuruecksetzen()
    await buchungAnlegen('bulk-2')

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/buchungen/bulk-delete',
      payload: { ids: ['bulk-gibt-es-nicht'], bestaetigt: true },
    })
    expect(res.statusCode).toBe(200)
    const json = res.json() as { deletedCount: number; restoreEpoch: string | null }
    expect(json.deletedCount).toBe(0)
    expect(json.restoreEpoch).toBeNull()
    // Kein Grund, allen Geraeten die IndexedDB wegzuwerfen.
    expect(await leseRestoreEpoch()).toBeNull()

    expect(await zahl('buchungen')).toBe(1)
  })
})
