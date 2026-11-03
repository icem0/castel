// Tests fuer die Barcode-Eindeutigkeits-Pruefung im Sync-Resolver.
//
// Der Scanner waehlt einen Artikel ueber seinen Code und nimmt den ersten
// Treffer. Zwei Artikel mit demselben Barcode verschieben Bestand auf den
// falschen Artikel — deshalb muss der Push solchen Ops eine klare Grenze
// setzen (`BARCODE_DUPLIKAT`, Client legt das Outbox-Item still).
//
// Mock-DB: der Barcode-Check projiziert (`select({ id })`), der
// Last-Writer-Wins-Select projiziert nicht. Ueber dieses Merkmal trennt der
// Mock die beiden Abfragen, ohne Drizzle-interne Where-Objekte zu deuten.

import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'

interface Captured {
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
}

interface MockOptionen {
  /** Server-Zeile fuer den Last-Writer-Wins-Select (unprojizierte Abfrage). */
  artikel?: Array<Record<string, unknown>>
  /** Treffer des Barcode-Checks (projizierte Abfrage). */
  barcodeTreffer?: Array<{ id: string }>
  /** Wirft bei insert/update — simulierte DB-Unique-Verletzung. */
  writeFehler?: unknown
}

function makeMockDb(captured: Captured, opts: MockOptionen = {}): never {
  const wirft = (): Promise<never> =>
    opts.writeFehler === undefined
      ? Promise.resolve()
      : Promise.reject(opts.writeFehler)

  const txMock = {
    select: (proj?: unknown) => {
      const barcodeAbfrage = typeof proj === 'object' && proj !== null && 'id' in proj
      const zeilen = barcodeAbfrage ? (opts.barcodeTreffer ?? []) : (opts.artikel ?? [])
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(zeilen),
          }),
        }),
      }
    },
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        captured.inserts.push(value)
        return wirft()
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => {
        captured.updates.push(value)
        return { where: () => wirft() }
      },
    }),
  }
  return {
    transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
  } as never
}

function artikelPayload(barcode: string | null, id = 'a-1'): Record<string, unknown> {
  return {
    id,
    titel: 'Testartikel',
    status: 'verfuegbar',
    typ: 'Demo',
    barcode,
    geaendertAm: '2026-10-15T10:00:00.000Z',
    erstelltAm: '2026-10-15T09:00:00.000Z',
  }
}

describe('resolvePush — Barcode-Eindeutigkeit', () => {
  it('lehnt einen neuen Artikel mit einem fremden Barcode ab', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, { barcodeTreffer: [{ id: 'a-9' }] }),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload('4006381333931') }],
      'u1',
      'admin',
    )

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.code).toBe('BARCODE_DUPLIKAT')
    expect(result.errors[0]?.message).toContain('a-9')
    expect(captured.inserts).toHaveLength(0)
  })

  it('lehnt ein Update ab, das den Barcode eines anderen Artikels uebernimmt', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, {
        artikel: [{ id: 'a-1', barcode: null, geaendertAm: '2026-10-15T09:30:00.000Z' }],
        barcodeTreffer: [{ id: 'a-9' }],
      }),
      [{ op: 'update', entity: 'artikel', payload: artikelPayload('1111111111111') }],
      'u1',
      'admin',
    )

    expect(result.errors[0]?.code).toBe('BARCODE_DUPLIKAT')
    expect(captured.updates).toHaveLength(0)
  })

  it('laesst denselben Artikel seinen eigenen Barcode behalten', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, {
        artikel: [{ id: 'a-1', barcode: '4006381333931', geaendertAm: '2026-10-15T09:30:00.000Z' }],
        // Der Check schliesst die eigene ID per `ne(...)` aus — der Mock liefert
        // bewusst keinen Treffer, weil er das Where nicht deutet.
        barcodeTreffer: [],
      }),
      [{ op: 'update', entity: 'artikel', payload: artikelPayload('4006381333931') }],
      'u1',
      'admin',
    )

    expect(result.errors).toHaveLength(0)
    expect(captured.updates).toHaveLength(1)
  })

  it('macht aus einem leeren Barcode null (kein Index-Konflikt ohne Code)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload('   ') }],
      'u1',
      'admin',
    )

    expect(result.errors).toHaveLength(0)
    expect(captured.inserts[0]?.['barcode']).toBeNull()
  })

  it('uebersetzt eine parallele Unique-Verletzung in BARCODE_DUPLIKAT', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, {
        writeFehler: {
          code: '23505',
          constraint: 'artikel_barcode_uniq_idx',
          message: 'duplicate key value violates unique constraint "artikel_barcode_uniq_idx"',
        },
      }),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload('4006381333931') }],
      'u1',
      'admin',
    )

    expect(result.errors[0]?.code).toBe('BARCODE_DUPLIKAT')
  })

  it('haelt andere Unique-Verletzungen als INTERNAL', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, {
        writeFehler: { code: '23505', constraint: 'artikel_titel_idx', message: 'other index' },
      }),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload('4006381333931') }],
      'u1',
      'admin',
    )

    expect(result.errors[0]?.code).toBe('INTERNAL')
  })
})
