// Tests für die Storno-Kette im Sync-Resolver.
//
// Der Resolver leitet den storno-Zustand eines Originals aus der Storno-Kette
// ab (Storno-Buchung → Original; Aufhebungs-Marker → Storno-Buchung). Die
// storno-Flags aus dem Payload werden bewusst NICHT übernommen.
//
// Der Mock ist tabellenbewusst (buchungen/artikel/standorte) und hält die
// Buchungen in-memory, damit `select`/`insert`/`update` auf demselben Zustand
// arbeiten — nötig, weil der Resolver nach dem Insert das Ziel per `update`
// markiert.

import { describe, it, expect } from 'vitest'
import type { PushOp } from '../sync/resolver.js'

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

interface Row {
  id: string
  artikelId: string
  standortId: string
  typ: string
  menge: number
  storno: boolean
  stornoVon: string | null
  storniertDurch: string | null
}

interface State {
  buchungen: Row[]
  artikel: Array<Record<string, unknown>>
  standorte: Array<Record<string, unknown>>
}

function tableId(table: unknown): string | undefined {
  if (!table || typeof table !== 'object') return undefined
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  if (typeof v === 'string') return v
  const t = table as Record<string, unknown>
  if (typeof t.name === 'string') return t.name
  return undefined
}

/** Collects the bound values of a drizzle where clause (`Param` nodes). */
function extractParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out
  seen.add(node)
  const o = node as Record<string, unknown>
  if (o.constructor?.name === 'Param') out.push(o.value)
  if (Array.isArray(o.queryChunks)) o.queryChunks.forEach((c) => extractParams(c, out, seen))
  return out
}

function firstString(value: unknown): string | undefined {
  return extractParams(value).find((p): p is string => typeof p === 'string')
}

/** Awaitable row list that also supports `.limit(n)` (drizzle chain). */
function rowsPromise<T>(rows: T[]): Promise<T> & { limit: (n: number) => Promise<T> } {
  const p = Promise.resolve(rows) as Promise<T> & { limit: (n: number) => Promise<T> }
  p.limit = (n: number) => Promise.resolve(rows.slice(0, n))
  return p
}

function makeMockDb(state: State): unknown {
  const selectFn = (projection?: unknown) => ({
    from: (table: unknown) => {
      const tableName = tableId(table)
      return {
        where: (clause: unknown) => {
          const wanted = firstString(clause)
          const rows =
            tableName === 'buchungen'
              ? state.buchungen.filter((r) => !wanted || r.id === wanted)
              : tableName === 'artikel'
                ? state.artikel
                : tableName === 'standorte'
                  ? state.standorte
                  : []
          void projection
          return rowsPromise(rows)
        },
      }
    },
  })

  const insertFn = (table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      if (tableId(table) === 'buchungen') {
        state.buchungen.push({
          id: String(v.id ?? ''),
          artikelId: String(v.artikelId ?? ''),
          standortId: String(v.standortId ?? ''),
          typ: String(v.typ ?? ''),
          menge: Number(v.menge ?? 0),
          storno: v.storno === true,
          stornoVon: (v.stornoVon as string | null | undefined) ?? null,
          storniertDurch: (v.storniertDurch as string | null | undefined) ?? null,
        })
      }
      return Promise.resolve()
    },
  })

  const updateFn = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (clause: unknown) => {
        const id = firstString(clause)
        if (tableId(table) === 'buchungen' && id) {
          const row = state.buchungen.find((r) => r.id === id)
          if (row) Object.assign(row, values)
        }
        return Promise.resolve()
      },
    }),
  })

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      await fn({ select: selectFn, insert: insertFn, update: updateFn })
    },
  }
}

function buchungOp(payload: Record<string, unknown>): PushOp {
  return { op: 'create', entity: 'buchung', payload } as PushOp
}

function basis(id: string, overrides: Partial<Row> = {}): Record<string, unknown> {
  return {
    id,
    artikelId: 'a-1',
    standortId: 's-1',
    typ: 'einlagerung',
    menge: 10,
    erstelltAm: '2026-10-15T10:00:00.000Z',
    erstelltVon: 'u-1',
    storno: false,
    stornoVon: null,
    storniertDurch: null,
    ...overrides,
  }
}

function makeState(buchungen: Row[] = []): State {
  return {
    buchungen,
    artikel: [{ id: 'a-1', mindestbestand: null }],
    standorte: [{ id: 's-1' }],
  }
}

function row(state: State, id: string): Row {
  const r = state.buchungen.find((b) => b.id === id)
  if (!r) throw new Error(`Row ${id} fehlt`)
  return r
}

describe('Sync-Resolver — Storno-Kette', () => {
  it('Storno markiert das Original (storno=true, storniertDurch)', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState()
    const result = await resolvePush(
      makeMockDb(state) as never,
      [
        buchungOp(basis('x-1')),
        buchungOp(basis('s-1', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' })),
      ],
      'u-1',
      'user',
    )
    expect(result.errors).toEqual([])
    expect(row(state, 'x-1').storno).toBe(true)
    expect(row(state, 'x-1').storniertDurch).toBe('s-1')
  })

  it('Aufhebungs-Marker reaktiviert das Original', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState()

    await resolvePush(
      makeMockDb(state) as never,
      [
        buchungOp(basis('x-1')),
        buchungOp(basis('s-1', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' })),
      ],
      'u-1',
      'user',
    )
    expect(row(state, 'x-1').storno).toBe(true)

    // Aufhebungs-Marker: verweist auf die Storno-Buchung, zählt nicht (storno=true).
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('u-1', { typ: 'storno', menge: 10, storno: true, stornoVon: 's-1' }))],
      'u-1',
      'user',
    )

    expect(state.buchungen.map((b) => b.id)).toContain('u-1')
    expect(row(state, 'x-1').storno).toBe(false)
    expect(row(state, 'x-1').storniertDurch).toBeNull()
  })

  it('doppelter Storno auf dasselbe Original wird geschluckt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState()

    await resolvePush(
      makeMockDb(state) as never,
      [
        buchungOp(basis('x-1')),
        buchungOp(basis('s-1', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' })),
      ],
      'u-1',
      'user',
    )
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('s-2', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' }))],
      'u-1',
      'user',
    )

    expect(state.buchungen.map((b) => b.id)).not.toContain('s-2')
  })

  it('storno-Flag aus dem Payload wird nicht übernommen (Duplikat ist no-op)', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState([
      {
        id: 'x-1',
        artikelId: 'a-1',
        standortId: 's-1',
        typ: 'einlagerung',
        menge: 10,
        storno: false,
        stornoVon: null,
        storniertDurch: null,
      },
    ])

    // Ein veralteter Client pusht die Original-Buchung mit storno=true,
    // ohne dass eine Storno-Buchung existiert → darf nichts ändern.
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('x-1', { storno: true }))],
      'u-1',
      'user',
    )

    expect(row(state, 'x-1').storno).toBe(false)
  })

  it('nach dem Aufheben ist ein erneuter Storno wieder erlaubt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState()

    await resolvePush(
      makeMockDb(state) as never,
      [
        buchungOp(basis('x-1')),
        buchungOp(basis('s-1', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' })),
      ],
      'u-1',
      'user',
    )
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('u-1', { typ: 'storno', menge: 10, storno: true, stornoVon: 's-1' }))],
      'u-1',
      'user',
    )
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('s-2', { typ: 'storno', menge: -10, storno: true, stornoVon: 'x-1' }))],
      'u-1',
      'user',
    )

    expect(state.buchungen.map((b) => b.id)).toContain('s-2')
    expect(row(state, 'x-1').storno).toBe(true)
    expect(row(state, 'x-1').storniertDurch).toBe('s-2')
  })

  it('bereits vorhandene Buchung wird als skipped gemeldet, nicht als accepted', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state = makeState([
      {
        id: 'x-1',
        artikelId: 'a-1',
        standortId: 's-1',
        typ: 'einlagerung',
        menge: 10,
        storno: false,
        stornoVon: null,
        storniertDurch: null,
      },
    ])

    const result = await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(basis('x-1'))],
      'u-1',
      'user',
    )

    expect(result.accepted).toEqual([])
    expect(result.skipped).toEqual([{ id: 'x-1', reason: 'DUPLICATE_ID' }])
    expect(state.buchungen).toHaveLength(1)
  })
})
