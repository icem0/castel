// Regressionstests fuer die Berechtigungs- und Attributions-Regeln, die im
// Security-Audit-Lauf eingefuehrt wurden:
//   * Kommissionen: Umbenennen/Loeschen bleibt Admin-Sache (SEC-005).
//   * Buchungen: `erstelltVon` kommt vom Server, nicht aus dem Payload (SEC-006).
//   * Einstellungen: Admin-only-Schluessel nur global, globale Schluessel nur
//     mit Berechtigung (SEC-007/SEC-008).
//   * Zeitstempel in der Zukunft werden geklemmt (SEC-009).

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

const kommissionPayload = {
  id: 'k-1',
  nummer: 'P-4711',
  name: 'Baustelle Nord',
  archiviert: false,
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
  erstelltVon: 'fremder-user',
  kommentar: null,
  mitteilungAn: null,
  stornoVon: null,
  storno: false,
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

describe('Resolver — Security-Regeln', () => {
  it('lehnt das Umbenennen einer Kommission durch normale User ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'kommission', payload: kommissionPayload }],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('stammdaten.verwalten')
  })

  it('lehnt das Loeschen einer Kommission durch normale User ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'delete', entity: 'kommission', payload: kommissionPayload }],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('stammdaten.verwalten')
  })

  it('erlaubt dem Admin, eine Kommission umzubenennen', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'kommission', payload: kommissionPayload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
  })

  it('setzt erstelltVon serverseitig auf den authentifizierten User', async () => {
    const state: MockState = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'buchung', payload: buchungPayload }],
      'u1',
      'user',
    )
    const buchungInsert = state.inserts.find((i) => 'erstelltVon' in i)
    expect(buchungInsert?.['erstelltVon']).toBe('u1')
  })

  it('lehnt einen Admin-only-Schluessel im per-User-Slot ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'artikelTypen',
            userId: 'u1',
            value: '[]',
            geaendertAm: '2026-10-15T10:00:00.000Z',
          },
        },
      ],
      'u1',
      'admin',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.message).toContain('global')
  })

  it('lehnt einen globalen Per-User-Schluessel durch normale User ab', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'sprache',
            userId: null,
            value: 'en',
            geaendertAm: '2026-10-15T10:00:00.000Z',
          },
        },
      ],
      'u1',
      'user',
    )
    expect(result.errors[0]?.code).toBe('VALIDATION')
  })

  it('erlaubt dem Admin einen globalen Per-User-Schluessel', async () => {
    const state: MockState = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'sprache',
            userId: null,
            value: 'en',
            geaendertAm: '2026-10-15T10:00:00.000Z',
          },
        },
      ],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
  })

  it('klemmt Zeitstempel in der Zukunft auf die Serverzeit', async () => {
    const state: MockState = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'create',
          entity: 'artikel',
          payload: { ...artikelPayload, geaendertAm: '2999-12-31T00:00:00.000Z' },
        },
      ],
      'u1',
      ['user', 'lagerist'],
    )
    const artikelInsert = state.inserts.find((i) => 'titel' in i)
    const geaendertAm = artikelInsert?.['geaendertAm']
    expect(geaendertAm).toBeInstanceOf(Date)
    expect((geaendertAm as Date).getTime()).toBeLessThanOrEqual(Date.now())
  })
})
