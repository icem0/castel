// Tests für den Sync-Resolver. Wir mocken die PostgresJsDatabase mit einem
// minimalen In-Memory-Layer (nur die Operationen, die wir brauchen).
//
// Echte DB-Integration läuft gegen die echte Test-Postgres-Instanz (siehe README).

import { describe, it, expect } from 'vitest'
import { ConflictError } from '../sync/resolver.js'

// Wir testen den ConflictError separat (einzige exportierte Klasse).
// Den Resolver selbst testen wir mit einem Mock — siehe unten.

describe('Resolver — ConflictError', () => {
  it('trägt Message', () => {
    const e = new ConflictError('Server neuer')
    expect(e.message).toBe('Server neuer')
    expect(e.name).toBe('ConflictError')
    expect(e).toBeInstanceOf(Error)
  })
})

// Mini-Mock-DB für die Resolver-Pfade, die nur Gleichheit/Zeitstempel prüfen.
import { applyLastWriterWinsMock } from '../sync/__test-helpers__.js'

describe('applyLastWriterWinsMock (Server-Version)', () => {
  it('Server ist neuer → wirft ConflictError', () => {
    expect(() =>
      applyLastWriterWinsMock({
        serverGeaendertAm: new Date('2025-04-14T12:00:00.000Z'),
        incomingGeaendertAm: new Date('2025-04-14T11:00:00.000Z'),
        id: 'a1',
      }),
    ).toThrow(/neuer/)
  })

  it('Eingehend ist neuer → kein Konflikt', () => {
    expect(() =>
      applyLastWriterWinsMock({
        serverGeaendertAm: new Date('2025-04-14T11:00:00.000Z'),
        incomingGeaendertAm: new Date('2025-04-14T12:00:00.000Z'),
        id: 'a1',
      }),
    ).not.toThrow()
  })

  it('Gleiche Zeit → kein Konflikt (strictly newer erforderlich)', () => {
    const t = new Date('2025-04-14T11:00:00.000Z')
    expect(() =>
      applyLastWriterWinsMock({
        serverGeaendertAm: t,
        incomingGeaendertAm: new Date(t.getTime()),
        id: 'a1',
      }),
    ).not.toThrow()
  })
})

// Regression: Drizzle's postgres-js-Driver liefert `timestamp with timezone`
// als ISO-String, nicht als Date. Der Resolver muss das normalisieren, bevor
// `applyLastWriterWinsMock` darauf `.toISOString()` ruft.
describe('Resolver — Drizzle-string-gaendertAm Normalisierung', () => {
  // Simuliert das, was Drizzle zurückgibt: ein ISO-String statt Date.
  // Wird vor applyLastWriterWinsMock in Date gewrappt.
  function toDate(v: string | Date): Date {
    return v instanceof Date ? v : new Date(v)
  }

  it('wirft NICHT, wenn serverGeaendertAm als String ankommt (postgres-js-Driver)', () => {
    const serverGeaendertAmString = '2026-10-14T11:00:00.000Z'
    const incomingGeaendertAm = new Date('2026-10-14T12:00:00.000Z')

    expect(() =>
      applyLastWriterWinsMock({
        serverGeaendertAm: toDate(serverGeaendertAmString),
        incomingGeaendertAm,
        id: 'a1',
      }),
    ).not.toThrow()
  })

  it('erkennt Konflikt korrekt, wenn String-Timestamp vom Server neuer ist', () => {
    const serverGeaendertAmString = '2026-10-14T13:00:00.000Z' // Server ist NEUER
    const incomingGeaendertAm = new Date('2026-10-14T12:00:00.000Z')

    expect(() =>
      applyLastWriterWinsMock({
        serverGeaendertAm: toDate(serverGeaendertAmString),
        incomingGeaendertAm,
        id: 'a1',
      }),
    ).toThrow(/neuer/)
  })
})

// Regression: PWA schickt `geaendertAm`/`erstelltAm` als ISO-String (per
// `artikelSchema` validiert, nicht transformiert). Drizzle's
// `PgTimestamp.mapToDriverValue` ruft `value.toISOString()` auf den Werten, die
// an `insert()`/`update()` übergeben werden — Strings haben die Methode nicht
// und der Push bricht mit `TypeError: value.toISOString is not a function` ab.
// Der Resolver muss die Timestamps vor dem Statement in `Date` wandeln.
describe('Resolver — Stammdaten-Insert normalisiert ISO-Strings auf Date', () => {
  // Mock-DB, die alle an insert()/update()/set() übergebenen Werte einfängt.
  // Wir brauchen die Resolver-Pfade article/standort/projekt create, die alle
  // `tx.insert(...).values(...)` aufrufen.
  function makeMockDb(captured: { inserts: Array<Record<string, unknown>>; updates: Array<Record<string, unknown>> }) {
    const chainableInsert = {
      values: (v: Record<string, unknown>) => {
        captured.inserts.push(v)
        return Promise.resolve()
      },
    }
    const chainableUpdate = {
      set: (v: Record<string, unknown>) => {
        captured.updates.push(v)
        return {
          where: () => Promise.resolve(),
        }
      },
    }
    const txMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]), // kein existierender Datensatz → create-insert
          }),
        }),
      }),
      insert: () => chainableInsert,
      update: () => chainableUpdate,
    }
    return {
      transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
    } as never
  }

  it('artikel create: geaendertAm/erstelltAm werden als Date an insert übergeben', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const captured = { inserts: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>> }
    const dbMock = makeMockDb(captured)

    await resolvePush(
      dbMock,
      [
        {
          op: 'create',
          entity: 'artikel',
          payload: {
            id: 'a-1',
            titel: 'Testartikel',
            status: 'verfuegbar',
            typ: 'Demo',
            verpackungseinheit: 1,
            geaendertAm: '2026-10-15T10:00:00.000Z',
            erstelltAm: '2026-10-15T09:00:00.000Z',
          },
        },
      ],
      'u1',
      'user',
    )

    expect(captured.inserts).toHaveLength(2) // 1× artikel + 1× auditLog
    // Die auditLog-Zeile hat `zeit` als Date, aber kein `geaendertAm` — also
    // muessen wir nach der Artikel-Zeile filtern.
    const artikelInsert = captured.inserts.find((r) => 'geaendertAm' in r)
    expect(artikelInsert).toBeDefined()
    const row = artikelInsert!
    expect(row['geaendertAm']).toBeInstanceOf(Date)
    expect(row['erstelltAm']).toBeInstanceOf(Date)
    expect((row['geaendertAm'] as Date).toISOString()).toBe('2026-10-15T10:00:00.000Z')
    expect((row['erstelltAm'] as Date).toISOString()).toBe('2026-10-15T09:00:00.000Z')
  })

  it('standort/projekt create: geaendertAm/erstelltAm werden als Date an insert übergeben', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const captured = { inserts: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>> }
    const dbMock = makeMockDb(captured)

    await resolvePush(
      dbMock,
      [
        {
          op: 'create',
          entity: 'standort',
          payload: {
            id: 's-1',
            name: 'Lager Nord',
            typ: 'lager',
            standard: false,
            archiviert: false,
            geaendertAm: '2026-10-15T10:00:00.000Z',
            erstelltAm: '2026-10-15T09:00:00.000Z',
          },
        },
        {
          op: 'create',
          entity: 'projekt',
          payload: {
            id: 'p-1',
            nummer: 'PRJ-001',
            archiviert: false,
            geaendertAm: '2026-10-15T10:00:00.000Z',
            erstelltAm: '2026-10-15T09:00:00.000Z',
          },
        },
      ],
      'u1',
      'user',
    )

    expect(captured.inserts).toHaveLength(4) // 2× Stammdaten + 2× auditLog
    const stammdatenInserts = captured.inserts.filter((r) => 'geaendertAm' in r)
    expect(stammdatenInserts).toHaveLength(2)
    for (const row of stammdatenInserts) {
      expect(row['geaendertAm']).toBeInstanceOf(Date)
      expect(row['erstelltAm']).toBeInstanceOf(Date)
    }
  })

  it('artikel update: geaendertAm/erstelltAm werden als Date an set() übergeben', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const captured = { inserts: [] as Array<Record<string, unknown>>, updates: [] as Array<Record<string, unknown>> }
    // Jetzt simulieren wir einen existierenden Datensatz, damit der Update-Pfad
    // in applyLastWriterWins läuft.
    const txMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: 'a-1',
                  geaendertAm: '2026-10-14T10:00:00.000Z', // Server ist ÄLTER → Update geht durch
                  erstelltAm: '2026-10-01T00:00:00.000Z',
                },
              ]),
          }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.inserts.push(v)
          return Promise.resolve()
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          captured.updates.push(v)
          return { where: () => Promise.resolve() }
        },
      }),
    }
    const dbMock = { transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock) } as never

    await resolvePush(
      dbMock,
      [
        {
          op: 'update',
          entity: 'artikel',
          payload: {
            id: 'a-1',
            titel: 'Umbenannt',
            status: 'verfuegbar',
            typ: 'Demo',
            verpackungseinheit: 1,
            geaendertAm: '2026-10-15T10:00:00.000Z',
            erstelltAm: '2026-10-15T09:00:00.000Z',
          },
        },
      ],
      'u1',
      'user',
    )

    expect(captured.updates).toHaveLength(1)
    const setRow = captured.updates[0]!
    expect(setRow['geaendertAm']).toBeInstanceOf(Date)
    expect(setRow['erstelltAm']).toBeInstanceOf(Date)
  })
})

// Regression: PWA schickt Buchungs-`erstelltAm`/`clientEingabeAm` ebenfalls als
// ISO-String (per `buchungSchema` validiert, nicht transformiert). Drizzle's
// `PgTimestamp.mapToDriverValue` ruft `value.toISOString()` auf — Strings
// haben die Methode nicht und der Push bricht mit
// `TypeError: value.toISOString is not a function` ab. Vorher war nur der
// Stammdaten-Pfad gefixt; Buchungen crashten bis 0.2.19 mit demselben Bug.
describe('Resolver — Buchungs-Insert normalisiert ISO-Strings auf Date', () => {
  // Minimaler Mock: jede `select().from().where().limit()` liefert per
  // Default ein "existiert"-Tupel (Referenzpruefungen in resolveBuchungCreate
  // fuer artikel/standort). Die Idempotenz-Pruefung auf der buchungen-Tabelle
  // liefert per Default ein LEERES Array (Buchung existiert noch nicht,
  // sonst wuerde resolveBuchungCreate frueh returnen). Wir muessen
  // differenzieren, weil resolveBuchungCreate drei verschiedene Lookups
  // macht: (1) `select().from(buchungen)` fuer Idempotenz, (2) `select({id})`
  // .from(artikel)` und (3) `select({id}).from(standorte)`. Leider
  // koennen wir die Tabellen-Referenzen im Mock nicht zuverlaessig
  // unterscheiden (Drizzle-Proxies), daher zaehlen wir die Aufrufe und
  // liefern abwechselnd "leer" und "existiert":
  //   1. Aufruf: Idempotenz auf buchungen → leer (Insert erlaubt)
  //   2. Aufruf: artikel existiert → existiert
  //   3. Aufruf: standort existiert → existiert
  // Wir nutzen keine Negativ-Bestands-Pruefung (Typ = einlagerung).
  function makeMockDb(captured: {
    inserts: Array<Record<string, unknown>>
    updates: Array<Record<string, unknown>>
  }) {
    let selectCallCount = 0
    const txMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount++
              // 1. Aufruf = Idempotenz-Check auf buchungen → leer
              // 2./3. Aufruf = Referenz-Checks → existiert
              if (selectCallCount === 1) return Promise.resolve([])
              return Promise.resolve([{ id: 'exists' }])
            },
          }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          captured.inserts.push(v)
          return Promise.resolve()
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          captured.updates.push(v)
          return { where: () => Promise.resolve() }
        },
      }),
    }
    return { transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock) } as never
  }

  it('buchung create: erstelltAm/clientEingabeAm werden als Date an insert übergeben', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const captured = {
      inserts: [] as Array<Record<string, unknown>>,
      updates: [] as Array<Record<string, unknown>>,
    }
    const dbMock = makeMockDb(captured)

    await resolvePush(
      dbMock,
      [
        {
          op: 'create',
          entity: 'buchung',
          payload: {
            id: 'b-1',
            artikelId: 'a-1',
            standortId: 's-1',
            typ: 'einlagerung',
            menge: 5,
            erstelltAm: '2026-10-15T10:00:00.000Z',
            clientEingabeAm: '2026-10-15T09:30:00.000Z',
            erstelltVon: 'u1',
            storno: false,
          },
        },
      ],
      'u1',
      'user',
    )

    // 1× buchungen + 1× auditLog
    expect(captured.inserts.length).toBeGreaterThanOrEqual(1)
    const buchungInsert = captured.inserts.find((r) => 'menge' in r)
    expect(buchungInsert).toBeDefined()
    const row = buchungInsert!
    expect(row['erstelltAm']).toBeInstanceOf(Date)
    expect(row['clientEingabeAm']).toBeInstanceOf(Date)
    expect((row['erstelltAm'] as Date).toISOString()).toBe('2026-10-15T10:00:00.000Z')
    expect((row['clientEingabeAm'] as Date).toISOString()).toBe('2026-10-15T09:30:00.000Z')
  })

  it('buchung create: clientEingabeAm ist optional (undefined) und wird uebersprungen', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const captured = {
      inserts: [] as Array<Record<string, unknown>>,
      updates: [] as Array<Record<string, unknown>>,
    }
    const dbMock = makeMockDb(captured)

    await resolvePush(
      dbMock,
      [
        {
          op: 'create',
          entity: 'buchung',
          payload: {
            id: 'b-2',
            artikelId: 'a-1',
            standortId: 's-1',
            typ: 'einlagerung',
            menge: 1,
            erstelltAm: '2026-10-15T10:00:00.000Z',
            // clientEingabeAm bewusst weggelassen
            erstelltVon: 'u1',
            storno: false,
          },
        },
      ],
      'u1',
      'user',
    )

    const buchungInsert = captured.inserts.find((r) => 'menge' in r)
    expect(buchungInsert).toBeDefined()
    const row = buchungInsert!
    expect(row['erstelltAm']).toBeInstanceOf(Date)
    // clientEingabeAm bleibt undefined — normalizeBuchungTimestamps fasst
    // nur Strings an, ueberspringt undefined-Werte.
    expect(row['clientEingabeAm']).toBeUndefined()
  })
})