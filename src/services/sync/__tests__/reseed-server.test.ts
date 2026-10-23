// Tests für den "Server aus lokalen Daten aufbauen"-Flow (Reseed nach Server-Wipe).
//
// Der Fake-Server bildet die Resolver-Semantik aus server/src/sync/resolver.ts nach:
//   * Stammdaten-create: Insert, Duplikate idempotent akzeptiert
//   * Buchung-create: Dedup per UUID, sonst UNKNOWN_REFERENCE bei fehlender Referenz
//   * status/snapshot spiegeln den Store
//
// Der letzte Test reproduziert exakt das Nutzerverhalten nach `POST /api/admin/db/clear`:
// eine lokal erzeugte Buchung wird wegen unbekannter Artikel-ID quarantiniert — der
// Reseed muss sie heilen.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, getDb, setDb } from '../../../db/database'
import type { Artikel, Buchung, Projekt, Standort } from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'
import { sessionSchreiben } from '../../../auth/session'
import {
  collectReseedPlan,
  reseedServer,
  reseedSettingPayload,
  ReseedGuardError,
  sortBuchungenForReseed,
} from '../reseed-server'
import { _resetSyncForTests, queueOp } from '../worker'

// ---------- Fixtures ----------

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

function projektAnlage(id: string, nummer: string): Projekt {
  const now = jetztIso()
  return { id, nummer, name: null, archiviert: false, geaendertAm: now, erstelltAm: now }
}

function buchungsAnlage(opts: {
  id: string
  artikelId: string
  standortId: string
  typ?: Buchung['typ']
  menge?: number
  paarId?: string | null
  erstelltAm?: string
  standortZielId?: string | null
}): Buchung {
  const am = opts.erstelltAm ?? jetztIso()
  return {
    id: opts.id,
    artikelId: opts.artikelId,
    standortId: opts.standortId,
    standortZielId: opts.standortZielId ?? null,
    typ: opts.typ ?? 'einlagerung',
    menge: opts.menge ?? 1,
    paarId: opts.paarId ?? null,
    projekt: null,
    erstelltAm: am,
    clientEingabeAm: am,
    erstelltVon: 'user-1',
    kommentar: null,
    mitteilungAn: null,
    stornoVon: null,
    storno: false,
    storniertDurch: null,
    serverId: null,
  }
}

// ---------- Fake-Server ----------

interface PushedOp {
  batch: number
  entity: string
  op: string
  payloadId: string
}

interface FakeServer {
  standorte: Map<string, Standort>
  artikel: Map<string, Artikel>
  commission: Map<string, Projekt>
  buchungen: Map<string, Buchung>
  einstellungen: Map<string, string>
  pushLog: PushedOp[]
}

function fakeServer(): FakeServer {
  return {
    standorte: new Map(),
    artikel: new Map(),
    commission: new Map(),
    buchungen: new Map(),
    einstellungen: new Map(),
    pushLog: [],
  }
}

function installFakeServer(server: FakeServer): void {
  let batch = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'

    if (url.includes('/api/sync/push') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        ops: Array<{ op: string; entity: string; payload: Record<string, unknown> }>
      }
      const accepted: string[] = []
      const errors: Array<{ id: string; code: string; message: string }> = []
      batch += 1
      for (const entry of body.ops) {
        const p = entry.payload
        const isSetting = entry.entity === 'einstellung'
        const pid = isSetting ? `${String(p['key'])}#${p['userId'] ?? 'global'}` : String(p['id'])
        server.pushLog.push({ batch, entity: entry.entity, op: entry.op, payloadId: pid })
        if (entry.entity === 'standort') {
          if (!server.standorte.has(pid)) server.standorte.set(pid, p as unknown as Standort)
          accepted.push(pid)
        } else if (entry.entity === 'artikel') {
          if (!server.artikel.has(pid)) server.artikel.set(pid, p as unknown as Artikel)
          accepted.push(pid)
        } else if (entry.entity === 'kommission') {
          if (!server.commission.has(pid)) server.commission.set(pid, p as unknown as Projekt)
          accepted.push(pid)
        } else if (entry.entity === 'buchung') {
          if (server.buchungen.has(pid)) {
            accepted.push(pid)
          } else if (
            server.artikel.has(String(p['artikelId'])) &&
            server.standorte.has(String(p['standortId']))
          ) {
            server.buchungen.set(pid, p as unknown as Buchung)
            accepted.push(pid)
          } else {
            errors.push({
              id: pid,
              code: 'UNKNOWN_REFERENCE',
              message: `Unbekannte Artikel-ID: ${String(p['artikelId'])}`,
            })
          }
        } else if (entry.entity === 'einstellung') {
          server.einstellungen.set(pid, String(p['value']))
          accepted.push(pid)
        }
      }
      return new Response(JSON.stringify({ accepted, conflicts: [], errors }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.includes('/api/sync/status')) {
      return new Response(
        JSON.stringify({
          serverTime: jetztIso(),
          counts: {
            artikel: server.artikel.size,
            standorte: server.standorte.size,
            commission: server.commission.size,
            buchungen: server.buchungen.size,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    if (url.includes('/api/sync/snapshot')) {
      return new Response(
        JSON.stringify({
          serverTime: jetztIso(),
          since: '',
          artikel: [...server.artikel.values()],
          standorte: [...server.standorte.values()],
          commission: [...server.commission.values()],
          buchungen: [...server.buchungen.values()],
          einstellungen: [...server.einstellungen.entries()].map(([k, value]) => {
            const idx = k.indexOf('#')
            const key = k.slice(0, idx)
            const uid = k.slice(idx + 1)
            return { key, userId: uid === 'global' ? null : uid, value, geaendertAm: jetztIso() }
          }),
          mindestbestandEreignisse: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
}

// ---------- Lifecycle ----------

beforeEach(() => {
  setDb(new CastelDb(`castel-reseed-test-${Math.random().toString(36).slice(2)}`))
  _resetSyncForTests()
  localStorage.removeItem('castel.auth.session')
})

afterEach(() => {
  _resetSyncForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------- Reine Logik ----------

describe('sortBuchungenForReseed', () => {
  it('sortiert nach erstelltAm und hält Umlagerungs-Hälften benachbart', () => {
    const paarId = neueUuid()
    const bLate = buchungsAnlage({
      id: 'b-late',
      artikelId: 'a',
      standortId: 's',
      erstelltAm: '2026-01-03T00:00:00.000Z',
    })
    const bOut = buchungsAnlage({
      id: 'b-out',
      artikelId: 'a',
      standortId: 's',
      typ: 'umlagerung',
      paarId,
      erstelltAm: '2026-01-02T00:00:00.000Z',
    })
    const bIn = buchungsAnlage({
      id: 'b-in',
      artikelId: 'a',
      standortId: 's2',
      typ: 'umlagerung',
      paarId,
      menge: -1,
      erstelltAm: '2026-01-02T00:00:00.500Z',
    })
    const bEarly = buchungsAnlage({
      id: 'b-early',
      artikelId: 'a',
      standortId: 's',
      erstelltAm: '2026-01-01T00:00:00.000Z',
    })
    const out = sortBuchungenForReseed([bLate, bOut, bIn, bEarly])
    expect(out.map((b) => b.id)).toEqual(['b-early', 'b-out', 'b-in', 'b-late'])
  })
})

describe('reseedSettingPayload', () => {
  it('filtert interne Keys, Scope-Fehler und fremde User aus', () => {
    const now = jetztIso()
    const mk = (key: string, userId: string | null, value: string) => ({
      key,
      userId,
      value,
      geaendertAm: now,
    })
    expect(reseedSettingPayload(mk('sync.lastPullAt', '', now), 'u1')).toBeNull()
    expect(reseedSettingPayload(mk('backup.schedule', '', '03:00'), 'u1')).toBeNull()
    expect(reseedSettingPayload(mk('artikelTypen', 'u1', '[]'), 'u1')).toBeNull()
    expect(reseedSettingPayload(mk('sprache', '', 'de'), 'u1')).toBeNull()
    expect(reseedSettingPayload(mk('sprache', 'u2', 'de'), 'u1')).toBeNull()
    expect(reseedSettingPayload(mk('artikelTypen', '', '["A"]'), 'u1')).toEqual({
      key: 'artikelTypen',
      userId: null,
      value: '["A"]',
      geaendertAm: now,
    })
    expect(reseedSettingPayload(mk('sprache', 'u1', 'de'), 'u1')).toEqual({
      key: 'sprache',
      userId: 'u1',
      value: 'de',
      geaendertAm: now,
    })
  })
})

// ---------- Guard ----------

describe('reseedServer Guard', () => {
  it('lehnt Reseed ab, wenn der Server noch Daten enthält', async () => {
    const server = fakeServer()
    server.artikel.set('a-1', artikelAnlage('a-1', 'server-artikel'))
    installFakeServer(server)
    await getDb().artikel.add(artikelAnlage(neueUuid(), 'lokal'))

    await expect(
      reseedServer({ token: null, apiBase: 'http://test.local' }),
    ).rejects.toBeInstanceOf(ReseedGuardError)
    expect(server.artikel.size).toBe(1)
    expect((await getDb().outbox.toArray()).length).toBe(0)
  })

  it('läuft mit force trotz Server-Daten', async () => {
    const server = fakeServer()
    server.artikel.set('a-1', artikelAnlage('a-1', 'server-artikel'))
    installFakeServer(server)
    const lokalerId = neueUuid()
    await getDb().artikel.add(artikelAnlage(lokalerId, 'lokal'))

    const result = await reseedServer({ token: null, apiBase: 'http://test.local', force: true })
    expect(result.queued.artikel).toBe(1)
    expect(server.artikel.has(lokalerId)).toBe(true)
    expect(result.pendingLeft).toBe(0)
  })

  it('lehnt Reseed mit leerer lokaler DB ab', async () => {
    installFakeServer(fakeServer())
    await expect(reseedServer({ token: null, apiBase: 'http://test.local' })).rejects.toThrow(
      /leer/,
    )
  })
})

// ---------- Plan ----------

describe('collectReseedPlan', () => {
  it('zählt nur resehbare Zeilen (Whitelist + Scope)', async () => {
    sessionSchreiben({
      userId: 'u1',
      email: 'a@b.c',
      rolle: 'admin',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const db = getDb()
    await db.standorte.add(standortAnlage(neueUuid(), 'HL'))
    await db.artikel.add(artikelAnlage(neueUuid(), 'A1'))
    await db.commission.add(projektAnlage(neueUuid(), 'P1'))
    await db.buchungen.add(buchungsAnlage({ id: neueUuid(), artikelId: 'a', standortId: 's' }))
    const now = jetztIso()
    await db.einstellungen.bulkAdd([
      { key: 'artikelTypen', userId: '', value: '["A"]', geaendertAm: now },
      { key: 'sprache', userId: 'u1', value: 'de', geaendertAm: now },
      { key: 'sprache', userId: 'u2', value: 'en', geaendertAm: now },
      { key: 'sync.lastPullAt', userId: '', value: now, geaendertAm: now },
      { key: 'backup.schedule', userId: '', value: '03:00', geaendertAm: now },
    ])

    const plan = await collectReseedPlan()
    expect(plan).toEqual({
      standorte: 1,
      artikel: 1,
      kommission: 1,
      buchungen: 1,
      einstellungen: 2,
    })
  })
})

// ---------- End-to-End ----------

describe('reseedServer End-to-End', () => {
  it('queedt in Abhängigkeitsreihenfolge und hält Umlagerungs-Paare in einem Batch', async () => {
    sessionSchreiben({
      userId: 'u1',
      email: 'a@b.c',
      rolle: 'admin',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
    const server = fakeServer()
    installFakeServer(server)

    const db = getDb()
    const standortId = neueUuid()
    const zielId = neueUuid()
    const artikelId = neueUuid()
    const projektId = neueUuid()
    const paarId = neueUuid()
    await db.standorte.bulkAdd([
      standortAnlage(standortId, 'HL'),
      standortAnlage(zielId, 'Baustelle'),
    ])
    await db.artikel.add(artikelAnlage(artikelId, 'Bohrer'))
    await db.commission.add(projektAnlage(projektId, 'P-1'))
    const bOut = buchungsAnlage({
      id: neueUuid(),
      artikelId,
      standortId,
      standortZielId: zielId,
      typ: 'umlagerung',
      paarId,
      menge: 2,
      erstelltAm: '2026-01-02T00:00:00.000Z',
    })
    const bIn = buchungsAnlage({
      id: neueUuid(),
      artikelId,
      standortId: zielId,
      standortZielId: standortId,
      typ: 'umlagerung',
      paarId,
      menge: -2,
      erstelltAm: '2026-01-02T00:00:00.000Z',
    })
    const bEarly = buchungsAnlage({
      id: neueUuid(),
      artikelId,
      standortId,
      erstelltAm: '2026-01-01T00:00:00.000Z',
    })
    await db.buchungen.bulkAdd([bIn, bOut, bEarly])
    await db.einstellungen.bulkAdd([
      { key: 'artikelTypen', userId: '', value: '["A"]', geaendertAm: jetztIso() },
      { key: 'sync.lastPullAt', userId: '', value: jetztIso(), geaendertAm: jetztIso() },
      { key: 'backup.schedule', userId: '', value: '03:00', geaendertAm: jetztIso() },
    ])

    const result = await reseedServer({ token: null, apiBase: 'http://test.local' })

    expect(result.queued).toEqual({
      standorte: 2,
      artikel: 1,
      kommission: 1,
      buchungen: 3,
      einstellungen: 1,
    })
    expect(result.pendingLeft).toBe(0)
    expect(result.quarantinedLeft).toBe(0)

    // Server-Inhalt
    expect(server.standorte.size).toBe(2)
    expect(server.artikel.size).toBe(1)
    expect(server.commission.size).toBe(1)
    expect(server.buchungen.size).toBe(3)
    expect(server.einstellungen.has('artikelTypen#global')).toBe(true)
    // Interne Keys wurden nie gepusht.
    expect(server.einstellungen.has('sync.lastPullAt#global')).toBe(false)
    expect(server.einstellungen.has('backup.schedule#global')).toBe(false)

    // Reihenfolge: alle Stammdaten vor allen Buchungen; Paar benachbart im selben Batch.
    const log = server.pushLog
    const lastStammdaten = Math.max(
      ...log
        .filter((o) => o.entity !== 'buchung' && o.entity !== 'einstellung')
        .map((o) => log.indexOf(o)),
    )
    const firstBuchung = log.findIndex((o) => o.entity === 'buchung')
    expect(firstBuchung).toBeGreaterThan(lastStammdaten)
    const pairIdx = log.filter((o) => o.payloadId === bOut.id || o.payloadId === bIn.id)
    const pa = pairIdx[0]
    const pb = pairIdx[1]
    if (!pa || !pb) throw new Error('Umlagerungs-Paar nicht vollständig gepusht')
    expect(pa.batch).toBe(pb.batch)
    expect(Math.abs(log.indexOf(pa) - log.indexOf(pb))).toBe(1)

    // Outbox komplett abgearbeitet.
    const outbox = await db.outbox.toArray()
    expect(outbox.filter((o) => o.syncedAt == null).length).toBe(0)
  })

  it('heilt eine nach Server-Wipe quarantinierte Buchung (UNKNOWN_REFERENCE)', async () => {
    const server = fakeServer()
    installFakeServer(server)
    const db = getDb()

    // Lokale Stammdaten + Buchung — der Server weiß nichts davon.
    const standortId = neueUuid()
    const artikelId = neueUuid()
    const buchungId = neueUuid()
    await db.standorte.add(standortAnlage(standortId, 'HL'))
    await db.artikel.add(artikelAnlage(artikelId, 'Bohrer'))
    const buchung = buchungsAnlage({ id: buchungId, artikelId, standortId })
    await db.buchungen.add(buchung)

    // Quarantänie-Eintrag, wie der Worker ihn nach HARD_QUARANTINE hinterlässt.
    await queueOp('buchung', 'create', buchung)
    const pending = (await db.outbox.toArray()).find((o) => o.syncedAt == null)
    expect(pending).toBeDefined()
    await db.outbox.update(pending!.id, {
      attempts: 1,
      lastError: 'UNKNOWN_REFERENCE',
      quarantinedAt: jetztIso(),
      quarantineReason: 'Server lehnt dauerhaft ab (UNKNOWN_REFERENCE)',
    })

    const result = await reseedServer({ token: null, apiBase: 'http://test.local' })

    expect(result.quarantinedLeft).toBe(0)
    expect(result.pendingLeft).toBe(0)
    expect(server.buchungen.has(buchungId)).toBe(true)
    const healed = (await db.outbox.toArray()).find((o) => o.id === pending!.id)
    expect(healed?.quarantinedAt).toBeNull()
    expect(healed?.syncedAt).not.toBeNull()
  })
})
