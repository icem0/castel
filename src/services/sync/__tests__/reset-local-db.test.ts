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
import { DB_NAME, resetLocalDbAndPull, wipeLocalDbWithoutPull } from '../reset-local-db'
import { _resetSyncForTests, startSyncWorker } from '../worker'

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
  // Der Reset-Flow suspendiert den Sync-Worker (Latch bis Reload) — der muss
  // pro Test neu gesetzt werden können, ohne andere Tests anzustecken.
  _resetSyncForTests()
  // Eigener DB-Name pro Test, damit deletes sich nicht überlagern.
  setDb(new CastelDb(`castel-reset-test-${Math.random().toString(36).slice(2)}`))
})

afterEach(() => {
  _resetSyncForTests()
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

  it('wirft, wenn der Server nicht erreichbar ist — die lokalen Daten sind bereits weg', async () => {
    // Arrange: ein Artikel ist lokal vorhanden.
    const dbName = `castel-failtest-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    const artikelId = neueUuid()
    const localDb = getDb()
    await localDb.artikel.add(artikelAnlage(artikelId, 'lokal'))
    expect(await localDb.artikel.count()).toBe(1)

    // Server nicht erreichbar
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    // Act + Assert: Fehler wird propagiert UND die Daten sind schon weg
    // (wipe passiert VOR dem Fetch — anders als früher).
    await expect(
      resetLocalDbAndPull({ token: null, apiBase: 'http://test.local' }),
    ).rejects.toThrow(/Failed to fetch|FetchError|Snapshot HTTP/)

    // Nach dem Reset zeigt getDb() auf eine frische Default-DB ('castel').
    // Wir prüfen die (gelöschte) Test-DB explizit neu.
    setDbLocal(new CastelDb(dbName))
    const reopened = getDb()
    expect(await reopened.artikel.count()).toBe(0)
    expect(await reopened.artikel.get(artikelId)).toBeUndefined()
  })

  it('holt den Snapshot NACH dem Wischen — Daten sind erst weg, dann neu befüllt', async () => {
    // Arrange: lokale Daten anlegen.
    const dbName = `castel-order-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    const localId = neueUuid()
    const localDb = getDb()
    await localDb.artikel.add(artikelAnlage(localId, 'lokal-vorhanden'))
    expect(await localDb.artikel.count()).toBe(1)

    // fetch löst sich erst auf, wenn wir es freigeben — so können wir
    // prüfen, dass der Wisch bereits passiert ist, während der Snapshot
    // noch aussteht.
    let resolveFetch!: (r: Response) => void
    const fetchPromise = new Promise<Response>((res) => {
      resolveFetch = res
    })
    const fetchMock = vi.fn(async () => fetchPromise)
    vi.stubGlobal('fetch', fetchMock)

    const p = resetLocalDbAndPull({ token: null, apiBase: 'http://test.local' })
    await new Promise((r) => setTimeout(r, 0))

    // DB ist bereits geleert, obwohl der Server-Antwort noch nicht da ist.
    setDbLocal(new CastelDb(dbName))
    expect(await getDb().artikel.count()).toBe(0)
    expect(await getDb().artikel.get(localId)).toBeUndefined()

    // Jetzt den Snapshot liefern (leer) und den Reset zu Ende bringen.
    const emptySnap = {
      serverTime: '2026-10-15T12:00:00.000Z',
      since: '',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [],
    }
    resolveFetch(
      new Response(JSON.stringify(emptySnap), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await p

    setDbLocal(new CastelDb(dbName))
    expect(await getDb().artikel.count()).toBe(0)
  })

  it('löscht die DB auch, wenn ein zweiter Tab sie offen hält (kein deleteDatabase-Block)', async () => {
    // Simuliert einen zweiten Browser-Tab: eine fremde Dexie-Instanz auf
    // denselben DB-Namen bleibt während des Resets offen. Mit einem
    // `deleteDatabase()` würde der Request blockieren und der Admin-Button
    // dauerhaft auf "läuft" stehen — der Reset muss trotzdem durchlaufen.
    const dbName = `castel-fremd-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'lokal-vorhanden'))

    const fremderTab = new CastelDb(dbName)
    await fremderTab.open()

    const snap = {
      serverTime: '2026-10-15T12:00:00.000Z',
      since: '',
      artikel: [artikelAnlage(neueUuid(), 'server-a')],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(snap), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const ergebnis = await Promise.race([
      resetLocalDbAndPull({ token: null, apiBase: 'http://test.local' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT: Reset hängt fest')), 5000),
      ),
    ])

    expect(ergebnis.pulled.artikel).toBe(1)
    // Der Reset hat die `dbName`-DB geleert und den Snapshot in die
    // (default-)DB geschrieben — wir prüfen beides getrennt.
    const geprueft = new CastelDb(dbName)
    expect(await geprueft.artikel.count()).toBe(0)

    fremderTab.close()
  })

  it('stellt auch mindestbestandEreignisse wieder her und setzt den Marker', async () => {
    const dbName = `castel-mindest-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'lokal-vorhanden'))

    const ereignisId = neueUuid()
    const snap = {
      serverTime: '2026-10-15T12:00:00.000Z',
      since: '',
      mindestSince: '2026-10-15T11:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [
        {
          id: ereignisId,
          artikelId: neueUuid(),
          standortId: neueUuid(),
          ausloeserBuchungId: neueUuid(),
          bestandDanach: 0,
          mindestbestand: 5,
          defizit: 5,
          erstelltAm: '2026-10-15T11:30:00.000Z',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(snap), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    const ergebnis = await resetLocalDbAndPull({ token: null, apiBase: 'http://test.local' })
    expect(ergebnis.pulled.mindestbestandEreignisse).toBe(1)
    expect(await getDb().mindestbestandEreignisse.get(ereignisId)).toBeDefined()
    const marker = await getDb().einstellungen.get(['mindestbestand.lastPullAt', ''])
    expect(marker?.value).toBe('2026-10-15T11:00:00.000Z')
  })
})

describe('wipeLocalDbWithoutPull', () => {
  it('leert die DB ohne Snapshot — kein Fetch, frische Instanz bleibt beschreibbar', async () => {
    const dbName = `castel-wipe-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    const localId = neueUuid()
    await getDb().artikel.add(artikelAnlage(localId, 'lokal-vorhanden'))
    expect(await getDb().artikel.count()).toBe(1)

    // Kein Snapshot-Pull: jeder Fetch wäre ein Fehler.
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch darf beim Wisch ohne Snapshot nicht aufgerufen werden')
    })
    vi.stubGlobal('fetch', fetchMock)

    const ergebnis = await wipeLocalDbWithoutPull()

    expect(ergebnis.deletedDb).toBe(DB_NAME)
    expect(fetchMock).not.toHaveBeenCalled()

    // Die gewischte Test-DB ist wirklich leer.
    setDbLocal(new CastelDb(dbName))
    expect(await getDb().artikel.count()).toBe(0)
    expect(await getDb().artikel.get(localId)).toBeUndefined()

    // Das Singleton zeigt auf eine frische, beschreibbare Instanz.
    const frisch = getDb()
    expect(await frisch.artikel.count()).toBe(0)
    await frisch.outbox.add({
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
    expect(await frisch.outbox.count()).toBe(1)
  })

  it('suspendiert den Sync-Worker, damit er die geleerte DB nicht sofort wieder füllt', async () => {
    const dbName = `castel-wipe-suspend-${Math.random().toString(36).slice(2)}`
    const { setDb: setDbLocal } = await import('../../../db/database')
    setDbLocal(new CastelDb(dbName))
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'lokal-vorhanden'))

    const fetchMock = vi.fn(async () => {
      throw new Error('kein Fetch erwartet')
    })
    vi.stubGlobal('fetch', fetchMock)

    await wipeLocalDbWithoutPull()

    // Mimics App.vue restarting the worker after the wipe: the suspend latch
    // must keep it from reopening/refilling the DB we just dropped.
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 50))

    expect(fetchMock).not.toHaveBeenCalled()

    setDbLocal(new CastelDb(dbName))
    expect(await getDb().artikel.count()).toBe(0)
  })
})
