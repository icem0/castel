// Tests für den Sync-Resolver der Entity `etiketten_bogen_layout`.
//
// Kernpunkte:
//   * Identitaet ist der User (unique Index auf `user_id`) — das PWA sendet
//     deshalb immer `upsert` (create/update/delete wurden vom Server mit
//     HTTP 400 abgelehnt und legten die komplette Outbox still).
//   * Last-Writer-Wins auf `geaendertAm`.
//   * `delete` traegt nur die Identitaet (id + userId).
//   * Fremde userId wird abgelehnt.

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

interface MockState {
  layout: Array<Record<string, unknown>>
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  deletes: Array<string>
}

function extractParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out
  seen.add(node)
  const o = node as Record<string, unknown>
  if (o.constructor?.name === 'Param') out.push(o.value)
  if (Array.isArray(o.queryChunks)) o.queryChunks.forEach((c) => extractParams(c, out, seen))
  return out
}

function makeMockDb(state: MockState): never {
  const txMock = {
    select: () => ({
      from: (table: unknown) => ({
        where: (clause: unknown) => {
          const params = extractParams(clause).filter((p) => typeof p === 'string')
          if (tableId(table) === 'etiketten_bogen_layout') {
            return {
              limit: () =>
                Promise.resolve(state.layout.filter((r) => r['userId'] === params[0])),
            }
          }
          return { limit: () => Promise.resolve([]) }
        },
      }),
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
    delete: (table: unknown) => ({
      where: (clause: unknown) => {
        void extractParams(clause)
        state.deletes.push(tableId(table))
        return Promise.resolve()
      },
    }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

const LAYOUT = {
  id: 'benutzerdefiniert',
  layout: 'raster',
  cols: 3,
  rows: 7,
  labelW: 63.5,
  labelH: 38.1,
  gapX: 2.5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

const payload = {
  id: 'benutzerdefiniert',
  userId: 'u1',
  layout: LAYOUT,
  geaendertAm: '2026-10-30T10:00:00.000Z',
  erstelltAm: '2026-10-30T09:00:00.000Z',
}

function stateOhneLayout(): MockState {
  return { layout: [], inserts: [], updates: [], deletes: [] }
}

describe('resolvePush — etiketten_bogen_layout', () => {
  it('legt ein Layout mit op = upsert an (PWA sendet immer upsert)', async () => {
    const state = stateOhneLayout()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'upsert', entity: 'etiketten_bogen_layout', payload }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['benutzerdefiniert'])
    const ins = state.inserts.filter((r) => r['__table'] === 'etiketten_bogen_layout')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ userId: 'u1', layout: LAYOUT })
  })

  it('ueberschreibt ein aelteres Layout (LWW)', async () => {
    const state = stateOhneLayout()
    state.layout = [
      {
        userId: 'u1',
        layout: LAYOUT,
        geaendertAm: new Date('2026-10-29T10:00:00.000Z'),
        erstelltAm: new Date('2026-10-29T09:00:00.000Z'),
      },
    ]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'upsert', entity: 'etiketten_bogen_layout', payload }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(state.inserts.filter((r) => r['__table'] === 'etiketten_bogen_layout')).toHaveLength(0)
    expect(state.updates).toHaveLength(1)
  })

  it('verwirft ein aelteres Layout still (kein Update, kein Konflikt)', async () => {
    const state = stateOhneLayout()
    state.layout = [
      {
        userId: 'u1',
        layout: LAYOUT,
        geaendertAm: new Date('2026-10-31T10:00:00.000Z'),
        erstelltAm: new Date('2026-10-29T09:00:00.000Z'),
      },
    ]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'upsert', entity: 'etiketten_bogen_layout', payload }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.conflicts).toHaveLength(0)
    expect(state.updates).toHaveLength(0)
  })

  it('loescht mit Identitaets-Payload (nur id + userId)', async () => {
    const state = stateOhneLayout()
    state.layout = [
      {
        userId: 'u1',
        layout: LAYOUT,
        geaendertAm: new Date('2026-10-29T10:00:00.000Z'),
        erstelltAm: new Date('2026-10-29T09:00:00.000Z'),
      },
    ]
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'delete',
          entity: 'etiketten_bogen_layout',
          payload: { id: 'benutzerdefiniert', userId: 'u1' },
        },
      ],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(state.deletes).toContain('etiketten_bogen_layout')
  })

  it('lehnt ein unvollstaendiges Schreib-Payload pro Op ab (kein Batch-400)', async () => {
    const state = stateOhneLayout()
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'upsert',
          entity: 'etiketten_bogen_layout',
          payload: { id: 'benutzerdefiniert', userId: 'u1' },
        },
      ],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(state.inserts.filter((r) => r['__table'] === 'etiketten_bogen_layout')).toHaveLength(0)
  })

  it('lehnt eine fremde userId ab (VALIDATION)', async () => {
    const state = stateOhneLayout()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'upsert', entity: 'etiketten_bogen_layout', payload: { ...payload, userId: 'u2' } }],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(result.errors[0]?.id).toBe('benutzerdefiniert')
    expect(state.inserts.filter((r) => r['__table'] === 'etiketten_bogen_layout')).toHaveLength(0)
  })
})
