// End-to-end smoke test for the DATANORM HTTP surface.
//
// Boots a real Fastify instance against the migrated test database and walks
// the whole admin flow: create supplier -> upload file -> read report ->
// look up catalogue entries. Uses the real routes, the real multipart parser
// and the real database, because every interesting bug in this feature lives
// exactly at those seams.
//
// Requires DATABASE_URL pointing at a migrated test database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { closeDb, getDb } from '../../db/client.js'
import {
  datanormDateien,
  datanormImporte,
  herstellerArtikel,
  lieferanten,
} from '../../db/schema.js'
import { config } from '../../config/config.js'
import { datanormRoutes } from '../routes.js'
import {
  kanalFuer,
  meldeFertig,
  resetProgressRegistry,
} from '../progress.js'
import { BEISPIEL_V5, datei } from './fixtures.js'

/**
 * Requires a real migrated Postgres.
 *
 * Opt-in via `CASTEL_TEST_DB=1` — see the note in
 * persist.integration.test.ts for why bare DATABASE_URL is not sufficient.
 */
const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

let app: FastifyInstance
let lieferantId = ''
const testUserId = 'datanorm-test-user'

/** Fixed boundary so the header and the body cannot drift apart. */
const BOUNDARY = '----castelDatanormTest'

/** Builds a multipart body without pulling in a form-data dependency. */
function multipart(fields: Record<string, string>, dateiname: string, inhalt: Buffer): Buffer {
  const teile: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    teile.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
      ),
    )
  }
  teile.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="datei"; filename="${dateiname}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    inhalt,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  )
  return Buffer.concat(teile)
}

async function upload(
  name: string,
  inhalt: Buffer,
  extra: Record<string, string> = {},
  zielLieferantId = lieferantId,
) {
  const body = multipart({ lieferantId: zielLieferantId, ...extra }, name, inhalt)
  return app.inject({
    method: 'POST',
    url: '/api/datanorm/upload',
    payload: body,
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  })
}

describe.skipIf(!HAT_DB)('DATANORM HTTP (Integration)', () => {
  beforeAll(async () => {
    resetProgressRegistry()
    app = Fastify({ logger: { level: 'error' } })
    await app.register(async (instance) => {
      // The upload route relies on @fastify/multipart, which the real app
      // registers in index.ts. Without it Fastify answers 415 before the
      // handler ever runs.
      await instance.register(fastifyMultipart, {
        limits: { fileSize: 10 * 1024 * 1024, files: 1 },
      })
      // Tests bypass auth: the decorators are stubbed so the routes run
      // without a JWT dance. Authorization itself is covered elsewhere.
      // We still hand a real user id through, because `datanorm_importe`
      // has a real FK to `users` and a bogus id would fail the constraint.
      instance.decorateRequest('authUser', null)
      instance.decorate('requireAuth', async () => {})
      instance.decorate('requireAdmin', async () => {})
      instance.addHook('onRequest', async (req) => {
        ;(req as { authUser?: unknown }).authUser = { sub: testUserId, rolle: 'admin' }
      })
      await datanormRoutes(instance)
    })
    await app.ready()

    const db = getDb()
    await db.delete(herstellerArtikel)
    await db.delete(lieferanten)
    await db.execute(
      sql`INSERT INTO users (id, email, password_hash, rolle, aktiv, erstellt_am)
          VALUES (${testUserId}, ${'datanorm-test@example.invalid'}, ${'x'}, ${'admin'}, ${true}, NOW())
          ON CONFLICT DO NOTHING`,
    )

    const id = crypto.randomUUID()
    await db.insert(lieferanten).values({
      id,
      name: 'E2E Lieferant GmbH',
      matchcode: 'E2E',
      aktiv: true,
    })
    lieferantId = id
  })

  afterAll(async () => {
    resetProgressRegistry()
    await app.close()
    await closeDb()
  })

  it('legt einen Lieferanten an und lehnt ein doppeltes Matchcode ab', async () => {
    const neu = await app.inject({
      method: 'POST',
      url: '/api/lieferanten',
      payload: { name: 'Sanitär Meier GmbH', matchcode: 'MEIER' },
    })
    expect(neu.statusCode).toBe(201)
    const neuId = neu.json<{ id: string }>().id

    const doppelt = await app.inject({
      method: 'POST',
      url: '/api/lieferanten',
      payload: { name: 'Sanitär Meier GmbH', matchcode: 'meier' },
    })
    // Case-insensitive: the second attempt must be rejected.
    expect(doppelt.statusCode).toBe(409)

    await getDb().delete(lieferanten).where(sql`${lieferanten.id} = ${neuId}`)
  })

  it('importiert eine DATANORM-Datei und liefert einen Report', async () => {
    const res = await upload('DATANORM.001', datei(BEISPIEL_V5))
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      importId: string
      status: string
      artikelAnzahl: number
      neu: number
      version: number
      encoding: string
      fehlerAnzahl: number
    }>()
    expect(body.status).toBe('erfolg')
    expect(body.artikelAnzahl).toBe(2)
    expect(body.neu).toBe(2)
    expect(body.version).toBe(5)
    // The fixture is ASCII-only, so the CP850 bytes are also valid UTF-8 and
    // detection correctly reports UTF-8. CP850 detection has its own test in
    // parse-pass1.test.ts (umlauts as single bytes).
    expect(body.encoding).toBe('utf-8')
    expect(body.fehlerAnzahl).toBe(0)

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
  })

  it('erkennt denselben Upload beim zweiten Mal als Duplikat', async () => {
    const res = await upload('DATANORM.001', datei(BEISPIEL_V5))
    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; vorhandenerImportId: string }>()
    expect(body.status).toBe('duplikat')
    expect(body.vorhandenerImportId).toBeTruthy()

    // Kein zweiter Satz Artikel im Katalog.
    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
  })

  it('schliesst den SSE-Stream sofort, wenn der Import schon fertig ist', async () => {
    const res = await upload('DATANORM.004', datei(BEISPIEL_V5))
    expect(res.statusCode).toBe(200)
    const importId = res.json<{ importId: string }>().importId

    // Der Browser subscribed erst NACH der Upload-Antwort — der Import ist
    // dann längst fertig. Der Stream muss dann sofort mit 'abschluss'
    // enden, sonst wartet die UI endlos auf das Event.
    const sse = await app.inject({
      method: 'GET',
      url: `/api/datanorm/import/${importId}/progress`,
    })
    expect(sse.statusCode).toBe(200)
    expect(sse.payload).toContain('event: abschluss')
  })

  it('aktualisiert den Katalog bei einer geänderten Datei', async () => {
    const geaendert = [
      'V;5.0;20240201;EUR;E2E;E2E Lieferant GmbH',
      BEISPIEL_V5[1]!.replace(/Bleistift HB/, 'Bleistift HB NEU'),
      BEISPIEL_V5[2]!,
      'Z',
    ]
    const res = await upload('DATANORM.002', datei(geaendert))
    const body = res.json<{ status: string; aktualisiert: number; neu: number }>()
    expect(body.status).toBe('erfolg')
    expect(body.aktualisiert).toBe(2)
    expect(body.neu).toBe(0)

    const rows = await getDb().select().from(herstellerArtikel)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.matchcode === 'ART-1001')!.titel).toBe('Bleistift HB NEU')
  })

  it('lehnt eine Datei ohne A-Sätze mit 422 ab', async () => {
    const res = await upload('KAPUTT.001', datei(['V;5.0;20240115;EUR;X;X', 'Z']))
    expect(res.statusCode).toBe(422)
    expect(res.json<{ code: string }>().code).toBe('DATANORM_KEINE_ARTIKEL')
  })

  it('lehnt einen unbekannten Lieferanten mit 404 ab', async () => {
    const body = multipart(
      { lieferantId: crypto.randomUUID() },
      'DATANORM.001',
      datei(BEISPIEL_V5),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/datanorm/upload',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('findet Katalogeinträge per EAN, Matchcode und Titel', async () => {
    // EAN
    const perEan = await app.inject({
      method: 'GET',
      url: `/api/datanorm/artikel?lieferantId=${lieferantId}&q=4006381333931`,
    })
    expect(perEan.statusCode).toBe(200)
    const eanBody = perEan.json<{ suchstrategie: string; treffer: Array<{ matchcode: string }>; total: number }>()
    expect(eanBody.suchstrategie).toBe('ean')
    expect(eanBody.treffer[0]!.matchcode).toBe('ART-1001')
    expect(eanBody.total).toBe(1)

    // Matchcode
    const perCode = await app.inject({
      method: 'GET',
      url: `/api/datanorm/artikel?lieferantId=${lieferantId}&q=ART-1002`,
    })
    const codeBody = perCode.json<{ suchstrategie: string; treffer: Array<{ matchcode: string }> }>()
    expect(codeBody.suchstrategie).toBe('titel')
    expect(codeBody.treffer[0]!.matchcode).toBe('ART-1002')

    // Titel-Teiltext
    const perTitel = await app.inject({
      method: 'GET',
      url: `/api/datanorm/artikel?lieferantId=${lieferantId}&q=Radier`,
    })
    const titelBody = perTitel.json<{ treffer: Array<{ matchcode: string }> }>()
    expect(titelBody.treffer.map((t) => t.matchcode)).toContain('ART-1002')
  })

  it('verlangt lieferantId beim Lookup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/datanorm/artikel?q=Bleistift' })
    expect(res.statusCode).toBe(400)
  })

  it('liefert die Lieferant-Liste mit Katalog-Zuordnung', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lieferanten' })
    expect(res.statusCode).toBe(200)
    const liste = res.json<Array<{ id: string; name: string; aktiv: boolean }>>()
    expect(liste.some((l) => l.id === lieferantId)).toBe(true)
  })

  it('gibt das Import-Protokoll zurück', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/datanorm/importe' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ treffer: Array<{ status: string; originalDateiname: string }>; total: number }>()
    expect(body.total).toBeGreaterThan(0)
    expect(body.treffer.map((t) => t.status)).toContain('erfolg')
  })

  it('meldet Anzahl Artikel und Dateien in der Lieferanten-Liste', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lieferanten?alle=true' })
    expect(res.statusCode).toBe(200)
    const liste = res.json<Array<{ id: string; artikelAnzahl: number; dateiAnzahl: number }>>()
    const eintrag = liste.find((l) => l.id === lieferantId)
    expect(eintrag).toBeDefined()
    expect(eintrag!.artikelAnzahl).toBeGreaterThan(0)
    expect(eintrag!.dateiAnzahl).toBeGreaterThan(0)
  })

  it('verweigert das Loeschen eines unbekannten Lieferanten mit 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/lieferanten/${crypto.randomUUID()}`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('leert den Katalog, behaelt Lieferant und Import-Historie', async () => {
    const db = getDb()
    const dateienVorher = await db
      .select()
      .from(datanormDateien)
      .where(eq(datanormDateien.lieferantId, lieferantId))
    expect(dateienVorher.length).toBeGreaterThan(0)

    const res = await app.inject({
      method: 'POST',
      url: `/api/lieferanten/${lieferantId}/katalog-leeren`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ ok: boolean; artikel: number; dateien: number }>()
    expect(body.ok).toBe(true)
    expect(body.artikel).toBeGreaterThan(0)
    expect(body.dateien).toBe(dateienVorher.length)

    const artikel = await db
      .select()
      .from(herstellerArtikel)
      .where(eq(herstellerArtikel.lieferantId, lieferantId))
    expect(artikel).toHaveLength(0)
    const dateien = await db
      .select()
      .from(datanormDateien)
      .where(eq(datanormDateien.lieferantId, lieferantId))
    expect(dateien).toHaveLength(0)
    const lieferant = await db.select().from(lieferanten).where(eq(lieferanten.id, lieferantId))
    expect(lieferant).toHaveLength(1)

    // Audit-Spur bleibt: die Import-Belege ueberleben, nur der Dateibezug faellt.
    const importe = await db
      .select()
      .from(datanormImporte)
      .where(eq(datanormImporte.lieferantId, lieferantId))
    expect(importe.length).toBeGreaterThan(0)
    expect(importe.every((i) => i.dateiId === null)).toBe(true)

    // Die Bytes sind von der Platte verschwunden.
    for (const d of dateienVorher) {
      await expect(access(join(config.DATANORM_DIR, d.pfad))).rejects.toThrow()
    }
  })

  it('loescht einen Lieferanten mit Katalog, Dateien und Import-Historie', async () => {
    const db = getDb()
    const id = crypto.randomUUID()
    await db.insert(lieferanten).values({ id, name: 'Loesch-Kandidat GmbH', aktiv: true })

    const hoch = await upload('DATANORM-LOESCHEN.001', datei(BEISPIEL_V5), {}, id)
    expect(hoch.statusCode).toBe(200)

    const dateien = await db
      .select()
      .from(datanormDateien)
      .where(eq(datanormDateien.lieferantId, id))
    expect(dateien).toHaveLength(1)

    const res = await app.inject({ method: 'DELETE', url: `/api/lieferanten/${id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ artikel: number; dateien: number; importe: number }>()
    expect(body.artikel).toBe(2)
    expect(body.dateien).toBe(1)
    expect(body.importe).toBeGreaterThan(0)

    expect(await db.select().from(lieferanten).where(eq(lieferanten.id, id))).toHaveLength(0)
    expect(
      await db.select().from(herstellerArtikel).where(eq(herstellerArtikel.lieferantId, id)),
    ).toHaveLength(0)
    expect(
      await db.select().from(datanormDateien).where(eq(datanormDateien.lieferantId, id)),
    ).toHaveLength(0)
    expect(
      await db.select().from(datanormImporte).where(eq(datanormImporte.lieferantId, id)),
    ).toHaveLength(0)

    await expect(access(join(config.DATANORM_DIR, dateien[0]!.pfad))).rejects.toThrow()
  })

  it('verweigert das Loeschen, solange ein Import laeuft', async () => {
    const db = getDb()
    const id = crypto.randomUUID()
    await db.insert(lieferanten).values({ id, name: 'Laufender Import GmbH', aktiv: true })
    const importId = crypto.randomUUID()
    await db.insert(datanormImporte).values({
      id: importId,
      lieferantId: id,
      originalDateiname: 'laeuft.dat',
      status: 'gestartet',
    })
    // Registers a progress channel that is not finished yet.
    kanalFuer(importId)

    const res = await app.inject({ method: 'DELETE', url: `/api/lieferanten/${id}` })
    expect(res.statusCode).toBe(409)
    expect(res.json<{ code: string }>().code).toBe('IMPORT_LAEUFT')

    meldeFertig(importId)
    await db.delete(datanormImporte).where(eq(datanormImporte.lieferantId, id))
    await db.delete(lieferanten).where(eq(lieferanten.id, id))
  })
})