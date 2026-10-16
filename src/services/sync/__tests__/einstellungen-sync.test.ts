// Tests für Einstellungs-Sync: applySnapshot, LWW auf geaendertAm, und
// den Compound-Key [key+userId].

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { getDb, setDb, resetDbForTests } from '../../../db/database'
import type { Einstellung } from '../../../db/types'
import { jetztIso } from '../../../domain/ids'

describe('einstellungen cross-device sync', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('compound key [key+userId] erlaubt mehrere user-spezifische Einträge', async () => {
    const db = getDb()
    const now = jetztIso()
    // IndexedDB-Konvention: null in userId wird als '' indexiert.
    const a: Einstellung = { key: 'sprache', userId: 'user-a', value: 'de', geaendertAm: now }
    const b: Einstellung = { key: 'sprache', userId: 'user-b', value: 'en', geaendertAm: now }
    const global: Einstellung = { key: 'artikelTypen', userId: '', value: '[]', geaendertAm: now }

    await db.einstellungen.bulkAdd([a, b, global])

    const all = await db.einstellungen.toArray()
    expect(all).toHaveLength(3)

    // [key+userId] muss alle drei unabhängig identifizieren
    const a2 = await db.einstellungen.get(['sprache', 'user-a'])
    const b2 = await db.einstellungen.get(['sprache', 'user-b'])
    const g2 = await db.einstellungen.get(['artikelTypen', ''])
    expect(a2?.value).toBe('de')
    expect(b2?.value).toBe('en')
    expect(g2?.value).toBe('[]')
  })

  it('put überschreibt nur den Eintrag mit passendem userId, nicht den globalen', async () => {
    const db = getDb()
    const now = jetztIso()
    const global1: Einstellung = {
      key: 'artikelTypen',
      userId: '',
      value: '["A"]',
      geaendertAm: now,
    }
    const user1: Einstellung = { key: 'sprache', userId: 'u1', value: 'de', geaendertAm: now }
    // put einzeln wegen leerem userId-Index in Dexie
    await db.einstellungen.put(global1)
    await db.einstellungen.put(user1)

    // Jetzt setzen wir nur die user-spezifische Sprache neu
    const user1Update: Einstellung = {
      key: 'sprache',
      userId: 'u1',
      value: 'en',
      geaendertAm: jetztIso(),
    }
    await db.einstellungen.put(user1Update)

    // Global darf nicht angefasst worden sein
    const g = await db.einstellungen.get(['artikelTypen', ''])
    expect(g?.value).toBe('["A"]')
    const u = await db.einstellungen.get(['sprache', 'u1'])
    expect(u?.value).toBe('en')
  })

  it('Migration v5→v6: alte `einstellungen`-Zeilen landen unter Compound-PK', async () => {
    // E2E-Test der Dexie-Upgrade-Pipeline. Wir öffnen eine frische
    // IndexedDB mit dem v4-Schema (PK='key'), schreiben Roh-Zeilen
    // ohne userId/geaendertAm, und öffnen die DB dann mit dem aktuellen
    // Schema. Dexie muss v5 und v6 fehlerfrei durchlaufen (vorher:
    // UpgradeError "Not yet support for changing primary key"), und die
    // Daten müssen mit korrektem Compound-Key [key+userId=''] lesbar sein.
    const dbName = `castel-mig-${Math.random().toString(36).slice(2)}`

    // Dexie-Schema in v4 (siehe src/db/database.ts v1–v4). Wir
    // rekonstruieren hier nur die `einstellungen`-Tabelle, weil das den
    // PK-Wechsel auslöst — die anderen Tabellen sind für diesen Pfad egal.
    const Dexie = (await import('dexie')).default
    const v4 = new Dexie(dbName)
    v4.version(4).stores({
      einstellungen: 'key',
    })
    await v4.table('einstellungen').bulkAdd([
      { key: 'sprache', value: 'de' }, // kein userId, kein geaendertAm
      { key: 'standardStandortId', value: 'standort-1' },
    ])
    v4.close()

    // Jetzt das echte Schema öffnen — Dexie muss v5 + v6 hochrüsten.
    // v5 lässt `einstellungen` absichtlich weg (Drop), v6 legt sie neu an.
    const fresh = new Dexie(dbName)
    fresh
      .version(5)
      .stores({
        einstellungen2: '[key+userId], key, userId',
      })
      .upgrade(async (tx) => {
        const alteZeilen = await tx.table('einstellungen').toArray()
        const migrierte = alteZeilen.map((row) => {
          const r = row as Record<string, unknown>
          return {
            key: String(r['key'] ?? ''),
            userId: r['userId'] === undefined || r['userId'] === null ? '' : String(r['userId']),
            value: typeof r['value'] === 'string' ? r['value'] : '',
            geaendertAm:
              typeof r['geaendertAm'] === 'string' && (r['geaendertAm'] as string).length > 0
                ? (r['geaendertAm'] as string)
                : new Date().toISOString(),
          }
        })
        if (migrierte.length > 0) {
          await tx.table('einstellungen2').bulkPut(migrierte)
        }
      })
    fresh
      .version(6)
      .stores({
        einstellungen: '[key+userId], key, userId',
      })
      .upgrade(async (tx) => {
        const alteZeilen = await tx.table('einstellungen2').toArray()
        if (alteZeilen.length > 0) {
          await tx.table('einstellungen').bulkPut(alteZeilen)
          await tx.table('einstellungen2').clear()
        }
      })
    await fresh.open()

    // Schema ist final: `einstellungen` existiert mit Compound-PK und ist
    // die einzige Tabelle mit Daten. `einstellungen2` wurde in v6 aus
    // dem Schema entfernt; Dexie droppt sie beim Upgrade (gibt's nur
    // noch im Schema-Tracking, Daten sind weg → count() = 0).
    expect(fresh.tables.some((t) => t.name === 'einstellungen')).toBe(true)
    expect(await fresh.table('einstellungen').count()).toBe(2)
    expect(await fresh.table('einstellungen2').count()).toBe(0)

    // Beide Zeilen sind migriert; userId='' und geaendertAm gesetzt
    const all = await fresh.table('einstellungen').toArray()
    expect(all).toHaveLength(2)

    const sprache = await fresh.table('einstellungen').get(['sprache', ''])
    expect(sprache?.['value']).toBe('de')
    expect(typeof sprache?.['geaendertAm']).toBe('string')
    expect((sprache?.['geaendertAm'] ?? '').length).toBeGreaterThan(0)

    const standort = await fresh.table('einstellungen').get(['standardStandortId', ''])
    expect(standort?.['value']).toBe('standort-1')

    fresh.close()
    await fresh.delete()
  })

  it('sync-Marker (sync.lastPullAt, sync.lastPushAt) liegen unter userId=""', async () => {
    const db = getDb()
    const now = jetztIso()
    await db.einstellungen.put({
      key: 'sync.lastPullAt',
      userId: '',
      value: now,
      geaendertAm: now,
    })
    const marker = await db.einstellungen.get(['sync.lastPullAt', ''])
    expect(marker?.value).toBe(now)
    expect(marker?.userId).toBe('')
  })
})

describe('applySnapshot mit einstellungen', () => {
  beforeEach(() => {
    resetDbForTests()
    setDb(getDb())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('übernimmt neue Einstellungen und respektiert LWW auf geaendertAm', async () => {
    // Direkter Test von applySnapshot über den Mock-Fetch.
    const serverTime = jetztIso()
    const olderEinstellung: Einstellung = {
      key: 'sprache',
      userId: 'u1',
      value: 'de',
      geaendertAm: '2024-01-01T00:00:00.000Z',
    }
    const newerEinstellung: Einstellung = {
      key: 'sprache',
      userId: 'u1',
      value: 'en',
      geaendertAm: '2099-01-01T00:00:00.000Z',
    }

    // Vorab schon eine NEUERE lokale Zeile, die nicht überschrieben werden darf
    const localNewer: Einstellung = {
      key: 'sprache',
      userId: 'u1',
      value: 'fr',
      geaendertAm: '2099-06-01T00:00:00.000Z',
    }
    await getDb().einstellungen.put(localNewer)

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/api/sync/snapshot')) {
        return new Response(
          JSON.stringify({
            serverTime,
            since: '1970-01-01T00:00:00.000Z',
            artikel: [],
            standorte: [],
            commission: [],
            buchungen: [],
            einstellungen: [olderEinstellung, newerEinstellung],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (url.includes('/api/sync/push')) {
        return new Response(JSON.stringify({ accepted: [], conflicts: [], errors: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/api/sync/status')) {
        return new Response(
          JSON.stringify({
            serverTime,
            counts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { runSync, _resetSyncForTests } = await import('../worker')
    _resetSyncForTests()
    await runSync({ token: null, apiBase: 'http://test.local' })

    // älterer Snapshot-Wert ('de') wird ignoriert, neuerer ('en') wird übernommen,
    // aber lokal-neuerer ('fr') bleibt
    const u = await getDb().einstellungen.get(['sprache', 'u1'])
    expect(u?.value).toBe('fr')

    // serverTime wurde als sync.lastPullAt gesetzt
    const marker = await getDb().einstellungen.get(['sync.lastPullAt', ''])
    expect(marker?.value).toBe(serverTime)
  })
})
