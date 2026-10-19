// Tests für den "Lokale DB löschen & Snapshot ziehen"-Flow.
//
// Wir testen die Kernlogik:
//  1) Lokale DB wird komplett geleert
//  2) Snapshot wird vom Server geholt
//  3) Snapshot wird in die frische DB geschrieben
//  4) lastPullAt-Marker ist gesetzt
//
// window.location.reload wird gemockt, weil jsdom keine echte Page-Navigation
// durchführen kann und wir den Reload sonst nicht mehr abfangen würden.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, getDb, setDb } from '../../../db/database'
import type { Artikel, Einstellung, Standort } from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'
import { DB_NAME, resetLocalDbAndPull } from '../reset-local-db'

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
    listenpreis: null,
    geaendertAm: now,
    erstelltAm: now,
  }
}

function standortAnlage(id: string, name: string): Standort {
  const now = jetztIso()
  return {
    id,
    name,
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard: true,
    archiviert: false,
    geaendertAm: now,
    erstelltAm: now,
  }
}

beforeEach(() => {
  // Eigener DB-Name pro Test, damit deletes sich nicht überlagern.
  setDb(new CastelDb(`castel-reset-test-${Math.random().toString(36).slice(2)}`))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resetLocalDbAndPull', () => {
  it('löscht lokale Daten und füllt sie mit dem Server-Snapshot neu', async () => {
    // Arrange: lokale Daten anlegen
    const localId = neueUuid()
    const a = artikelAnlage(localId, 'lokal-vorhanden')
    await getDb().artikel.add(a)
    expect(await getDb().artikel.count()).toBe(1)

    // Server-Snapshot, der den lokalen Artikel NICHT enthält und dafür
    // andere anbietet.
    const serverId1 = neueUuid()
    const serverId2 = neueUuid()
    const standortId = neueUuid()
    const serverSnap = {
      serverTime: '2026-10-15T12:00:00.000Z',
      since: '',
      artikel: [artikelAnlage(serverId1, 'server-a'), artikelAnlage(serverId2, 'server-b')],
      standorte: [standortAnlage(standortId, 'Hauptlager')],
      commission: [],
      buchungen: [],
      einstellungen: [
        {
          key: 'artikelTypen',
          userId: null,
          value: '["Test"]',
          geaendertAm: '2026-10-15T12:00:00.000Z',
        } satisfies Einstellung,
      ],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        return new Response(JSON.stringify(serverSnap), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Act
    const result = await resetLocalDbAndPull({
      token: null,
      apiBase: 'http://test.local',
    })

    // Assert: zurückgegebene Counts
    expect(result.deletedDb).toBe(DB_NAME)
    expect(result.pulled.artikel).toBe(2)
    expect(result.pulled.standorte).toBe(1)
    expect(result.pulled.einstellungen).toBe(1)
    // Reload wird vom Aufrufer (App.vue) getriggert, nicht vom Service.
    expect(result.reloaded).toBe(false)

    // Snapshot wurde in die (neue) DB geschrieben
    const db = getDb()
    expect(await db.artikel.count()).toBe(2)
    const fetched = await db.artikel.get(serverId1)
    expect(fetched?.titel).toBe('server-a')
    expect(await db.standorte.count()).toBe(1)
    const settings = await db.einstellungen.get(['artikelTypen', ''])
    expect(settings?.value).toBe('["Test"]')

    // Lokaler "Geist"-Artikel aus vor dem Reset ist weg.
    const ghost = await db.artikel.get(localId)
    expect(ghost).toBeUndefined()

    // lastPullAt-Marker wurde gesetzt.
    const lastPull = await db.einstellungen.get(['sync.lastPullAt', ''])
    expect(lastPull?.value).toBe('2026-10-15T12:00:00.000Z')
  })

  it('setzt das Outbox-Singleton nach dem Reset neu (kein "Connection-Closed"-Fehler beim Schreiben)', async () => {
    // Lokale Outbox mit pending Item
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
    expect(await getDb().outbox.count()).toBe(1)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T12:00:00.000Z',
            since: '',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await resetLocalDbAndPull({
      token: null,
      apiBase: 'http://test.local',
    })

    // Outbox muss nach dem Reset leer sein (DB wurde gedroppt).
    // Wichtig ist, dass der Aufruf nicht mit "Connection has been closed"
    // fehlschlägt.
    expect(await getDb().outbox.count()).toBe(0)
  })

  it('wirft, wenn der Server nicht erreichbar ist — die DB bleibt gelöscht', async () => {
    // Arrange: ein Artikel ist lokal vorhanden.
    const dbName = `castel-failtest-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    const localDb = getDb()
    await localDb.artikel.add(artikelAnlage(neueUuid(), 'lokal'))
    expect(await localDb.artikel.count()).toBe(1)

    // Server nicht erreichbar
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Act + Assert: Fehler wird propagiert
    await expect(
      resetLocalDbAndPull({ token: null, apiBase: 'http://test.local' }),
    ).rejects.toThrow(/Failed to fetch|FetchError|Snapshot HTTP/)

    // DB ist weg: beim erneuten Öffnen mit demselben Namen gibt es
    // keine Artikel mehr. Der User hat eine leere App und kann den
    // Reset erneut versuchen.
    setDbLocal(new CastelDb(dbName))
    const reopened = getDb()
    expect(await reopened.artikel.count()).toBe(0)
  })
})
