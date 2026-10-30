// Tests für den Sync-Resolver der Akkutausch-Entities
// (`akku_netzteil`, `akku_projekt`).
//
// Kernpunkte:
//   * Netzteil-Schreibzugriffe sind Admin-only; Projektakkus duerfen von
//     allen Rollen angelegt, aber nur von Admins bearbeitet/geloescht werden.
//   * Last-Writer-Wins auf `geaendertAm`.
//   * NUMERIC-Spalten (Kapazität) werden als String geschrieben.
//   * Soft-Delete: `geloescht = true` wird als Update geschrieben.

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

interface MockState {
  netzteile: Array<Record<string, unknown>>
  projekte: Array<Record<string, unknown>>
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
}

function makeMockDb(state: MockState): never {
  const txMock = {
    select: () => ({
      from: (table: unknown) => {
        const id = tableId(table)
        return {
          where: (clause: unknown) => {
            const params = extractParams(clause).filter((p) => typeof p === 'string')
            const rows = id === 'akku_netzteile' ? state.netzteile : state.projekte
            return { limit: () => Promise.resolve(rows.filter((r) => r['id'] === params[0])) }
          },
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        state.inserts.push({ ...value, __table: tableId(table) })
        return Promise.resolve()
      },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: (clause: unknown) => {
          state.updates.push({ ...value, __table: tableId(table) })
          void extractParams(clause)
          return Promise.resolve()
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

function leererState(): MockState {
  return { netzteile: [], projekte: [], inserts: [], updates: [] }
}

const netzteil = {
  id: 'n-1',
  anlage: 'Anlage 1',
  objekt: 'Objekt 1',
  name: 'Notlichtaggregat',
  einbaudatum: '2020-01-15',
  intervallJahre: 5,
  kapazitaetAh: 12.5,
  anzahl: 2,
  gruppe: null,
  plz: null,
  vdsAnerkennung: null,
  bemerkung: null,
  geloescht: false,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

const projekt = {
  id: 'p-1',
  projekt: 'Bauvorhaben',
  menge: 4,
  artAh: 100,
  quartal: 1,
  jahr: 2027,
  geloescht: false,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

describe('resolvePush — akku_netzteil', () => {
  it('legt ein Netzteil an (Admin)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['n-1'])
    const ins = state.inserts.filter((r) => r['__table'] === 'akku_netzteile')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ id: 'n-1', anlage: 'Anlage 1' })
  })

  it('schreibt NUMERIC-Felder als String', async () => {
    const state = leererState()
    await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'admin',
    )
    const ins = state.inserts.find((r) => r['__table'] === 'akku_netzteile')
    expect(ins?.['kapazitaetAh']).toBe('12.50')
  })

  it('lehnt Schreibzugriffe von Mitarbeitern ab', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'user',
    )
    expect(result.accepted).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(state.inserts).toHaveLength(0)
  })

  it('aktualisiert per Last-Writer-Wins', async () => {
    const state = leererState()
    state.netzteile = [
      {
        ...netzteil,
        anlage: 'alte Anlage',
        geaendertAm: new Date('2026-10-14T10:00:00.000Z'),
      },
    ]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(state.updates.filter((r) => r['__table'] === 'akku_netzteile')).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ anlage: 'Anlage 1' })
  })

  it('meldet einen Konflikt, wenn der Server neuer ist', async () => {
    const state = leererState()
    state.netzteile = [
      {
        ...netzteil,
        geaendertAm: new Date('2026-10-16T10:00:00.000Z'),
      },
    ]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'admin',
    )
    expect(result.conflicts).toHaveLength(1)
    expect(state.updates).toHaveLength(0)
  })

  it('schreibt das Soft-Delete als Update', async () => {
    const state = leererState()
    state.netzteile = [
      { ...netzteil, geaendertAm: new Date('2026-10-14T10:00:00.000Z') },
    ]
    const geloescht = { ...netzteil, geloescht: true }
    await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_netzteil', payload: geloescht }],
      'u1',
      'admin',
    )
    const upd = state.updates.find((r) => r['__table'] === 'akku_netzteile')
    expect(upd?.['geloescht']).toBe(true)
  })

  it('schreibt einen Audit-Log-Eintrag mit der Entity', async () => {
    const state = leererState()
    await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'admin',
    )
    const audit = state.inserts.find((r) => r['__table'] === 'audit_log')
    expect(audit?.['entitaet']).toBe('akku_netzteil')
    expect(audit?.['entitaetId']).toBe('n-1')
  })

  it('lehnt Anlegen durch Mitarbeiter ab (Netzteile bleiben Admin-only)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_netzteil', payload: netzteil }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(state.inserts).toHaveLength(0)
  })
})

describe('resolvePush — akku_projekt', () => {
  it('legt einen Projektakku an (Admin)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_projekt', payload: projekt }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['p-1'])
    const ins = state.inserts.filter((r) => r['__table'] === 'akku_projekte')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ projekt: 'Bauvorhaben', menge: 4 })
    expect(ins[0]?.['artAh']).toBe('100.00')
  })

  it('legt einen Projektakku auch fuer Mitarbeiter an (Hinzufuegen ist offen)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'akku_projekt', payload: projekt }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['p-1'])
    const ins = state.inserts.filter((r) => r['__table'] === 'akku_projekte')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ projekt: 'Bauvorhaben', menge: 4 })
  })

  it('lehnt Bearbeiten durch Mitarbeiter ab (Update ist Admin-only)', async () => {
    const state = leererState()
    state.projekte = [{ ...projekt, geaendertAm: new Date('2026-10-14T10:00:00.000Z') }]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_projekt', payload: projekt }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(state.updates.filter((r) => r['__table'] === 'akku_projekte')).toHaveLength(0)
  })

  it('lehnt Soft-Delete durch Mitarbeiter ab', async () => {
    const state = leererState()
    state.projekte = [{ ...projekt, geaendertAm: new Date('2026-10-14T10:00:00.000Z') }]
    const geloescht = { ...projekt, geloescht: true }
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'akku_projekt', payload: geloescht }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(state.updates.filter((r) => r['__table'] === 'akku_projekte')).toHaveLength(0)
  })
})
