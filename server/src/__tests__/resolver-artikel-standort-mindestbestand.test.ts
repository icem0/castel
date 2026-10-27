// Tests für den Sync-Resolver der neuen Entity
// `artikel_standort_mindestbestand` (Mindestbestand je Artikel + Lager).
//
// Kernpunkte:
//   * Identitaet ist das Paar (artikelId, standortId) — kein UUID-`id`.
//   * Last-Writer-Wins auf `geaendertAm`.
//   * Unbekannte Referenzen (Artikel/Lager) ergeben UNKNOWN_REFERENCE.
//   * Delete entfernt genau das Paar.

import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'
import { pushPayloadSchema } from '../domain/validierung.js'

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

function tableId(table: unknown): string {
  if (!table || typeof table !== 'object') return 'unknown'
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  if (typeof v === 'string') return v
  const t = table as Record<string, unknown>
  return typeof t.name === 'string' ? t.name : 'unknown'
}

interface MockState {
  artikel: Array<Record<string, unknown>>
  standorte: Array<Record<string, unknown>>
  konfigurationen: Array<Record<string, unknown>>
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  deletes: Array<{ table: string; params: unknown[] }>
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
      from: (table: unknown) => {
        const id = tableId(table)
        return {
          where: (clause: unknown) => {
            const params = extractParams(clause).filter((p) => typeof p === 'string')
            if (id === 'artikel') {
              return { limit: () => Promise.resolve(state.artikel.filter((a) => a['id'] === params[0])) }
            }
            if (id === 'standorte') {
              return {
                limit: () => Promise.resolve(state.standorte.filter((s) => s['id'] === params[0])),
              }
            }
            if (id === 'artikel_standort_mindestbestaende') {
              return {
                limit: () =>
                  Promise.resolve(
                    state.konfigurationen.filter(
                      (k) => k['artikelId'] === params[0] && k['standortId'] === params[1],
                    ),
                  ),
              }
            }
            return { limit: () => Promise.resolve([]) }
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
    delete: (table: unknown) => ({
      where: (clause: unknown) => {
        state.deletes.push({ table: tableId(table), params: extractParams(clause) })
        return Promise.resolve()
      },
    }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

function leererState(): MockState {
  return {
    artikel: [{ id: 'a-1' }],
    standorte: [{ id: 's-1' }],
    konfigurationen: [],
    inserts: [],
    updates: [],
    deletes: [],
  }
}

const payload = {
  artikelId: 'a-1',
  standortId: 's-1',
  mindestbestand: 10,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

describe('resolvePush — artikel_standort_mindestbestand', () => {
  it('legt eine neue Konfiguration an (Identitaet = Paar)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'create', entity: 'artikel_standort_mindestbestand', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    // Die Identitaet ist `artikelId#standortId` — kein `id`-Feld.
    expect(result.accepted).toEqual(['a-1#s-1'])
    const ins = state.inserts.filter((r) => r['__table'] === 'artikel_standort_mindestbestaende')
    expect(ins).toHaveLength(1)
    expect(ins[0]).toMatchObject({ artikelId: 'a-1', standortId: 's-1', mindestbestand: 10 })
  })

  it('aktualisiert per Last-Writer-Wins, wenn der Server-Stand aelter ist', async () => {
    const state = leererState()
    state.konfigurationen = [
      {
        artikelId: 'a-1',
        standortId: 's-1',
        mindestbestand: 5,
        geaendertAm: new Date('2026-10-14T10:00:00.000Z'),
        erstelltAm: new Date('2026-10-14T09:00:00.000Z'),
      },
    ]
    await resolvePush(
      makeMockDb(state),
      [{ op: 'update', entity: 'artikel_standort_mindestbestand', payload }],
      'u1',
      'admin',
    )
    // Der Audit-Log wird bei jedem Op mitgeschrieben — der Assert darf
    // sich deshalb nur auf die Konfig-Tabelle beziehen.
    expect(
      state.inserts.filter((r) => r['__table'] === 'artikel_standort_mindestbestaende'),
    ).toHaveLength(0)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ mindestbestand: 10 })
  })

  it('lehnt eine Konfiguration mit unbekanntem Artikel ab (UNKNOWN_REFERENCE)', async () => {
    const state = leererState()
    state.artikel = []
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'create',
          entity: 'artikel_standort_mindestbestand',
          payload: { ...payload, artikelId: 'unbekannt' },
        },
      ],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNKNOWN_REFERENCE')
    expect(state.inserts).toHaveLength(0)
  })

  it('lehnt eine Konfiguration mit unbekanntem Lager ab (UNKNOWN_REFERENCE)', async () => {
    const state = leererState()
    state.standorte = []
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'create',
          entity: 'artikel_standort_mindestbestand',
          payload: { ...payload, standortId: 'unbekannt' },
        },
      ],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('UNKNOWN_REFERENCE')
    expect(state.inserts).toHaveLength(0)
  })

  it('loescht genau das Paar (artikelId, standortId)', async () => {
    const state = leererState()
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'delete', entity: 'artikel_standort_mindestbestand', payload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toEqual(['a-1#s-1'])
    expect(state.deletes).toHaveLength(1)
    expect(state.deletes[0]?.table).toBe('artikel_standort_mindestbestaende')
    expect(state.deletes[0]?.params).toEqual(['a-1', 's-1'])
  })
})

describe('resolvePush — Schutz des Hauptlagers', () => {
  it('lehnt das Loeschen des Standard-Standorts ab (PROTECTED_STANDORT)', async () => {
    const state = leererState()
    state.standorte = [{ id: 's-1', standard: true }]
    const result = await resolvePush(
      makeMockDb(state),
      [{ op: 'delete', entity: 'standort', payload: { id: 's-1', standard: true } }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('PROTECTED_STANDORT')
    expect(state.deletes).toHaveLength(0)
  })

  it('lehnt das Archivieren des Standard-Standorts ab (PROTECTED_STANDORT)', async () => {
    const state = leererState()
    state.standorte = [{ id: 's-1', standard: true }]
    const result = await resolvePush(
      makeMockDb(state),
      [
        {
          op: 'update',
          entity: 'standort',
          payload: {
            id: 's-1',
            name: 'Hauptlager',
            typ: 'lager',
            standard: true,
            archiviert: true,
            geaendertAm: '2026-10-15T10:00:00.000Z',
            erstelltAm: '2026-10-15T09:00:00.000Z',
          },
        },
      ],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('PROTECTED_STANDORT')
    expect(state.updates).toHaveLength(0)
  })
})

describe('pushPayloadSchema — artikel_standort_mindestbestand', () => {
  it('akzeptiert einen gueltigen Push', () => {
    const parsed = pushPayloadSchema.safeParse({
      ops: [{ op: 'create', entity: 'artikel_standort_mindestbestand', payload }],
    })
    expect(parsed.success).toBe(true)
  })

  it('lehnt fehlende IDs ab', () => {
    const parsed = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'create',
          entity: 'artikel_standort_mindestbestand',
          payload: { artikelId: 'a-1', mindestbestand: 5 },
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
