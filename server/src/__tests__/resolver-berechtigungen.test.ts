// Tests der Berechtigungspruefung im Sync-Resolver.
//
// Der Resolver ist die serverseitige Autoritaet: er entscheidet, welche Ops
// ein User ueberhaupt schreiben darf. Diese Tests sichern ab, dass
//   * ein normaler User keine Stammdaten aendert,
//   * ein Lagerist genau die Lager-Rechte hat,
//   * ein Admin alles darf.

import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

function tableId(table: unknown): string {
  if (!table || typeof table !== 'object') return 'unknown'
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  if (typeof v === 'string') return v
  const t = table as Record<string, unknown>
  return typeof t.name === 'string' ? t.name : 'unknown'
}

function extractParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out
  seen.add(node)
  const o = node as Record<string, unknown>
  if (o.constructor?.name === 'Param') out.push(o.value)
  if (Array.isArray(o.queryChunks)) o.queryChunks.forEach((c) => extractParams(c, out, seen))
  return out
}

/** Liefert ein Objekt, das sowohl awaitbar ist als auch `.limit()` traegt. */
function rowsResult(rows: unknown[]): {
  limit: () => Promise<unknown[]>
  then: Promise<unknown[]>['then']
} {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise) as Promise<unknown[]>['then'],
  }
}

interface MockState {
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
}

function makeMockDb(state: MockState): never {
  const txMock = {
    // `select()` ohne Spalten = "Zeile holen" (existiert der Datensatz?),
    // `select({...})` = Referenz-/Summen-Abfrage.
    select: (columns?: unknown) => ({
      from: (table: unknown) => {
        const id = tableId(table)
        return {
          where: (clause: unknown) => {
            const params = extractParams(clause).filter((p) => typeof p === 'string')
            if (columns !== undefined && id === 'artikel') return rowsResult([{ id: params[0] }])
            if (columns !== undefined && id === 'standorte') return rowsResult([{ id: params[0] }])
            return rowsResult([])
          },
        }
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        state.inserts.push(value)
        return Promise.resolve()
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        state.updates.push(value)
        return { where: () => Promise.resolve() }
      },
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

const artikelPayload = {
  id: 'a-1',
  titel: 'Testartikel',
  status: 'verfuegbar',
  typ: 'Demo',
  verpackungseinheit: 1,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

const standortPayload = {
  id: 's-1',
  name: 'Lager Nord',
  typ: 'lager',
  standard: false,
  archiviert: false,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

const mindestbestandPayload = {
  artikelId: 'a-1',
  standortId: 's-1',
  mindestbestand: 5,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

const buchungPayload = {
  id: 'b-1',
  artikelId: 'a-1',
  standortId: 's-1',
  standortZielId: null,
  typ: 'einlagerung',
  menge: 1,
  paarId: null,
  projekt: null,
  erstelltAm: '2026-10-15T10:00:00.000Z',
  clientEingabeAm: '2026-10-15T10:00:00.000Z',
  erstelltVon: 'u1',
  kommentar: null,
  mitteilungAn: null,
  stornoVon: null,
}

describe('resolvePush — Berechtigungen', () => {
  it('lehnt Artikel-Schreibzugriffe von normalen Usern ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload }],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('artikel.schreiben')
    expect(state.inserts).toHaveLength(0)
  })

  it('erlaubt dem Lagerist, Artikel anzulegen', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload }],
      'u1',
      ['user', 'lagerist'],
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toContain('a-1')
  })

  it('lehnt Standort-Schreibzugriffe von normalen Usern ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'standort', payload: standortPayload }],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('standort.schreiben')
    expect(state.inserts).toHaveLength(0)
  })

  it('erlaubt dem Lagerist, Standorte anzulegen', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'standort', payload: standortPayload }],
      'u1',
      ['user', 'lagerist'],
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toContain('s-1')
  })

  it('verbietet dem Lagerist das Loeschen eines Standorts', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'delete', entity: 'standort', payload: standortPayload }],
      'u1',
      ['user', 'lagerist'],
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('standort.loeschen')
  })

  it('lehnt Mindestbestand-Aenderungen von normalen Usern ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'create',
          entity: 'artikel_standort_mindestbestand',
          payload: mindestbestandPayload,
        },
      ],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('mindestbestand.schreiben')
  })

  it('erlaubt dem Lagerist, den Mindestbestand zu pflegen', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'create',
          entity: 'artikel_standort_mindestbestand',
          payload: mindestbestandPayload,
        },
      ],
      'u1',
      ['user', 'lagerist'],
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toContain('a-1#s-1')
  })

  it('erlaubt Buchungen fuer alle Rollen (kein Berechtigungsfehler)', async () => {
    for (const rollen of [['user'], ['user', 'lagerist'], ['admin']]) {
      const state: MockState = { inserts: [], updates: [] }
      const result = await resolvePush(
        makeMockDb(state),
        [{ op: 'create', entity: 'buchung', payload: buchungPayload }],
        'u1',
        rollen,
      )
      const fehler = result.errors[0]
      expect(fehler?.message ?? '', `Rolle ${rollen.join('+')}`).not.toContain('Berechtigung')
    }
  })
})
