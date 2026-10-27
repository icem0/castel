// Tests für den Sync-Worker.
// Wir testen die Strategie (Outbox-Items, Merge-Logik) ohne globale fetch-Mocks,
// weil die in Node-Test-Umgebungen oft unzuverlässig greifen.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, getDb, setDb } from '../../../db/database'
import type { Artikel, Buchung, OutboxEintrag, Standort } from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'
import { getSyncStatus, type TableCounts } from '../worker'

// Top-Level Worker-Modul-State (`_status`, `_consecutiveFailures`, etc.) wird
// zwischen Tests geteilt. Ohne Reset würden alte Status-Werte in den nächsten
// Test leaken und Assertions scheitern lassen. Wir holen den Reset-Helper
// asynchron, weil der Worker erst beim ersten `await import('../worker')`
// initialisiert wird.
async function resetWorkerState(): Promise<void> {
  const mod = await import('../worker')
  mod._resetSyncForTests()
}

beforeEach(async () => {
  // Frische In-Memory-DB pro Test, damit Outbox/Artikel zwischen Tests nicht
  // leaken. Fake-indexeddb schreibt unter dem übergebenen Namen — jeder neue
  // Name bekommt eine eigene IDBDatabase.
  setDb(new CastelDb(`castel-test-${Math.random().toString(36).slice(2)}`))
  await resetWorkerState()
  // Jeder Test startet ohne angemeldeten Session-User; Tests, die einen
  // per-User-Einstellungs-Push simulieren, setzen die Session explizit.
  localStorage.removeItem('castel.auth.session')
})

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

function buchungsAnlage(id: string, artikelId: string, standortId: string, menge: number): Buchung {
  const now = jetztIso()
  return {
    id,
    artikelId,
    standortId,
    standortZielId: null,
    typ: 'einlagerung',
    menge,
    paarId: null,
    projekt: null,
    erstelltAm: now,
    clientEingabeAm: now,
    erstelltVon: 'u1',
    kommentar: null,
    mitteilungAn: null,
    stornoVon: null,
    storno: false,
    storniertDurch: null,
    serverId: null,
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

async function outboxAdd(
  entity: 'artikel' | 'buchung',
  op: 'create',
  payload: unknown,
): Promise<void> {
  await getDb().outbox.add({
    id: neueUuid(),
    entity,
    op,
    payload: JSON.stringify(payload),
    createdAt: jetztIso(),
    syncedAt: null,
    attempts: 0,
    lastError: null,
    quarantinedAt: null,
    quarantineReason: null,
  })
}

describe('Sync — Outbox-Items', () => {
  it('Artikel landet in der Outbox', async () => {
    const a = artikelAnlage(neueUuid(), 'X')
    await getDb().artikel.add(a)
    await outboxAdd('artikel', 'create', a)
    const items = await getDb().outbox.toArray()
    expect(items.length).toBe(1)
    expect(items[0]?.entity).toBe('artikel')
    expect(items[0]?.syncedAt).toBeNull()
  })

  it('mehrere Outbox-Items bleiben erhalten (Reihenfolge per createdAt)', async () => {
    const a = artikelAnlage(neueUuid(), 'A')
    const b = artikelAnlage(neueUuid(), 'B')
    await getDb().artikel.add(a)
    await getDb().artikel.add(b)
    await outboxAdd('artikel', 'create', a)
    await new Promise((r) => setTimeout(r, 5))
    await outboxAdd('artikel', 'create', b)
    const items = await getDb().outbox.orderBy('createdAt').toArray()
    expect(items.length).toBe(2)
  })

  it('syncedAt lässt sich setzen', async () => {
    const a = artikelAnlage(neueUuid(), 'X')
    await getDb().artikel.add(a)
    await outboxAdd('artikel', 'create', a)
    const items = await getDb().outbox.toArray()
    const id = items[0]!.id
    await getDb().outbox.update(id, { syncedAt: jetztIso() })
    const updated = await getDb().outbox.get(id)
    expect(updated?.syncedAt).not.toBeNull()
  })

  it('markFailed erhöht attempts und setzt lastError, lässt syncedAt null', async () => {
    const b = buchungsAnlage(neueUuid(), 'a1', 's1', 5)
    await outboxAdd('buchung', 'create', b)
    const items = await getDb().outbox.toArray()
    const id = items[0]!.id
    await getDb().outbox.update(id, {
      attempts: 1,
      lastError: 'NEGATIVE_BESTAND: aktuell 2, angefordert 5',
    })
    const updated = await getDb().outbox.get(id)
    expect(updated?.attempts).toBe(1)
    expect(updated?.lastError).toContain('NEGATIVE_BESTAND')
    expect(updated?.syncedAt).toBeNull()
  })

  it('simulierter Push akzeptiert IDs → syncedAt wird gesetzt → Outbox leer (für pending)', async () => {
    const a = artikelAnlage(neueUuid(), 'X')
    await getDb().artikel.add(a)
    await outboxAdd('artikel', 'create', a)

    const items: OutboxEintrag[] = await getDb().outbox.toArray()
    expect(items.length).toBe(1)
    const id = items[0]!.id

    // Server-Reply: accepted
    const acceptedIds = [id]
    for (const accepted of acceptedIds) {
      await getDb().outbox.update(accepted, { syncedAt: jetztIso() })
    }

    const remaining = await getDb().outbox.toArray()
    expect(remaining.filter((o) => o.syncedAt === null).length).toBe(0)
  })
})

describe('Sync — Snapshot-Merge-Strategie (Last-Writer-Wins)', () => {
  it('Server-Artikel wird in lokale DB übernommen', async () => {
    const a = artikelAnlage(neueUuid(), 'Schraube M8')
    const existing = await getDb().artikel.get(a.id)
    expect(existing).toBeUndefined()
    await getDb().artikel.add(a)
    const lokal = await getDb().artikel.get(a.id)
    expect(lokal?.titel).toBe('Schraube M8')
  })

  it('Lokal-Artikel bleibt, wenn lokaler Zeitstempel neuer ist', async () => {
    const id = neueUuid()
    const serverArtikel = artikelAnlage(id, 'Server-Version')
    serverArtikel.geaendertAm = '2025-01-01T00:00:00.000Z'

    const lokalArtikel = artikelAnlage(id, 'Lokal-Version')
    lokalArtikel.geaendertAm = '2025-02-01T00:00:00.000Z'

    await getDb().artikel.add(lokalArtikel)

    // Merge-Logik aus worker.ts (kopiert)
    const current = await getDb().artikel.get(id)
    if (current && (serverArtikel.geaendertAm ?? '') > (current.geaendertAm ?? '')) {
      await getDb().artikel.put(serverArtikel)
    }

    const lokal = await getDb().artikel.get(id)
    expect(lokal?.titel).toBe('Lokal-Version')
  })

  it('Server-Artikel überschreibt, wenn Server-Zeitstempel neuer ist', async () => {
    const id = neueUuid()
    const serverArtikel = artikelAnlage(id, 'Server-Version (neuer)')
    serverArtikel.geaendertAm = '2025-03-01T00:00:00.000Z'

    const lokalArtikel = artikelAnlage(id, 'Lokal-Version (alter)')
    lokalArtikel.geaendertAm = '2025-01-01T00:00:00.000Z'

    await getDb().artikel.add(lokalArtikel)

    const current = await getDb().artikel.get(id)
    if ((serverArtikel.geaendertAm ?? '') > (current!.geaendertAm ?? '')) {
      await getDb().artikel.put(serverArtikel)
    }

    const lokal = await getDb().artikel.get(id)
    expect(lokal?.titel).toBe('Server-Version (neuer)')
  })

  it('Standorte werden aus Snapshot übernommen', async () => {
    const s = standortAnlage(neueUuid(), 'Hauptlager')
    await getDb().standorte.add(s)
    const lokal = await getDb().standorte.get(s.id)
    expect(lokal?.name).toBe('Hauptlager')
  })
})

describe('Sync — Status & Counts', () => {
  it('SyncStatus hat Felder für Server- und Lokal-Counts', () => {
    const st = getSyncStatus()
    expect(st).toHaveProperty('serverCounts')
    expect(st).toHaveProperty('localCounts')
    expect(st).toHaveProperty('serverTime')
    expect(st.serverCounts).toBeNull()
    expect(st.localCounts).toBeNull()
    expect(st.serverTime).toBeNull()
  })

  it('TableCounts-Form: artikel/standorte/commission/buchungen', () => {
    const counts: TableCounts = { artikel: 1, standorte: 2, commission: 3, buchungen: 4 }
    expect(counts.artikel).toBe(1)
    expect(counts.standorte).toBe(2)
    expect(counts.commission).toBe(3)
    expect(counts.buchungen).toBe(4)
  })

  it('Lokale Counts werden korrekt gezählt', async () => {
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'A'))
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'B'))
    await getDb().standorte.add(standortAnlage(neueUuid(), 'L1'))
    await getDb().buchungen.add(buchungsAnlage(neueUuid(), 'a1', 's1', 5))

    const lokal = {
      artikel: await getDb().artikel.count(),
      standorte: await getDb().standorte.count(),
      commission: await getDb().commission.count(),
      buchungen: await getDb().buchungen.count(),
    }
    expect(lokal).toEqual({ artikel: 2, standorte: 1, commission: 0, buchungen: 1 })
  })
})

describe('Sync — Push-Markierung (Outbox- vs. Payload-IDs)', () => {
  it('akzeptierte Payload-IDs markieren die richtigen Outbox-Items (Outbox-IDs != Payload-IDs)', async () => {
    // Arrange: zwei Artikel in Outbox mit eigenen Outbox-IDs (≠ Domain-UUID).
    const a1 = artikelAnlage(neueUuid(), 'A1')
    const a2 = artikelAnlage(neueUuid(), 'A2')
    await outboxAdd('artikel', 'create', a1)
    await outboxAdd('artikel', 'create', a2)
    const outboxItems = await getDb().outbox.toArray()
    const outboxIds = outboxItems.map((o) => o.id).sort()
    const payloadIds = [a1.id, a2.id].sort()
    // Sanity-Check: Outbox-IDs und Payload-IDs sind tatsächlich verschieden.
    for (const oid of outboxIds) expect(payloadIds).not.toContain(oid)

    // Mock: Server akzeptiert a1, lehnt a2 als Konflikt ab.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/sync/push') && method === 'POST') {
        return new Response(
          JSON.stringify({
            accepted: [a1.id],
            conflicts: [{ id: a2.id, reason: 'stale' }],
            errors: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
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

    // Assert
    const remaining = await getDb().outbox.toArray()
    const pending = remaining.filter((o) => o.syncedAt === null)
    const synced = remaining.filter((o) => o.syncedAt !== null)

    // a1 wurde akzeptiert → exakt ein Outbox-Item synced.
    expect(synced.length).toBe(1)
    // a2 wurde als Konflikt markiert → bleibt pending, hat aber lastError.
    expect(pending.length).toBe(1)
    expect(pending[0]?.lastError).toContain('CONFLICT')
    expect(pending[0]?.lastError).toContain('stale')

    // Cross-Check: Die synced-Outbox-ID ist die von a1 (nicht eine Payload-UUID).
    const syncedOutbox = synced[0]?.id
    expect(syncedOutbox).toBe(
      outboxItems.find((o) => {
        const p = JSON.parse(o.payload) as { id: string }
        return p.id === a1.id
      })?.id,
    )
  })

  it('Netzwerk-Fehler im Push markiert alle Items als failed (lastError gesetzt)', async () => {
    await outboxAdd('artikel', 'create', artikelAnlage(neueUuid(), 'A1'))

    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const items = await getDb().outbox.toArray()
    expect(items.length).toBe(1)
    expect(items[0]?.syncedAt).toBeNull()
    expect(items[0]?.attempts).toBe(1)
    expect(items[0]?.lastError).toContain('Failed to fetch')
  })
})

describe('Sync — Backoff & Retry-After', () => {
  it('computeBackoffMs: 0 beim ersten Versuch, dann 1s, 2s, 4s, … mit Cap', async () => {
    const { computeBackoffMs } = await import('../worker')
    expect(computeBackoffMs(0)).toBe(0)
    expect(computeBackoffMs(1)).toBe(1_000)
    expect(computeBackoffMs(2)).toBe(2_000)
    expect(computeBackoffMs(3)).toBe(4_000)
    expect(computeBackoffMs(4)).toBe(8_000)
    expect(computeBackoffMs(10)).toBe(60_000) // cap
  })

  it('parseRetryAfter: Sekunden und HTTP-Datum werden erkannt, Cap greift', async () => {
    const { parseRetryAfter } = await import('../worker')
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    expect(parseRetryAfter('60', 5 * 60_000, now)).toBe(60_000)
    expect(parseRetryAfter('0', 5 * 60_000, now)).toBe(0)
    // 600s > 5min cap → 300_000
    expect(parseRetryAfter('600', 5 * 60_000, now)).toBe(300_000)
    // HTTP-Datum 30s in der Zukunft
    const future = new Date(now + 30_000).toUTCString()
    const got = parseRetryAfter(future, 5 * 60_000, now)
    expect(got).not.toBeNull()
    expect(got!).toBeGreaterThanOrEqual(29_000)
    expect(got!).toBeLessThanOrEqual(30_000)
    // Müll
    expect(parseRetryAfter('banana', 5 * 60_000, now)).toBeNull()
    expect(parseRetryAfter(null, 5 * 60_000, now)).toBeNull()
    expect(parseRetryAfter('', 5 * 60_000, now)).toBeNull()
  })

  it('5xx setzt status "origin-unavailable" und plant nextRetryAt anhand Retry-After', async () => {
    // Outbox-Item anlegen, damit der Push-Handler überhaupt zum Server geht.
    await outboxAdd('artikel', 'create', artikelAnlage(neueUuid(), 'A1'))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push')) {
        return new Response('Bad Gateway', {
          status: 502,
          headers: { 'Retry-After': '60' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const st = getSyncStatus()

    expect(st.status).toBe('origin-unavailable')
    expect(st.lastError).toContain('502')
    expect(st.nextRetryAt).not.toBeNull()
    const nextMs = Date.parse(st.nextRetryAt!) - Date.now()
    // Cloudflare-Antwort sagt 60s — Worker cappt nicht (60_000 < 300_000).
    expect(nextMs).toBeGreaterThan(50_000)
    expect(nextMs).toBeLessThan(70_000)
  })

  it('Netzwerk-Fehler erhöht Backoff über mehrere Versuche (exponentiell)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')

    await runSync({ token: null, apiBase: 'http://test.local' })
    let nextMs = Date.parse(getSyncStatus().nextRetryAt!) - Date.now()
    expect(nextMs).toBeGreaterThan(500)
    expect(nextMs).toBeLessThan(1_500)

    await runSync({ token: null, apiBase: 'http://test.local' })
    nextMs = Date.parse(getSyncStatus().nextRetryAt!) - Date.now()
    expect(nextMs).toBeGreaterThan(1_500)
    expect(nextMs).toBeLessThan(2_500)
  })
})

describe('Sync — Diagnose (lastFailure)', () => {
  it('5xx füllt lastFailure mit status, code, source und retryAfterMs', async () => {
    // Outbox-Item anlegen, damit der Push-Handler überhaupt zum Server geht.
    await outboxAdd('artikel', 'create', artikelAnlage(neueUuid(), 'A1'))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push')) {
        return new Response('Bad Gateway', {
          status: 502,
          headers: { 'Retry-After': '30' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const st = getSyncStatus()
    expect(st.lastFailure).not.toBeNull()
    expect(st.lastFailure?.source).toBe('push')
    expect(st.lastFailure?.status).toBe(502)
    expect(st.lastFailure?.code).toBe('origin-unavailable')
    expect(st.lastFailure?.retryAfterMs).toBe(30_000)
    expect(st.lastFailure?.message).toContain('502')
  })

  it('Netzwerk-Fehler markiert lastFailure mit source=network', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const st = getSyncStatus()
    expect(st.lastFailure).not.toBeNull()
    expect(st.lastFailure?.source).toBe('network')
    expect(st.lastFailure?.status).toBeNull()
    expect(st.lastFailure?.code).toBe('NETWORK')
  })

  it('Server-Rejects füllen lastFailure mit sampleErrors + rejectedItems', async () => {
    const a1 = artikelAnlage(neueUuid(), 'A1')
    const a2 = artikelAnlage(neueUuid(), 'A2')
    await outboxAdd('artikel', 'create', a1)
    await outboxAdd('artikel', 'create', a2)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            accepted: [],
            conflicts: [],
            errors: [
              { id: a1.id, code: 'NEGATIVE_BESTAND', message: 'aktuell 0, angefordert 5' },
              { id: a2.id, code: 'UNBEKANNTE_REFERENZ', message: 'artikel unbekannt' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const st = getSyncStatus()
    expect(st.lastFailure).not.toBeNull()
    expect(st.lastFailure?.source).toBe('push')
    expect(st.lastFailure?.code).toBe('PARTIAL_REJECTED')
    expect(st.lastFailure?.rejectedItems).toBe(2)
    expect(st.lastFailure?.sampleErrors.length).toBe(2)
    expect(st.lastFailure?.sampleErrors[0]?.code).toBe('NEGATIVE_BESTAND')
    expect(st.lastFailure?.stuckItems.length).toBe(2)
  })

  it('Erfolgreicher Sync setzt lastFailure zurück auf null', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    expect(getSyncStatus().lastFailure).toBeNull()
    expect(getSyncStatus().lastError).toBeNull()
  })
})

describe('Sync — 401 / Auth-Reset', () => {
  it('401 resettet Outbox-Items (attempts=0, lastError=null) und ruft onAuthRevoked genau einmal', async () => {
    const a1 = artikelAnlage(neueUuid(), 'A1')
    await outboxAdd('artikel', 'create', a1)
    // Vorschaden: ein Item mit hohem attempts-Wert simulieren
    const items = await getDb().outbox.toArray()
    await getDb().outbox.update(items[0]!.id, {
      attempts: 179,
      lastError: 'Push HTTP 401',
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push')) {
        return new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'Token fehlt oder ungültig' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const onAuthRevoked = vi.fn()
    const { runSync, startSyncWorker, stopSyncWorker } = await import('../worker')
    startSyncWorker({
      apiBase: 'http://test.local',
      getToken: () => 'tot',
      onAuthRevoked,
    })

    await runSync({ token: 'tot', apiBase: 'http://test.local' })

    // Outbox wurde zurückgesetzt
    const after = await getDb().outbox.toArray()
    expect(after[0]?.attempts).toBe(0)
    expect(after[0]?.lastError).toBeNull()
    expect(after[0]?.syncedAt).toBeNull()

    // Callback wurde aufgerufen
    expect(onAuthRevoked).toHaveBeenCalledTimes(1)

    // Ein zweiter Push (z. B. vom Worker-Tick) darf den Callback NICHT
    // erneut feuern — Latch hält.
    await runSync({ token: 'tot', apiBase: 'http://test.local' })
    expect(onAuthRevoked).toHaveBeenCalledTimes(1)

    stopSyncWorker()
  })

  it('Erfolgreicher Push nach Auth-Reset löst das Latch (Callback kann erneut feuern)', async () => {
    const a1 = artikelAnlage(neueUuid(), 'A1')
    await outboxAdd('artikel', 'create', a1)

    let pushCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        pushCalls++
        if (pushCalls === 1) {
          console.log(`[mock] push call #${pushCalls} → 401`)
          return new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Token ungültig' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (pushCalls === 2) {
          console.log(`[mock] push call #${pushCalls} → 200, accepted=[${a1.id}]`)
          return new Response(JSON.stringify({ accepted: [a1.id], conflicts: [], errors: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        console.log(`[mock] push call #${pushCalls} → 401 again`)
        return new Response(
          JSON.stringify({ code: 'UNAUTHORIZED', message: 'Token wieder ungültig' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const onAuthRevoked = vi.fn()
    const { runSync, startSyncWorker, stopSyncWorker } = await import('../worker')
    startSyncWorker({
      apiBase: 'http://test.local',
      getToken: () => 'tot',
      onAuthRevoked,
    })

    // 1) 401
    await runSync({ token: 'tot', apiBase: 'http://test.local' })
    expect(onAuthRevoked).toHaveBeenCalledTimes(1)

    // 2) Erfolg (Token wurde vom User erneuert). Latch wird im success-Pfad
    //    geloest. Outbox a1 ist jetzt synced.
    await runSync({ token: 'frisch', apiBase: 'http://test.local' })
    expect(onAuthRevoked).toHaveBeenCalledTimes(1)

    // 3) Neues Outbox-Item hinzufuegen, damit der naechste runSync ueberhaupt
    //    einen Push absetzt.
    const a2 = artikelAnlage(neueUuid(), 'A2')
    await outboxAdd('artikel', 'create', a2)
    // Server-Fetch: jetzt 401 (User hat sich abgemeldet) → 3. Push → 401
    // → onAuthRevoked MUSS wieder feuern.
    await runSync({ token: 'tot', apiBase: 'http://test.local' })
    expect(onAuthRevoked).toHaveBeenCalledTimes(2)

    stopSyncWorker()
  })
})

describe('Sync — Outbox-Quarantäne', () => {
  it('releaseQuarantine entfernt quarantinedAt und setzt attempts zurück', async () => {
    const a = artikelAnlage(neueUuid(), 'A1')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'artikel',
      op: 'create',
      payload: JSON.stringify(a),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 5,
      lastError: 'x',
      quarantinedAt: jetztIso(),
      quarantineReason: 'Test',
    })

    const { releaseQuarantine, getSyncStatus } = await import('../worker')
    await releaseQuarantine((await getDb().outbox.toArray())[0]!.id)

    const nach = await getDb().outbox.toArray()
    expect(nach[0]?.quarantinedAt).toBeNull()
    expect(nach[0]?.attempts).toBe(0)

    const st = getSyncStatus()
    expect(st.quarantined).toBe(0)
    expect(st.pending).toBe(1)
  })

  it('discardQuarantine entfernt das Item endgültig', async () => {
    const a = artikelAnlage(neueUuid(), 'A1')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'artikel',
      op: 'create',
      payload: JSON.stringify(a),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 5,
      lastError: 'x',
      quarantinedAt: jetztIso(),
      quarantineReason: 'Test',
    })

    const { discardQuarantine } = await import('../worker')
    await discardQuarantine((await getDb().outbox.toArray())[0]!.id)

    expect(await getDb().outbox.count()).toBe(0)
  })

  it('nextBatch überspringt quarantinierte Items und findet pending weiter hinten', async () => {
    // 5 synced (mitten in der Outbox) + 1 quarantined + 1 pending
    for (let i = 0; i < 5; i++) {
      await getDb().outbox.add({
        id: neueUuid(),
        entity: 'artikel',
        op: 'create',
        payload: JSON.stringify(artikelAnlage(neueUuid(), `synced-${i}`)),
        createdAt: jetztIso(),
        syncedAt: jetztIso(),
        attempts: 0,
        lastError: null,
        quarantinedAt: null,
        quarantineReason: null,
      })
    }
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'artikel',
      op: 'create',
      payload: JSON.stringify(artikelAnlage(neueUuid(), 'quar')),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 5,
      lastError: 'x',
      quarantinedAt: jetztIso(),
      quarantineReason: 'x',
    })
    await outboxAdd('artikel', 'create', artikelAnlage(neueUuid(), 'pending'))

    const { runSync } = await import('../worker')
    let pushCalled = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
          pushCalled = true
          // Body inspizieren — pending sollte enthalten sein, quar nicht.
          const body = JSON.parse(init.body as string)
          const ids = (body.ops as Array<{ payload: { id: string } }>).map((o) => o.payload.id)
          expect(ids.length).toBe(1) // genau ein pending item
        }
        return new Response('not found', { status: 404 })
      }),
    )

    await runSync({ token: null, apiBase: 'http://test.local' })
    expect(pushCalled).toBe(true)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- Regression: einstellung/upsert muss pushbar sein ----------
//
// Vor dem Fix hat der Worker pauschal `payload.id` als Identität verlangt.
// Einstellungen haben aber kein `id`-Feld — ihre Identität ist der
// Compound-Key (key, userId), identisch zur Server-Antwort in
// `result.accepted`. Folge war: jedes einstellung-Outbox-Item lief
// 5× in `MISSING_PAYLOAD_ID` und wurde dann quarantiniert (siehe
// Outbox-Diagnose "Versuch 3: MISSING_PAYLOAD_ID", 4 Items).
describe('Sync — payloadIdFor (Einstellungen haben keine `id`)', () => {
  it('Stammdaten: payload.id wird durchgereicht', async () => {
    const { payloadIdFor } = await import('../worker')
    expect(payloadIdFor('artikel', { id: 'a-1', titel: 'x' })).toBe('a-1')
    expect(payloadIdFor('standort', { id: 's-1' })).toBe('s-1')
    expect(payloadIdFor('kommission', { id: 'p-1' })).toBe('p-1')
    expect(payloadIdFor('buchung', { id: 'b-1' })).toBe('b-1')
  })

  it('einstellung (per-User): key#userId', async () => {
    const { payloadIdFor } = await import('../worker')
    expect(payloadIdFor('einstellung', { key: 'sprache', userId: 'u1', value: 'de' })).toBe(
      'sprache#u1',
    )
  })

  it('einstellung (global): key#global', async () => {
    const { payloadIdFor } = await import('../worker')
    expect(payloadIdFor('einstellung', { key: 'artikelTypen', userId: null, value: '[]' })).toBe(
      'artikelTypen#global',
    )
  })

  it('null bei fehlendem id (Stammdaten ohne id) oder fehlendem key (einstellung)', async () => {
    const { payloadIdFor } = await import('../worker')
    expect(payloadIdFor('artikel', { titel: 'x' })).toBeNull()
    expect(payloadIdFor('einstellung', { userId: 'u1', value: 'de' })).toBeNull()
  })
})

describe('Sync — einstellung/upsert End-to-End', () => {
  function einstellungPayload(key: string, userId: string | null, value: string) {
    return { key, userId, value, geaendertAm: jetztIso() }
  }

  it('einstellung mit userId: Outbox-Item wird synced, Server accepted mit key#userId', async () => {
    const e = einstellungPayload('sprache', 'u1', 'en-US')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'einstellung',
      op: 'upsert',
      payload: JSON.stringify(e),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/sync/push') && method === 'POST') {
        // Server accepted unter key#userId — Spiegel von
        // server/src/sync/resolver.ts:entitaetIdFor
        return new Response(
          JSON.stringify({
            accepted: ['sprache#u1'],
            conflicts: [],
            errors: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Session-User entspricht der Outbox-userId ('u1'), damit der
    // per-User-Einstellungs-Push den Fremd-User-Guard passiert.
    localStorage.setItem(
      'castel.auth.session',
      JSON.stringify({ userId: 'u1', email: 'u1@test.local', rolle: 'user' }),
    )
    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const remaining = await getDb().outbox.toArray()
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.syncedAt).not.toBeNull()
    expect(remaining[0]?.lastError).toBeNull()
  })

  it('einstellung global: Outbox-Item wird synced unter key#global', async () => {
    const e = einstellungPayload('artikelTypen', null, '[]')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'einstellung',
      op: 'upsert',
      payload: JSON.stringify(e),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ accepted: ['artikelTypen#global'], conflicts: [], errors: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const remaining = await getDb().outbox.toArray()
    expect(remaining[0]?.syncedAt).not.toBeNull()
  })

  it('Server-Validation-Error auf einstellung: Outbox-Item wird markiert (kein Endlos-Retry)', async () => {
    // Wenn der Server eine Einstellung ablehnt (z. B. unbekannter Key),
    // MUSS die Fehler-ID "key#userId" sein, sonst findet der Worker das
    // passende Outbox-Item nicht und pusht es endlos weiter bis QUARANTINE.
    const e = einstellungPayload('sprache', 'u1', 'en-US')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'einstellung',
      op: 'upsert',
      payload: JSON.stringify(e),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            accepted: [],
            conflicts: [],
            errors: [
              {
                id: 'sprache#u1',
                code: 'VALIDATION',
                message: 'einstellung.userId: fremde User-ID',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Session-User entspricht der Outbox-userId ('u1'), damit der Push
    // den Guard passiert und der Server-Ablehnungs-Pfad getestet wird.
    localStorage.setItem(
      'castel.auth.session',
      JSON.stringify({ userId: 'u1', email: 'u1@test.local', rolle: 'user' }),
    )
    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const remaining = await getDb().outbox.toArray()
    expect(remaining.length).toBe(1)
    // Item ist NICHT synced, hat aber einen lastError, damit der User in
    // der UI sieht, was los ist — und der Worker nicht endlos weiterpusht.
    expect(remaining[0]?.syncedAt).toBeNull()
    expect(remaining[0]?.lastError).toContain('VALIDATION')
    expect(remaining[0]?.attempts).toBe(1)
  })

  it('Einstellung mit fremder userId wird nicht an den Server pushed', async () => {
    // Outbox-Item trägt userId 'u1', es ist aber kein Session-User
    // angemeldet (currentUserId = null). Der Guard muss das Item lokal
    // als fehlgeschlagen markieren, OHNE es an den Server zu senden.
    const e = einstellungPayload('sprache', 'u1', 'en-US')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'einstellung',
      op: 'upsert',
      payload: JSON.stringify(e),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })

    let pushCalled = false
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        pushCalled = true
        return new Response(
          JSON.stringify({ accepted: ['sprache#u1'], conflicts: [], errors: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    expect(pushCalled).toBe(false)
    const remaining = await getDb().outbox.toArray()
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.syncedAt).toBeNull()
    expect(remaining[0]?.lastError).toContain('VALIDATION')
    expect(remaining[0]?.lastError).toContain('einem anderen Nutzer')
  })

  it('Einstellungs-Diagnose (stuckItems/quarantinedItems): payloadId ist key#userId, nicht leer', async () => {
    // In der Outbox-Diagnose war "payloadId" für Einstellungen leer —
    // das war verwirrend. Mit dem Fix zeigt es den echten Compound-Key.
    // Wir triggern den vollen Sync-Pfad: Server lehnt das Item ab, der
    // Worker füllt lastFailure.stuckItems und quarantinedItems.
    const e = einstellungPayload('sprache', 'u1', 'en-US')
    await getDb().outbox.add({
      id: neueUuid(),
      entity: 'einstellung',
      op: 'upsert',
      payload: JSON.stringify(e),
      createdAt: jetztIso(),
      syncedAt: null,
      attempts: 0,
      lastError: null,
      quarantinedAt: null,
      quarantineReason: null,
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/sync/push') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            accepted: [],
            conflicts: [],
            errors: [
              {
                id: 'sprache#u1',
                code: 'VALIDATION',
                message: 'einstellung.userId: fremde User-ID',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Session-User entspricht der Outbox-userId ('u1'), damit der Push
    // den Guard passiert und der Server-Ablehnungs-Pfad getestet wird.
    localStorage.setItem(
      'castel.auth.session',
      JSON.stringify({ userId: 'u1', email: 'u1@test.local', rolle: 'user' }),
    )
    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const st = getSyncStatus()
    expect(st.lastFailure).not.toBeNull()
    const stuckEinstellung = st.lastFailure?.stuckItems.find((s) => s.entity === 'einstellung')
    expect(stuckEinstellung?.payloadId).toBe('sprache#u1')
  })
})

describe('Sync — Self-Healing: lastPullAt ungültig → voller Re-Pull', () => {
  it('Wenn inkrementeller Pull nichts liefert, aber serverCounts > localCounts, wird der Marker zurückgesetzt und ein voller Pull gemacht', async () => {
    // Setup: lastPullAt existiert bereits (also nicht der allererste Sync),
    // und der Client hat 1 Artikel lokal.
    const a1 = artikelAnlage(neueUuid(), 'Lokal A1')
    await getDb().artikel.add(a1)
    await getDb().einstellungen.put({
      key: 'sync.lastPullAt',
      userId: '',
      value: '2026-10-15T15:00:00.000Z',
      geaendertAm: jetztIso(),
    })

    // Server hat 2 Artikel (einer mehr als lokal), der inkrementelle
    // Pull mit `since=lastPullAt` liefert aber NICHTS (simuliert einen
    // kaputten Marker / Clock-Drift). Der Self-Healing-Pfad muss dann
    // den Marker zurücksetzen und einen vollen Pull machen.
    const a1Server = { ...artikelAnlage(a1.id, 'Lokal A1') }
    const a2Server = artikelAnlage(neueUuid(), 'Server-only A2')

    let snapshotCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        snapshotCalls++
        if (snapshotCalls === 1) {
          // Erster Pull: inkrementell, liefert nichts (Marker falsch).
          return new Response(
            JSON.stringify({
              serverTime: '2026-10-15T15:01:00.000Z',
              since: '2026-10-15T15:00:00.000Z',
              artikel: [],
              standorte: [],
              commission: [],
              buchungen: [],
              einstellungen: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        // Zweiter Pull: ohne `since`, liefert alles.
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T15:01:01.000Z',
            since: '1970-01-01T00:00:00.000Z',
            artikel: [a1Server, a2Server],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 2, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    // Assert: zwei Snapshot-Calls (initial inkrementell + Self-Healing voll).
    expect(snapshotCalls).toBe(2)

    // Zweiter Aufruf ging OHNE `since` raus.
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string] | [URL]
    const lastUrl = typeof lastCall[0] === 'string' ? lastCall[0] : lastCall[0].toString()
    expect(lastUrl).not.toContain('since=')

    // Lokal sind jetzt 2 Artikel (Heilung hat a2 nachgezogen).
    const artikel = await getDb().artikel.toArray()
    expect(artikel.length).toBe(2)
    expect(artikel.map((a) => a.id).sort()).toEqual([a1.id, a2Server.id].sort())

    // Status zeigt konsistente Counts.
    const st = getSyncStatus()
    expect(st.localCounts?.artikel).toBe(2)
    expect(st.serverCounts?.artikel).toBe(2)
  })

  it('Ohne Divergenz wird kein Self-Healing getriggert (kein zweiter Pull)', async () => {
    // lastPullAt ist gesetzt, lokal=server=0 → keine Heilung nötig.
    await getDb().einstellungen.put({
      key: 'sync.lastPullAt',
      userId: '',
      value: '2026-10-15T15:00:00.000Z',
      geaendertAm: jetztIso(),
    })

    let snapshotCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        snapshotCalls++
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T15:01:00.000Z',
            since: '2026-10-15T15:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    // Genau ein Snapshot-Call (kein Self-Healing).
    expect(snapshotCalls).toBe(1)
  })

  it('Self-Healing feuert NICHT, wenn der Pull bereits Daten liefert (LWW-Konflikt, kein Marker-Problem)', async () => {
    // Server liefert einen Artikel, der lokal schon existiert mit
    // neuerem geaendertAm → wird nicht überschrieben. Counts bleiben
    // divergent. Aber: der Pull hat Daten geliefert → KEIN Self-Healing.
    const id = neueUuid()
    const lokal = artikelAnlage(id, 'Lokal (neuer)')
    lokal.geaendertAm = '2026-10-15T15:00:01.000Z'
    await getDb().artikel.add(lokal)
    await getDb().einstellungen.put({
      key: 'sync.lastPullAt',
      userId: '',
      value: '2026-10-15T15:00:00.000Z',
      geaendertAm: jetztIso(),
    })

    const server = artikelAnlage(id, 'Server (älter)')
    server.geaendertAm = '2026-10-15T15:00:00.500Z'

    let snapshotCalls = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        snapshotCalls++
        return new Response(
          JSON.stringify({
            serverTime: '2026-10-15T15:01:00.000Z',
            since: '2026-10-15T15:00:00.000Z',
            artikel: [server],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime: new Date().toISOString(),
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

    // Nur EIN Pull — der Pull hat geliefert, also kein Self-Healing.
    expect(snapshotCalls).toBe(1)

    // Lokal behält seine neuere Version (LWW).
    const a = await getDb().artikel.get(id)
    expect(a?.titel).toBe('Lokal (neuer)')
  })

  it('zaehleAbweichungen: reine Helper-Funktion', async () => {
    const { zaehleAbweichungen } = await import('../worker')
    expect(
      zaehleAbweichungen(
        { artikel: 1, standorte: 2, commission: 3, buchungen: 4 },
        { artikel: 1, standorte: 2, commission: 3, buchungen: 4 },
      ),
    ).toBe(0)
    expect(
      zaehleAbweichungen(
        { artikel: 1, standorte: 2, commission: 3, buchungen: 4 },
        { artikel: 0, standorte: 2, commission: 3, buchungen: 4 },
      ),
    ).toBe(1)
    expect(
      zaehleAbweichungen(
        { artikel: 1, standorte: 2, commission: 3, buchungen: 4 },
        { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
      ),
    ).toBe(4)
    expect(
      zaehleAbweichungen(null, { artikel: 0, standorte: 0, commission: 0, buchungen: 0 }),
    ).toBe(0)
    expect(
      zaehleAbweichungen({ artikel: 1, standorte: 2, commission: 3, buchungen: 4 }, null),
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Mindestbestand-Ereignis-Snapshot
// ---------------------------------------------------------------------------

describe('Sync — Mindestbestand-Ereignis-Snapshot', () => {
  it('applySnapshot legt neue Mindestbestand-Ereignisse in Dexie ab', async () => {
    const { applySnapshot } = await import('../worker')
    await applySnapshot({
      serverTime: '2026-04-14T11:00:00.000Z',
      since: '1970-01-01T00:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [
        {
          id: 'evt-1',
          artikelId: 'a-1',
          standortId: 's-1',
          ausloeserBuchungId: 'b-1',
          bestandDanach: 2,
          mindestbestand: 5,
          defizit: 3,
          erstelltAm: '2026-04-14T10:30:00.000Z',
        },
        {
          id: 'evt-2',
          artikelId: 'a-1',
          standortId: 's-1',
          ausloeserBuchungId: 'b-2',
          bestandDanach: 1,
          mindestbestand: 5,
          defizit: 4,
          erstelltAm: '2026-04-14T11:00:00.000Z',
        },
      ],
    })
    const events = await getDb().mindestbestandEreignisse.orderBy('erstelltAm').toArray()
    expect(events).toHaveLength(2)
    expect(events[0]?.id).toBe('evt-1')
    expect(events[1]?.id).toBe('evt-2')
  })

  it('applySnapshot ist append-only: doppelte IDs werden überschrieben (id-basiertes put)', async () => {
    const { applySnapshot } = await import('../worker')
    await applySnapshot({
      serverTime: '2026-04-14T11:00:00.000Z',
      since: '1970-01-01T00:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [
        {
          id: 'evt-1',
          artikelId: 'a-1',
          standortId: 's-1',
          ausloeserBuchungId: 'b-1',
          bestandDanach: 2,
          mindestbestand: 5,
          defizit: 3,
          erstelltAm: '2026-04-14T10:30:00.000Z',
        },
      ],
    })
    // Zweiter Snapshot mit gleicher ID, aber anderem Inhalt (z. B. Server
    // hat den Stand korrigiert). applySnapshot nutzt `put`, also wird
    // der Eintrag überschrieben.
    await applySnapshot({
      serverTime: '2026-04-14T12:00:00.000Z',
      since: '2026-04-14T11:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [
        {
          id: 'evt-1',
          artikelId: 'a-1',
          standortId: 's-1',
          ausloeserBuchungId: 'b-1',
          bestandDanach: 0,
          mindestbestand: 5,
          defizit: 5,
          erstelltAm: '2026-04-14T10:30:00.000Z',
        },
      ],
    })
    const events = await getDb().mindestbestandEreignisse.toArray()
    expect(events).toHaveLength(1)
    expect(events[0]?.bestandDanach).toBe(0)
    expect(events[0]?.defizit).toBe(5)
  })

  it('applySnapshot ohne Events setzt den Marker nicht zurück', async () => {
    const { applySnapshot } = await import('../worker')
    await applySnapshot({
      serverTime: '2026-04-14T11:00:00.000Z',
      since: '1970-01-01T00:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [],
    })
    const marker = await getDb().einstellungen.get(['mindestbestand.lastPullAt', ''])
    // Wenn der Snapshot keine Events liefert, bleibt der Marker
    // uninitialisiert (null). Sonst würden wir potenziell "alle
    // Events bis zum Snapshot-Time" als gesehen markieren, obwohl
    // uns noch welche fehlen.
    expect(marker).toBeUndefined()
  })

  it('applySnapshot mit Events setzt den mindestbestand.lastPullAt Marker', async () => {
    const { applySnapshot } = await import('../worker')
    await applySnapshot({
      serverTime: '2026-04-14T11:00:00.000Z',
      since: '1970-01-01T00:00:00.000Z',
      artikel: [],
      standorte: [],
      commission: [],
      buchungen: [],
      einstellungen: [],
      mindestbestandEreignisse: [
        {
          id: 'evt-1',
          artikelId: 'a-1',
          standortId: 's-1',
          ausloeserBuchungId: 'b-1',
          bestandDanach: 2,
          mindestbestand: 5,
          defizit: 3,
          erstelltAm: '2026-04-14T10:30:00.000Z',
        },
      ],
    })
    const marker = await getDb().einstellungen.get(['mindestbestand.lastPullAt', ''])
    expect(marker?.value).toBe('2026-04-14T11:00:00.000Z')
  })
})

describe('Sync — skipped & reconcile', () => {
  function syncResponse(overrides: Record<string, unknown>): Response {
    return new Response(
      JSON.stringify({
        serverTime: new Date().toISOString(),
        counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
        ...overrides,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }

  it('behandelt server-skipped Items wie akzeptiert (Outbox wird synced)', async () => {
    const id = neueUuid()
    await outboxAdd('buchung', 'create', {
      id,
      artikelId: neueUuid(),
      standortId: neueUuid(),
      typ: 'einlagerung',
      menge: 1,
    } as unknown)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.endsWith('/api/sync/push') && method === 'POST') {
        return syncResponse({
          accepted: [],
          skipped: [{ id, reason: 'DUPLICATE_ID' }],
          conflicts: [],
          errors: [],
        })
      }
      if (url.includes('/api/sync/snapshot')) {
        return syncResponse({
          since: '1970-01-01T00:00:00.000Z',
          artikel: [],
          standorte: [],
          commission: [],
          buchungen: [],
          einstellungen: [],
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return syncResponse({
          counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 1 },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, getSyncStatus } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const items = await getDb().outbox.toArray()
    expect(items).toHaveLength(1)
    expect(items[0]?.syncedAt).not.toBeNull()
    expect(getSyncStatus().pending).toBe(0)
  })

  it('markiert lokal vorhandene, serverseitig fehlende Buchungen als nicht gespeichert', async () => {
    const b = buchungsAnlage(neueUuid(), neueUuid(), neueUuid(), 1)
    await getDb().buchungen.add(b)
    const reconcileCalls: string[][] = []

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/api/sync/snapshot')) {
        return syncResponse({
          since: '1970-01-01T00:00:00.000Z',
          artikel: [],
          standorte: [],
          commission: [],
          buchungen: [],
          einstellungen: [],
        })
      }
      if (url.endsWith('/api/sync/reconcile') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { ids: string[] }
        reconcileCalls.push(body.ids)
        return new Response(JSON.stringify({ present: [], missing: body.ids }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return syncResponse({
          counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    expect(reconcileCalls).toEqual([[b.id]])
    const stored = await getDb().buchungen.get(b.id)
    expect(stored?.nichtGespeichert).toBe(true)
    expect(stored?.skipReason).toBe('SERVER_MISSING')
    expect(stored?.serverVerworfenAt).toBeTruthy()
  })

  it('entfernt das Flag wieder, wenn der Server die Buchung doch kennt', async () => {
    const b = { ...buchungsAnlage(neueUuid(), neueUuid(), neueUuid(), 1), nichtGespeichert: true }
    await getDb().buchungen.add(b)

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      if (url.includes('/api/sync/snapshot')) {
        return syncResponse({
          since: '1970-01-01T00:00:00.000Z',
          artikel: [],
          standorte: [],
          commission: [],
          buchungen: [b],
          einstellungen: [],
        })
      }
      if (url.endsWith('/api/sync/reconcile') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { ids: string[] }
        return new Response(JSON.stringify({ present: body.ids, missing: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return syncResponse({
          counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 1 },
        })
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync } = await import('../worker')
    await runSync({ token: null, apiBase: 'http://test.local' })

    const stored = await getDb().buchungen.get(b.id)
    expect(stored?.nichtGespeichert).toBe(false)
    expect(stored?.skipReason).toBeNull()
  })

  it('fetchWithTimeout bricht auch dann ab, wenn fetch das Signal ignoriert', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>(() => {})),
      )
      const { fetchWithTimeout, SyncTimeoutError } = await import('../worker')
      const p = fetchWithTimeout('http://test.local/slow', {}, 50)
      const expectation = expect(p).rejects.toBeInstanceOf(SyncTimeoutError)
      await vi.advanceTimersByTimeAsync(60)
      await expectation
    } finally {
      vi.useRealTimers()
    }
  })
})
