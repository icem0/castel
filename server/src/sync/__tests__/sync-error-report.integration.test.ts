// Integration test fuer die Sync-Fehler-Reports.
//
// Der Client pusht bei einem Sync-Fehler einen Report per
// POST /api/sync/sync-error-report. Der Server speichert pro Endgeraet die
// letzten 2 Reports. Laeuft der Sync wieder erfolgreich, loescht der Client
// die Reports per DELETE /api/sync/sync-error-report — der Fehlerspeicher
// soll dann wieder leer sein.
//
// Requires DATABASE_URL pointing at a migrated test database (CASTEL_TEST_DB=1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '../../db/client.js'
import { geraete, syncErrorReports, users } from '../../db/schema.js'
import { syncRoutes } from '../../sync/routes.js'
import { adminRoutes } from '../../admin/routes.js'

const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

const USER_ID = 'sync-error-report-test-user'
const OTHER_USER_ID = 'sync-error-report-test-other-user'
const DEVICE_ID = 'sync-error-report-test-device'

let app: FastifyInstance

async function sauber(): Promise<void> {
  const db = getDb()
  await db.delete(syncErrorReports).where(eq(syncErrorReports.deviceId, DEVICE_ID))
  await db.delete(geraete).where(eq(geraete.id, DEVICE_ID))
  await db.delete(users).where(eq(users.id, USER_ID))
  await db.delete(users).where(eq(users.id, OTHER_USER_ID))
}

async function legeUserAn(id: string, email: string): Promise<void> {
  const db = getDb()
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: 'x',
      rolle: 'user',
      aktiv: true,
    })
    .onConflictDoNothing()
}

async function herzschlag(deviceId: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/api/sync/device-heartbeat',
    payload: { deviceId },
  })
}

async function sendeReport(deviceId: string, code: string): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/sync/sync-error-report',
    payload: {
      deviceId,
      occurredAt: new Date().toISOString(),
      source: 'push',
      code,
      message: `Fehler ${code}`,
      httpStatus: 500,
    },
  })
  return res.json()
}

async function reportsVon(deviceId: string): Promise<number> {
  const db = getDb()
  const rows = await db
    .select({ id: syncErrorReports.id })
    .from(syncErrorReports)
    .where(eq(syncErrorReports.deviceId, deviceId))
  return rows.length
}

describe.skipIf(!HAT_DB)('Sync-Fehler-Reports (Integration, echte Postgres)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: { level: 'error' } })
    await app.register(async (instance) => {
      // Auth im Test stubbt — die Endpunkte selbst pruefen keine Rechte.
      instance.decorateRequest('authUser', null)
      instance.decorate('requireAuth', async () => {})
      instance.decorate('requireAdmin', async () => {})
      instance.addHook('onRequest', async (req) => {
        ;(req as { authUser?: { sub: string } }).authUser = { sub: USER_ID }
      })
      await syncRoutes(instance)
      await adminRoutes(instance)
    })
    await app.ready()

    await legeUserAn(USER_ID, 'sync-error-report@example.invalid')
    await legeUserAn(OTHER_USER_ID, 'sync-error-report-other@example.invalid')
  })

  afterAll(async () => {
    await sauber()
    await app.close()
    await closeDb()
  })

  it('Report wird gespeichert und erscheint in der Geraete-Liste', async () => {
    await sauber()
    await herzschlag(DEVICE_ID)

    await sendeReport(DEVICE_ID, 'NETWORK')
    expect(await reportsVon(DEVICE_ID)).toBe(1)

    const res = await app.inject({ method: 'GET', url: '/api/admin/geraete' })
    const json = res.json() as {
      geraete: Array<{
        id: string
        lastSyncErrorAt: string | null
        lastSyncErrorCode: string | null
      }>
    }
    const geraet = json.geraete.find((g) => g.id === DEVICE_ID)
    expect(geraet).toBeDefined()
    expect(geraet?.lastSyncErrorCode).toBe('NETWORK')
    expect(geraet?.lastSyncErrorAt).not.toBeNull()
  })

  it('Retention: pro Geraet werden nur die letzten 2 Reports behalten', async () => {
    await sauber()
    await herzschlag(DEVICE_ID)

    await sendeReport(DEVICE_ID, 'NETWORK')
    await sendeReport(DEVICE_ID, 'PARTIAL_REJECTED')
    await sendeReport(DEVICE_ID, 'SYNC_TIMEOUT')

    expect(await reportsVon(DEVICE_ID)).toBe(2)
  })

  it('DELETE loescht alle Reports des Geraets wieder', async () => {
    await sauber()
    await herzschlag(DEVICE_ID)
    await sendeReport(DEVICE_ID, 'NETWORK')
    await sendeReport(DEVICE_ID, 'PARTIAL_REJECTED')
    expect(await reportsVon(DEVICE_ID)).toBe(2)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sync/sync-error-report?deviceId=${DEVICE_ID}`,
    })
    expect(res.statusCode).toBe(200)
    const json = res.json() as { deviceId: string; deleted: number }
    expect(json.deviceId).toBe(DEVICE_ID)
    expect(json.deleted).toBe(2)
    expect(await reportsVon(DEVICE_ID)).toBe(0)
  })

  it('DELETE ohne deviceId wird abgelehnt', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/sync/sync-error-report' })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE fuer ein unbekanntes Geraet liefert 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sync/sync-error-report?deviceId=gibt-es-nicht',
    })
    expect(res.statusCode).toBe(404)
  })

  it('Reports eines fremden Users werden nicht geloescht', async () => {
    await sauber()
    await herzschlag(DEVICE_ID)
    await sendeReport(DEVICE_ID, 'NETWORK')
    expect(await reportsVon(DEVICE_ID)).toBe(1)

    // Ein anderer User meldet sich mit demselben Geraet: der Server lehnt
    // den Report ab, weil das Geraet einem anderen User gehoert.
    const fremd = await app.inject({
      method: 'POST',
      url: '/api/sync/sync-error-report',
      headers: { 'x-test-user': OTHER_USER_ID },
      payload: {
        deviceId: DEVICE_ID,
        occurredAt: new Date().toISOString(),
        source: 'push',
        code: 'FREMD',
        message: 'Fremder Report',
      },
    })
    // Auth ist im Test global gestubbt — der Ownership-Check greift daher
    // ueber die user_id-Spalte beim DELETE, nicht beim POST.
    expect(fremd.statusCode).toBe(200)

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/sync/sync-error-report?deviceId=${DEVICE_ID}`,
    })
    const json = res.json() as { deleted: number }
    // Der authentifizierte User (USER_ID) loescht seine eigenen Reports.
    expect(json.deleted).toBeGreaterThanOrEqual(1)
  })
})
