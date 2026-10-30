// Integration test fuer das Geraete-Reset-Flag.
//
// Der Server ordnet pro Endgeraet (UUID, Heartbeat /api/sync/device-heartbeat)
// ein Reset-Flag an. Erkennt das Geraet bei seinem Herzschlag, dass sein
// Flag neuer ist als der letzte lokal angewendete Reset, loescht es seine
// lokale IndexedDB und baut sie vom Server neu auf.
//
// Requires DATABASE_URL pointing at a migrated test database (CASTEL_TEST_DB=1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '../../db/client.js'
import { geraete, users } from '../../db/schema.js'
import { syncRoutes } from '../../sync/routes.js'
import { adminRoutes } from '../../admin/routes.js'

const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

const USER_ID = 'device-reset-test-user'
const DEVICE_ID_A = 'device-reset-test-device-a'
const DEVICE_ID_B = 'device-reset-test-device-b'

let app: FastifyInstance

async function sauber(): Promise<void> {
  const db = getDb()
  await db.delete(geraete).where(eq(geraete.id, DEVICE_ID_A))
  await db.delete(geraete).where(eq(geraete.id, DEVICE_ID_B))
  await db.delete(geraete).where(eq(geraete.userId, USER_ID))
  await db.delete(users).where(eq(users.id, USER_ID))
}

async function herzschlag(deviceId: string, lastAppliedResetAt?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/sync/device-heartbeat',
    payload: { deviceId, lastAppliedResetAt },
  })
}

async function geraetenVon(userId: string) {
  const db = getDb()
  return db
    .select({ id: geraete.id, resetAm: geraete.resetAm })
    .from(geraete)
    .where(eq(geraete.userId, userId))
}

describe.skipIf(!HAT_DB)('Geraete-Reset (Integration, echte Postgres)', () => {
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

    const db = getDb()
    await db
      .insert(users)
      .values({
        id: USER_ID,
        email: 'device-reset@example.invalid',
        passwordHash: 'x',
        rolle: 'user',
        aktiv: true,
      })
      .onConflictDoNothing()
  })

  afterAll(async () => {
    await sauber()
    await app.close()
    await closeDb()
  })

  it('neues Geraet ohne Flag meldet needsReset: false', async () => {
    await sauber()
    const res = await herzschlag(DEVICE_ID_A)
    expect(res.statusCode).toBe(200)
    const json = res.json() as { deviceId: string; needsReset: boolean; resetAm: string | null }
    expect(json.deviceId).toBe(DEVICE_ID_A)
    expect(json.needsReset).toBe(false)
    expect(json.resetAm).toBeNull()

    const zeilen = await geraetenVon(USER_ID)
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]?.resetAm).toBeNull()
  })

  it('gesetztes Flag wird erkannt; nach Anwendung des Resets nicht erneut', async () => {
    await sauber()
    await app.inject({
      method: 'POST',
      url: `/api/admin/geraete/${DEVICE_ID_A}/reset`,
      payload: { reset: true },
    })

    const res = await herzschlag(DEVICE_ID_A)
    const json = res.json() as { needsReset: boolean; resetAm: string | null }
    expect(json.needsReset).toBe(true)
    expect(typeof json.resetAm).toBe('string')

    // Wiederholter Herzschlag mit demselben Zeitstempel loest keinen neuen Reset aus.
    const res2 = await herzschlag(DEVICE_ID_A, json.resetAm)
    const json2 = res2.json() as { needsReset: boolean }
    expect(json2.needsReset).toBe(false)
  })

  it('Flag loeschen unterbindet den Reset', async () => {
    await sauber()
    await app.inject({
      method: 'POST',
      url: `/api/admin/geraete/${DEVICE_ID_A}/reset`,
      payload: { reset: true },
    })
    await app.inject({
      method: 'POST',
      url: `/api/admin/geraete/${DEVICE_ID_A}/reset`,
      payload: { reset: false },
    })

    const res = await herzschlag(DEVICE_ID_A)
    const json = res.json() as { needsReset: boolean }
    expect(json.needsReset).toBe(false)
  })

  it('Nutzer-Massen-Aktion setzt das Flag fuer alle Geraete des Nutzers', async () => {
    await sauber()
    await herzschlag(DEVICE_ID_A)
    await herzschlag(DEVICE_ID_B)

    await app.inject({
      method: 'POST',
      url: `/api/admin/geraete/user/${USER_ID}/reset`,
      payload: { reset: true },
    })

    const [a, b] = await Promise.all([herzschlag(DEVICE_ID_A), herzschlag(DEVICE_ID_B)])
    const ja = a.json() as { needsReset: boolean }
    const jb = b.json() as { needsReset: boolean }
    expect(ja.needsReset).toBe(true)
    expect(jb.needsReset).toBe(true)
  })
})
