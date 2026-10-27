// Integration test for the image upload of the agent API (API key) and the
// PWA upload (JWT). Both paths share the photo service, so they are
// tested together here: multipart parsing, DB row, file on disk and the
// deletion.
//
// Requires a migrated Postgres and only runs with CASTEL_TEST_DB=1.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env['FOTOS_DIR'] = '/tmp/castel-fotos-test'
})

import Fastify, { type FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import { eq } from 'drizzle-orm'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { closeDb, getDb } from '../../../db/client.js'
import { artikel, fotos, users } from '../../../db/schema.js'
import { apiV1FotoRoutes } from '../foto-routes.js'
import { fotoRoutes } from '../../../fotos/routes.js'
import { config } from '../../../config/config.js'

const HAT_DB = process.env['CASTEL_TEST_DB'] === '1' && Boolean(process.env['DATABASE_URL'])

const BOUNDARY = '----castelFotoTest'
const FOTOS_DIR = '/tmp/castel-fotos-test'
const testUserId = 'foto-test-user'
let app: FastifyInstance
let artikelId = ''

/** 1x1 PNG as a valid image file. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c6360000002000100ffff03000006000557bfabd4000000' +
    '0049454e44ae426082',
  'hex',
)

function multipart(dateiname: string, inhalt: Buffer, mimetype: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="foto"; filename="${dateiname}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
    ),
    inhalt,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ])
}

async function upload(url: string, mimetype = 'image/png', inhalt = PNG) {
  return app.inject({
    method: 'POST',
    url,
    payload: multipart('bild.png', inhalt, mimetype),
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
  })
}

describe.skipIf(!HAT_DB)('Foto-Upload (Integration)', () => {
  beforeAll(async () => {
    app = Fastify({ logger: { level: 'error' } })
    await app.register(rateLimit, { global: false })

    // Agent API: own scope with the multipart parser, API key auth is
    // stubbed here (the auth itself is covered elsewhere).
    await app.register(async (instance) => {
      instance.decorateRequest('apiAuth', null)
      instance.decorate('requireApiAuth', async () => {})
      instance.decorate('requireApiScope', () => async () => {})
      instance.addHook('onRequest', async (req) => {
        ;(req as { apiAuth?: unknown }).apiAuth = {
          userId: testUserId,
          email: 'foto-test@example.invalid',
          rolle: 'admin',
          scopes: ['read', 'write', 'admin'],
          apiKeyId: 'foto-test-key',
          keyPrefix: 'castel_test',
        }
      })
      await instance.register(fastifyMultipart, {
        limits: { fileSize: config.FOTOS_MAX_BYTES, files: 1 },
      })
      await apiV1FotoRoutes(instance)
    })

    // PWA routes (JWT) in their own scope.
    await app.register(async (instance) => {
      instance.decorateRequest('authUser', null)
      instance.decorate('requireAuth', async () => {})
      instance.decorate('requireAdmin', async () => {})
      instance.addHook('onRequest', async (req) => {
        ;(req as { authUser?: unknown }).authUser = { sub: testUserId, rolle: 'admin' }
      })
      await fotoRoutes(instance)
    })

    await app.ready()

    const db = getDb()
    await db
      .insert(users)
      .values({
        id: testUserId,
        email: 'foto-test@example.invalid',
        passwordHash: 'x',
        rolle: 'admin',
        aktiv: true,
        erstelltAm: new Date(),
      })
      .onConflictDoNothing()
    artikelId = crypto.randomUUID()
    await db.insert(artikel).values({
      id: artikelId,
      titel: 'Produkt mit Bild',
      status: 'verfuegbar',
      typ: 'Test',
      verpackungseinheit: 1,
      etikettenNeu: true,
      geaendertAm: new Date(),
      erstelltAm: new Date(),
    })
  })

  afterAll(async () => {
    if (app) await app.close()
    const db = getDb()
    if (artikelId) {
      await db.delete(fotos).where(eq(fotos.artikelId, artikelId))
      await db.delete(artikel).where(eq(artikel.id, artikelId))
    }
    await db.delete(users).where(eq(users.id, testUserId))
    await rm(FOTOS_DIR, { recursive: true, force: true })
    await closeDb()
  })

  it('laedt ueber die Agenten-API ein Produktbild hoch', async () => {
    const res = await upload(`/api/v1/artikel/${artikelId}/fotos`)
    expect(res.statusCode).toBe(201)
    const body = res.json<{ id: string; artikelId: string; url: string; contentType: string }>()
    expect(body.artikelId).toBe(artikelId)
    expect(body.contentType).toBe('image/png')
    expect(body.url.startsWith(`/fotos/${artikelId}/`)).toBe(true)

    const rows = await getDb().select().from(fotos).where(eq(fotos.id, body.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.artikelId).toBe(artikelId)
    expect(rows[0]!.erstelltVon).toBe(testUserId)

    const datei = join(FOTOS_DIR, rows[0]!.pfad)
    const info = await stat(datei)
    expect(info.size).toBe(PNG.length)
  })

  it('listet die Bilder eines Artikels', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/artikel/${artikelId}/fotos` })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ items: Array<{ id: string; url: string }> }>()
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.url.startsWith('/fotos/')).toBe(true)
  })

  it('lehnt ein unbekanntes Bildformat ab', async () => {
    const res = await upload(`/api/v1/artikel/${artikelId}/fotos`, 'image/gif')
    expect(res.statusCode).toBe(415)
    expect(res.json<{ code: string }>().code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('lehnt einen unbekannten Artikel ab', async () => {
    const res = await upload(`/api/v1/artikel/${crypto.randomUUID()}/fotos`)
    expect(res.statusCode).toBe(404)
    expect(res.json<{ code: string }>().code).toBe('ARTIKEL_NOT_FOUND')
  })

  it('lehnt ein zu grosses Bild ab, statt es abzuschneiden', async () => {
    const res = await upload(
      `/api/v1/artikel/${artikelId}/fotos`,
      'image/png',
      Buffer.alloc(config.FOTOS_MAX_BYTES + 1024, 1),
    )
    expect(res.statusCode).toBe(413)
    expect(res.json<{ code: string }>().code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('loescht ein Bild samt Datei', async () => {
    const res = await upload(`/api/v1/artikel/${artikelId}/fotos`)
    const id = res.json<{ id: string }>().id
    const rows = await getDb().select().from(fotos).where(eq(fotos.id, id))
    const datei = join(FOTOS_DIR, rows[0]!.pfad)

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/fotos/${id}` })
    expect(del.statusCode).toBe(204)

    const rest = await getDb().select().from(fotos).where(eq(fotos.id, id))
    expect(rest).toHaveLength(0)
    await expect(stat(datei)).rejects.toThrow()
  })

  it('laedt ueber die PWA-Route (JWT) ein Bild hoch', async () => {
    const res = await upload(`/api/fotos/upload/${artikelId}`)
    expect(res.statusCode).toBe(200)
    const body = res.json<{ id: string; url: string }>()
    expect(body.url.startsWith(`/fotos/${artikelId}/`)).toBe(true)

    const rows = await getDb().select().from(fotos).where(eq(fotos.id, body.id))
    expect(rows).toHaveLength(1)
    const info = await stat(join(FOTOS_DIR, rows[0]!.pfad))
    expect(info.size).toBe(PNG.length)
  })

  it('lehnt auch ueber die PWA-Route ein zu grosses Bild ab', async () => {
    const res = await upload(
      `/api/fotos/upload/${artikelId}`,
      'image/png',
      Buffer.alloc(config.FOTOS_MAX_BYTES + 1024, 1),
    )
    expect(res.statusCode).toBe(413)
    expect(res.json<{ code: string }>().code).toBe('PAYLOAD_TOO_LARGE')
  })
})
