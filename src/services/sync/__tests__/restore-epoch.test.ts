// Tests fuer die Restore-Epoche.
//
// Ein serverseitiger `pg_restore` ersetzt die komplette Server-DB durch
// einen alten Stand. Der inkrementelle Sync kann dazu NIE konvergieren:
//   * restaurierte Zeilen tragen alte `geaendert_am` und werden nie wieder
//     ausgeliefert (sie liegen vor `lastPullAt`),
//   * per Restore geloeschte Zeilen blieben lokal als Geister erhalten,
//   * Outbox/Einstellungen der Vor-Restore-Welt wuerden alten Stand in die
//     restaurierte Server-DB zurueckschreiben.
//
// Deshalb prueft der Worker VOR dem Push die Restore-Epoche und baut bei
// Abweichung die lokale IndexedDB komplett neu auf. Genau das testen wir.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, getDb, setDb } from '../../../db/database'
import type { Artikel } from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'

function artikelAnlage(id: string, titel: string): Artikel {
  const now = jetztIso()
  return {
    id,
    sharePointId: null,
    titel,
    status: 'verfuegbar',
    typ: 'Test',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: true,
    listenpreis: null,
    einkaufspreis: null,
    herstellerId: null,
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
    geaendertAm: now,
    erstelltAm: now,
  }
}

/** Snapshot-Antwort des Servers (vollstaendig, ohne `since`). */
function snapshot(epoch: string | null, artikel: Artikel[] = []): Record<string, unknown> {
  return {
    serverTime: '2026-10-15T12:00:00.000Z',
    since: '',
    restoreEpoch: epoch,
    artikel,
    standorte: [],
    commission: [],
    buchungen: [],
    einstellungen: [],
    mindestbestandEreignisse: [],
  }
}

beforeEach(async () => {
  setDb(new CastelDb(`castel-epoch-${Math.random().toString(36).slice(2)}`))
  const mod = await import('../worker')
  mod._resetSyncForTests()
  localStorage.removeItem('castel.auth.session')
})

afterEach(async () => {
  const mod = await import('../worker')
  mod._resetSyncForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Restore-Epoche (Sync-Worker)', () => {
  it('baut die lokale DB neu auf, wenn der Server nach einem Restore eine neue Epoche meldet', async () => {
    // Arrange: lokaler Altbestand (Geister-Artikel + Outbox-Item der
    // Vor-Restore-Welt) und ein lokaler Epoch-Marker mit altem Wert.
    const geistId = neueUuid()
    await getDb().artikel.add(artikelAnlage(geistId, 'geist-aus-vor-restore'))
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'artikel',
      op: 'create',
      payload: JSON.stringify({ id: neueUuid() }),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })
    await getDb().einstellungen.put({
      key: 'server.restoreEpoch',
      userId: '',
      value: '2026-10-01T00:00:00.000Z',
      geaendertAm: jetztIso(),
    })

    const serverArtikel = artikelAnlage(neueUuid(), 'aus-restauriertem-stand')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/api/sync/restore-epoch')) {
        return new Response(JSON.stringify({ restoreEpoch: '2026-10-15T12:00:00.000Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(JSON.stringify(snapshot('2026-10-15T12:00:00.000Z', [serverArtikel])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/push') && method === 'POST') {
        throw new Error('Push darf nach erkanntem Restore nicht laufen')
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T12:00:00.000Z',
            counts: { artikel: 1, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Act
    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    // Assert: Die lokale DB wurde hart geloescht und neu befuellt.
    const db = getDb()
    expect(await db.artikel.count()).toBe(1)
    expect(await db.artikel.get(geistId)).toBeUndefined()
    expect((await db.artikel.get(serverArtikel.id))?.titel).toBe('aus-restauriertem-stand')
    // Die Outbox der Vor-Restore-Welt ist weg — sonst wuerde sie alten Stand
    // in die restaurierte Server-DB zurueckschreiben.
    expect(await db.outbox.count()).toBe(0)
    // Epoche lokal gemerkt -> der naechste Tick loest keinen weiteren Reset aus.
    const marker = await db.einstellungen.get(['server.restoreEpoch', ''])
    expect(marker?.value).toBe('2026-10-15T12:00:00.000Z')
    // Der Push wurde nie abgesetzt.
    const pushCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/sync/push'))
    expect(pushCalls.length).toBe(0)
  })

  it('loest keinen Reset aus, wenn die Epoche unveraendert ist', async () => {
    const artikelId = neueUuid()
    await getDb().artikel.add(artikelAnlage(artikelId, 'lokal'))
    await getDb().einstellungen.put({
      key: 'server.restoreEpoch',
      userId: '',
      value: '2026-10-15T12:00:00.000Z',
      geaendertAm: jetztIso(),
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/restore-epoch')) {
        return new Response(JSON.stringify({ restoreEpoch: '2026-10-15T12:00:00.000Z' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(JSON.stringify(snapshot('2026-10-15T12:00:00.000Z')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T12:00:00.000Z',
            counts: { artikel: 1, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    // Lokale Daten sind unveraendert (kein Wipe).
    const db = getDb()
    expect(await db.artikel.count()).toBe(1)
    expect(await db.artikel.get(artikelId)).toBeDefined()
  })

  it('arbeitet normal weiter, wenn der Server keine Epoche meldet (alter Server)', async () => {
    const artikelId = neueUuid()
    await getDb().artikel.add(artikelAnlage(artikelId, 'lokal'))

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/restore-epoch')) {
        return new Response(JSON.stringify({ restoreEpoch: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(JSON.stringify(snapshot(null)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T12:00:00.000Z',
            counts: { artikel: 1, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const db = getDb()
    expect(await db.artikel.count()).toBe(1)
    expect(await db.artikel.get(artikelId)).toBeDefined()
  })

  it('behandelt einen 404 des Epoch-Endpunkts als "kein Restore" (kein Abbruch)', async () => {
    const artikelId = neueUuid()
    await getDb().artikel.add(artikelAnlage(artikelId, 'lokal'))

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/restore-epoch')) {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(JSON.stringify(snapshot(null)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T12:00:00.000Z',
            counts: { artikel: 1, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const db = getDb()
    expect(await db.artikel.count()).toBe(1)
    expect(await db.artikel.get(artikelId)).toBeDefined()
  })
})
