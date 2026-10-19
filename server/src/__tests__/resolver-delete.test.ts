// Tests für die Delete-Pfade im Resolver.
//
// Wir testen den Großteil der Logik über die exportierte Pure-Funktion
// `assertKeineAbhaengigkeiten` (siehe server/src/sync/resolver.ts) —
// sie entscheidet, ob ein DELETE freigegeben wird oder ob die
// referenzierenden Counts als `HatAbhaengigkeitenError` fliegen.
//
// Den Resolver-Aufruf (`resolvePush`) selbst testen wir mit einem
// extrem minimalen Mock-DB, der `count`-Projektionen am Tabellen-Symbol
// erkennt und DELETE-Aufrufe aufzeichnet. Die Mock-DB liefert
// bewusst KEIN `where` als komplexes Objekt zurück — Drizzle-interne
// Strukturen lassen sich nicht stabil mocken. Stattdessen geben wir
// einen Sentinel-Wert zurück, der von `resolvePush` als "leeres
// Result" interpretiert wird.

import { describe, it, expect } from 'vitest'
import { HatAbhaengigkeitenError } from '../domain/errors.js'
import {
  assertKeineAbhaengigkeiten,
  type AbhaengigkeitCount,
} from '../sync/resolver.js'

describe('assertKeineAbhaengigkeiten — pure', () => {
  it('wirft nicht, wenn keine Abhängigkeiten existieren', () => {
    const counts: AbhaengigkeitCount[] = [
      { entity: 'buchungen', anzahl: 0 },
      { entity: 'mindestbestand_ereignisse', anzahl: 0 },
    ]
    expect(() => assertKeineAbhaengigkeiten('artikel', 'a1', counts)).not.toThrow()
  })

  it('wirft nicht bei leerer Liste', () => {
    expect(() => assertKeineAbhaengigkeiten('artikel', 'a1', [])).not.toThrow()
  })

  it('wirft HatAbhaengigkeitenError bei einer positiven Abhängigkeit', () => {
    const counts: AbhaengigkeitCount[] = [
      { entity: 'buchungen', anzahl: 3 },
      { entity: 'mindestbestand_ereignisse', anzahl: 0 },
    ]
    expect(() => assertKeineAbhaengigkeiten('artikel', 'a1', counts)).toThrow(
      HatAbhaengigkeitenError,
    )
  })

  it('sammelt MEHRERE positive Abhängigkeiten in der Fehlermeldung', () => {
    const counts: AbhaengigkeitCount[] = [
      { entity: 'buchungen', anzahl: 2 },
      { entity: 'mindestbestand_ereignisse', anzahl: 1 },
    ]
    let caught: unknown
    try {
      assertKeineAbhaengigkeiten('artikel', 'a1', counts)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HatAbhaengigkeitenError)
    const err = caught as HatAbhaengigkeitenError
    expect(err.code).toBe('HAS_DEPENDENCIES')
    expect(err.resource).toBe('artikel')
    expect(err.id).toBe('a1')
    expect(err.abhaengigkeiten).toEqual([
      { entity: 'buchungen', anzahl: 2 },
      { entity: 'mindestbestand_ereignisse', anzahl: 1 },
    ])
  })

  it('ignoriert Eintraege mit anzahl <= 0', () => {
    const counts: AbhaengigkeitCount[] = [
      { entity: 'buchungen', anzahl: 0 },
      { entity: 'mindestbestand_ereignisse', anzahl: -1 },
    ]
    expect(() => assertKeineAbhaengigkeiten('artikel', 'a1', counts)).not.toThrow()
  })
})

describe('HatAbhaengigkeitenError', () => {
  it('Message enthaelt Resource, ID und Counts', () => {
    const e = new HatAbhaengigkeitenError('artikel', 'a1', [
      { entity: 'buchungen', anzahl: 3 },
    ])
    expect(e.code).toBe('HAS_DEPENDENCIES')
    expect(e.message).toMatch(/artikel/)
    expect(e.message).toMatch(/a1/)
    expect(e.message).toMatch(/3 buchungen/)
  })
})

// ---------- Integration: resolvePush + Mock-DB ----------
//
// Wir mocken den DB-Layer so, dass:
//   - count-Selects einen vorbereiteten Wert zurückgeben
//   - alle anderen Selects leer zurückgeben
//   - delete(table).where(...) einen Eintrag in `state.deletes` macht
//
// Drizzle-interne Objekte können wir nicht stabil mocken — daher geben
// wir auf der `where`-Ebene einen leeren Mock-Result zurück. Die
// Delete-Identität fischen wir aus dem übergebenen `op.payload.id`
// (das ist die einzige Information, die der Resolver wirklich braucht).
// Wir verifizieren, dass `resolvePush` entweder HAS_DEPENDENCIES
// zurückgibt (kein Delete) oder den Datensatz als `accepted` markiert.

const DRIZZLE_NAME = Symbol.for('drizzle:Name')

function tableId(table: unknown): string | undefined {
  if (!table || typeof table !== 'object') return undefined
  const v = (table as Record<symbol, unknown>)[DRIZZLE_NAME]
  return typeof v === 'string' ? v : undefined
}

function isAggregateProjection(projection: unknown): boolean {
  if (!projection || typeof projection !== 'object') return false
  return Object.values(projection as Record<string, unknown>).some((v) => {
    if (v && typeof v === 'object') {
      return Object.getPrototypeOf(v)?.constructor?.name === 'SQL'
    }
    return false
  })
}

interface MockState {
  buchungenProArtikel: number
  mindestEreignisseProArtikel: number
  buchungenProStandortQuelle: number
  buchungenProStandortZiel: number
  deletes: string[]
}

function makeMockDb(state: MockState): unknown {
  // Wir zählen aggregate count-Aufrufe pro Tabelle, um mehrere
  // aufeinanderfolgende SELECTs auf `buchungen` (z. B. standort_id
  // UND standort_ziel_id) auseinanderzuhalten.
  const aggregateCount = new Map<string, number>()
  const txMock = {
    select: (projection: unknown) => ({
      from: (table: unknown) => {
        const id = tableId(table) ?? 'unknown'
        return {
          where: () => {
              if (isAggregateProjection(projection)) {
                const n = (aggregateCount.get(id) ?? 0) + 1
                aggregateCount.set(id, n)
                let wert = 0
                if (id === 'buchungen') {
                  if (n === 1) wert = state.buchungenProArtikel
                  else if (n === 2) wert = state.buchungenProStandortQuelle
                  else wert = state.buchungenProStandortZiel
                } else if (id === 'mindestbestand_ereignisse') {
                  wert = state.mindestEreignisseProArtikel
                }
                // Drizzle's `count()` braucht kein `.limit()` — die
                // Promise wird direkt aus dem `where()`-Aufruf
                // konsumiert. Wir liefern daher das Array SOFORT.
                return Promise.resolve([{ c: wert }])
              }
              // Nicht-aggregate Selects: Idempotenz-/Existenz-Checks.
              // Im Delete-Pfad feuern die nicht; wenn doch, geben wir
              // ein leeres Result zurück.
              return { limit: () => Promise.resolve([]) }
          },
        }
      },
    }),
    insert: () => ({
      values: () => Promise.resolve(),
    }),
    delete: (table: unknown) => {
      const id = tableId(table) ?? 'unknown'
      return {
        where: () => {
          // Wir nehmen an, dass `op.payload.id` die zu löschende ID ist.
          // Diese Annahme ist OK, weil resolvePush synchron pro Op
          // ausgeführt wird und die `op` an `tx.delete` durchreicht.
          state.deletes.push(id)
          return Promise.resolve()
        },
      }
    },
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  }
}

describe('Resolver — Delete-Operationen (Integration mit Mock-DB)', () => {
  it('artikel ohne Abhängigkeiten wird per DELETE entfernt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 0,
      mindestEreignisseProArtikel: 0,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'artikel' as const,
        payload: {
          id: 'a1',
          titel: 't',
          status: 'verfuegbar' as const,
          typ: '',
          verpackungseinheit: 1,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.accepted).toContain('a1')
    expect(result.errors).toHaveLength(0)
    expect(state.deletes).toContain('artikel')
  })

  it('artikel MIT abhängigen Buchungen wird abgelehnt (HAS_DEPENDENCIES, kein DELETE)', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 3,
      mindestEreignisseProArtikel: 0,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'artikel' as const,
        payload: {
          id: 'a1',
          titel: 't',
          status: 'verfuegbar' as const,
          typ: '',
          verpackungseinheit: 1,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.accepted).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('HAS_DEPENDENCIES')
    expect(result.errors[0]?.id).toBe('a1')
    expect(result.errors[0]?.message).toMatch(/3.*buchungen/i)
    expect(state.deletes).not.toContain('artikel')
  })

  it('artikel MIT abhängigen Mindestbestand-Ereignissen wird abgelehnt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 0,
      mindestEreignisseProArtikel: 1,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'artikel' as const,
        payload: {
          id: 'a1',
          titel: 't',
          status: 'verfuegbar' as const,
          typ: '',
          verpackungseinheit: 1,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('HAS_DEPENDENCIES')
    expect(result.errors[0]?.message).toMatch(/mindestbestand/i)
  })

  it('artikel mit kombinierten Abhängigkeiten listet beide in der Message', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 2,
      mindestEreignisseProArtikel: 3,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'artikel' as const,
        payload: {
          id: 'a1',
          titel: 't',
          status: 'verfuegbar' as const,
          typ: '',
          verpackungseinheit: 1,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.errors[0]?.message).toMatch(/2.*buchungen/i)
    expect(result.errors[0]?.message).toMatch(/3.*mindestbestand/i)
  })

  it('standort mit Quell- und Ziel-Buchungen wird abgelehnt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      // Der Mock liefert für `buchungen`-Aggregate in Reihenfolge:
      // 1. call → buchungenProArtikel (Q für standort_id)
      // 2. call → buchungenProStandortQuelle (Z für standort_ziel_id)
      // Summe ist 2 + 1 = 3.
      buchungenProArtikel: 2,
      mindestEreignisseProArtikel: 0,
      buchungenProStandortQuelle: 1,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'standort' as const,
        payload: {
          id: 's1',
          name: 'Lager',
          typ: 'lager' as const,
          standard: false,
          archiviert: false,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('HAS_DEPENDENCIES')
    expect(result.errors[0]?.message).toMatch(/3.*buchungen/i)
    expect(state.deletes).not.toContain('standorte')
  })

  it('standort ohne Buchungen wird per DELETE entfernt', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 0,
      mindestEreignisseProArtikel: 0,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'standort' as const,
        payload: {
          id: 's1',
          name: 'Lager',
          typ: 'lager' as const,
          standard: false,
          archiviert: false,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.accepted).toContain('s1')
    expect(result.errors).toHaveLength(0)
    expect(state.deletes).toContain('standorte')
  })

  it('kommission (projekt) wird ohne FK-Pruefung immer geloescht', async () => {
    const { resolvePush } = await import('../sync/resolver.js')
    const state: MockState = {
      buchungenProArtikel: 0,
      mindestEreignisseProArtikel: 0,
      buchungenProStandortQuelle: 0,
      buchungenProStandortZiel: 0,
      deletes: [],
    }
    const dbMock = makeMockDb(state)

    const ops = [
      {
        op: 'delete' as const,
        entity: 'kommission' as const,
        payload: {
          id: 'p1',
          nummer: 'PRJ-001',
          archiviert: false,
          geaendertAm: '2026-10-15T10:00:00.000Z',
          erstelltAm: '2026-10-15T09:00:00.000Z',
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'admin')
    expect(result.accepted).toContain('p1')
    expect(result.errors).toHaveLength(0)
    // commission = Tabellenname in der DB (Migration 0009).
    expect(state.deletes).toContain('commission')
  })
})
