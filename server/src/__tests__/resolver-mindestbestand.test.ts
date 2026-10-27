// Tests für den Mindestbestand-Trigger im Sync-Resolver.
//
// Der Mock trennt bewusst die Pool-Verbindung (`db`) vom Transaktions-Handle
// (`tx`): Inserts, die in der offenen Transaktion passieren, sind nur dem tx
// sichtbar — genau wie bei Postgres. Damit ist der Test sensibel auf den
// Regression-Fehler, den Bestand über den Pool (`db`) statt über `tx` zu
// lesen: der Pool sieht die soeben insertete Buchung nicht und liefert einen
// zu alten Bestand (früher: 0 bei einem frischen Bestand).
//
// Der Mock ist absichtlich minimal: er filtert nicht nach artikelId/
// standortId, sondern summiert alle Buchungen. Alle Fixtures verwenden
// deshalb genau einen Artikel und einen Standort.

import { describe, it, expect, vi } from 'vitest'
import type { PushOp } from '../sync/resolver.js'

interface MockBooking {
  id: string
  standortId: string
  menge: number
  storno: boolean
}

interface MockState {
  artikel: Array<Record<string, unknown>>
  standort: Array<Record<string, unknown>>
  /**
   * Mindestbestand je (Artikel, Standort). Die Schwellen liegen nicht mehr
   * am Artikel, sondern pro Paar — der Trigger liest ausschliesslich
   * diese Tabelle (kein globaler Fallback).
   */
  mindestbestaende: Array<{ artikelId: string; standortId: string; mindestbestand: number }>
  /** Committed bookings — the only rows visible on the pooled connection. */
  committed: MockBooking[]
  /** Bookings inserted in the still-open transaction (tx-only). */
  pending: MockBooking[]
  eventInserts: Array<Record<string, unknown>>
}

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

function tableId(table: unknown): string | undefined {
  if (!table || typeof table !== 'object') return undefined
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  if (typeof v === 'string') return v
  // Fallback für vitest: das DRIZZLE_NAME-Symbol ist hier nicht immer
  // auflösbar, drizzle-Tabellen haben aber eine `.name`-Eigenschaft.
  const t = table as Record<string, unknown>
  if (typeof t.name === 'string') return t.name
  return undefined
}

/**
 * Aggregate-Projektionen (`berechneBestand`) bauen ihr Feld mit `sql` —
 * ein `SQL`-Objekt erkennt man an `queryChunks`. Spalten-Referenzen
 * (z. B. `{ id: artikel.id })` haben dieses Feld nicht.
 */
function isAggregateProjection(projection: unknown): boolean {
  if (!projection || typeof projection !== 'object') return false
  return Object.values(projection as Record<string, unknown>).some(
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && 'queryChunks' in v,
  )
}

/** Awaitable row list that also supports `.limit(n)` (drizzle chain). */
function rowsPromise<T>(rows: T[]): Promise<T> & { limit: (n: number) => Promise<T> } {
  const p = Promise.resolve(rows) as Promise<T> & { limit: (n: number) => Promise<T> }
  p.limit = (n: number) => Promise.resolve(rows.slice(0, n))
  return p
}

function sumBestand(rows: MockBooking[]): number {
  return rows.reduce((sum, r) => (r.storno ? sum : sum + r.menge), 0)
}

/**
 * Collects the bound values of a drizzle `where` clause (`Param` nodes).
 * Used to honour the idempotency lookup on `buchungen.id`.
 */
function extractParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out
  seen.add(node)
  const o = node as Record<string, unknown>
  if (o.constructor?.name === 'Param') out.push(o.value)
  if (Array.isArray(o.queryChunks)) o.queryChunks.forEach((c) => extractParams(c, out, seen))
  return out
}

function makeSelect(state: MockState, scope: 'db' | 'tx') {
  return (projection: unknown) => ({
    from: (table: unknown) => {
      const id = tableId(table)

      if (isAggregateProjection(projection)) {
        // The pooled connection must never see uncommitted rows.
        const visible =
          id === 'buchungen'
            ? scope === 'tx'
              ? [...state.committed, ...state.pending]
              : state.committed
            : []
        // Single article/standort per fixture — only `storno` is filtered.
        const total = sumBestand(visible.filter((r) => !r.storno))
        return { where: () => rowsPromise([{ total }]) }
      }

      if (id === 'buchungen') {
        const visible = scope === 'tx' ? [...state.committed, ...state.pending] : state.committed
        return {
          where: (clause: unknown) => {
            const wanted = extractParams(clause).find((p) => typeof p === 'string')
            return rowsPromise(visible.filter((r) => r.id === wanted))
          },
        }
      }

      if (id === 'artikel_standort_mindestbestaende') {
        return {
          where: (clause: unknown) => {
            const params = extractParams(clause).filter((p): p is string => typeof p === 'string')
            const [artikelId, standortId] = params
            return rowsPromise(
              state.mindestbestaende.filter(
                (m) => m.artikelId === artikelId && m.standortId === standortId,
              ),
            )
          },
        }
      }

      return {
        where: () => ({
          limit: (n: number) => {
            if (id === 'artikel') return Promise.resolve(state.artikel.slice(0, n))
            if (id === 'standorte') return Promise.resolve(state.standort.slice(0, n))
            return Promise.resolve([])
          },
        }),
      }
    },
  })
}

function makeMockDb(state: MockState): unknown {
  const insertFn = (table: unknown) => {
    const id = tableId(table)
    return {
      values: (v: Record<string, unknown>) => {
        if (id === 'mindestbestand_ereignisse') {
          state.eventInserts.push(v)
        } else if (id === 'buchungen') {
          const booking: MockBooking = {
            id: String(v.id ?? ''),
            standortId: String(v.standortId ?? ''),
            menge: Number(v.menge ?? 0),
            storno: v.storno === true,
          }
          // Inserts always happen inside the open transaction. They become
          // visible to the pool only after COMMIT.
          state.pending.push(booking)
        }
        return Promise.resolve()
      },
    }
  }
  const updateFn = () => ({ set: () => ({ where: () => Promise.resolve() }) })

  const db = {
    select: makeSelect(state, 'db'),
    insert: insertFn,
    update: updateFn,
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: makeSelect(state, 'tx'),
        insert: insertFn,
        update: updateFn,
      }
      try {
        await fn(tx)
        // COMMIT: pending rows become visible to the pool.
        state.committed.push(...state.pending)
        state.pending = []
      } catch (err) {
        // ROLLBACK: pending rows never reach the pool.
        state.pending = []
        throw err
      }
    },
  }
  return db
}

function buchungOp(payload: Record<string, unknown>): PushOp {
  return { op: 'create', entity: 'buchung', payload } as PushOp
}

function entnahme(id: string, menge: number): Record<string, unknown> {
  return {
    id,
    artikelId: 'a-1',
    standortId: 's-1',
    typ: 'entnahme',
    menge,
    erstelltAm: '2026-04-14T11:00:00.000Z',
    erstelltVon: 'u-1',
    storno: false,
  }
}

function einlagerung(id: string, menge: number): Record<string, unknown> {
  return { ...entnahme(id, menge), typ: 'einlagerung' }
}

describe('Sync-Resolver — Mindestbestand-Trigger', () => {
  it('Pure-Funktion sollteWarnungAusloesen ist mit Server byte-identisch', async () => {
    // Schon im Paritätstest geprüft, hier nur als Sanity-Check.
    const { sollteWarnungAusloesen } = await import('../domain/mindestbestand.js')
    expect(sollteWarnungAusloesen(null, 0)).toBe(false)
    expect(sollteWarnungAusloesen(5, 5)).toBe(false)
    expect(sollteWarnungAusloesen(5, 4)).toBe(true)
    // 0 = "kein Mindestbestand" → kein Alarm.
    expect(sollteWarnungAusloesen(0, 0)).toBe(false)
  })

  it('kein Alarm, wenn fuer das Lager kein Mindestbestand konfiguriert ist', async () => {
    // Kein globaler Fallback: `artikel.mindestbestand` wird nicht mehr
    // ausgewertet. Ohne Konfiguration (Artikel, Standort) kein Event.
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1', mindestbestand: 50 }],
      standort: [{ id: 's-1' }],
      mindestbestaende: [],
      committed: [{ id: 'b-0', standortId: 's-1', menge: 60, storno: false }],
      pending: [],
      eventInserts: [],
    }
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(entnahme('b-1', -20))],
      'u-1',
      'user',
    )
    expect(state.eventInserts).toEqual([])
  })

  it('kein Alarm, wenn der Mindestbestand 0 ist', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      standort: [{ id: 's-1' }],
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-1', mindestbestand: 0 }],
      committed: [{ id: 'b-0', standortId: 's-1', menge: 60, storno: false }],
      pending: [],
      eventInserts: [],
    }
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(entnahme('b-1', -20))],
      'u-1',
      'user',
    )
    expect(state.eventInserts).toEqual([])
  })

  it('Mindestbestand gilt nur fuer das konfigurierte Lager', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      standort: [{ id: 's-1' }],
      // Schwelle 50 nur fuer Lager s-2, die Buchung laeuft gegen s-1.
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-2', mindestbestand: 50 }],
      committed: [{ id: 'b-0', standortId: 's-1', menge: 60, storno: false }],
      pending: [],
      eventInserts: [],
    }
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(entnahme('b-1', -20))],
      'u-1',
      'user',
    )
    expect(state.eventInserts).toEqual([])
  })

  it('liest den Bestand in der offenen Transaktion (kein Stale-Read)', async () => {
    // 60 rein, 28 raus → 32. Mindestbestand 50.
    // Der Pool (`db`) sieht die -28-Buchung der eigenen Transaktion nicht:
    // ein Stale-Read ergäbe 60 und damit KEIN Event.
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-1', mindestbestand: 50 }],
      standort: [{ id: 's-1' }],
      committed: [],
      pending: [],
      eventInserts: [],
    }
    const result = await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(einlagerung('b-1', 60)), buchungOp(entnahme('b-2', -28))],
      'u-1',
      'user',
    )
    expect(result.errors).toEqual([])
    expect(result.accepted).toEqual(['b-1', 'b-2'])
    // Einlagerung auf 60 liegt über dem Mindestbestand → kein Event.
    expect(state.eventInserts).toHaveLength(1)
    expect(state.eventInserts[0]).toMatchObject({
      bestandDanach: 32,
      mindestbestand: 50,
      defizit: 18,
      ausloeserBuchungId: 'b-2',
    })
  })

  it('Initial-Sync liefert nie Bestand 0 pro Buchung', async () => {
    // Frischer Bestand (nach DB-Reset): beide Buchungen kommen in einem Push.
    // Der alte Bug hätte 0 und 40 geschrieben (Pool-Sicht auf die jeweils
    // vorherige Buchung), korrekt sind 40 und 32.
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-1', mindestbestand: 50 }],
      standort: [{ id: 's-1' }],
      committed: [],
      pending: [],
      eventInserts: [],
    }
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(einlagerung('b-1', 40)), buchungOp(entnahme('b-2', -8))],
      'u-1',
      'user',
    )
    expect(state.eventInserts.map((e) => e.bestandDanach)).toEqual([40, 32])
    expect(state.eventInserts.map((e) => e.defizit)).toEqual([10, 18])
  })

  it('kein Event, wenn der Bestand danach über dem Mindestbestand liegt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-1', mindestbestand: 50 }],
      standort: [{ id: 's-1' }],
      committed: [{ id: 'b-0', standortId: 's-1', menge: 60, storno: false }],
      pending: [],
      eventInserts: [],
    }
    const dispatch = vi.fn().mockResolvedValue(undefined)
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(entnahme('b-1', -5))],
      'u-1',
      'user',
      { name: 'mock', dispatchMindestbestandEvent: dispatch } as never,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(state.eventInserts).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('Notification-Gateway wird mit korrekt berechnetem Event gefüttert', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      artikel: [{ id: 'a-1' }],
      mindestbestaende: [{ artikelId: 'a-1', standortId: 's-1', mindestbestand: 50 }],
      standort: [{ id: 's-1' }],
      committed: [{ id: 'b-0', standortId: 's-1', menge: 40, storno: false }],
      pending: [],
      eventInserts: [],
    }
    const dispatch = vi.fn().mockResolvedValue(undefined)
    await resolvePush(
      makeMockDb(state) as never,
      [buchungOp(entnahme('b-1', -12))],
      'u-1',
      'user',
      { name: 'mock', dispatchMindestbestandEvent: dispatch } as never,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ bestandDanach: 28, defizit: 22 })
  })
})
