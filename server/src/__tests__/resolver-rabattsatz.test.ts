import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'
import { mappeHerstellerRabattsatz } from '../sync/preise.js'

interface Captured {
  inserts: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
}

function makeMockDb(captured: Captured, existing: Array<Record<string, unknown>> = []): never {
  const chainableInsert = {
    values: (value: Record<string, unknown>) => {
      captured.inserts.push(value)
      return Promise.resolve()
    },
  }
  const chainableUpdate = {
    set: (value: Record<string, unknown>) => {
      captured.updates.push(value)
      return { where: () => Promise.resolve() }
    },
  }
  const txMock = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(existing),
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

const payload = {
  id: 'h-1',
  name: 'Muster GmbH',
  bestellEmail: null,
  bestellWebseite: null,
  rabattsatz: 20,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

describe('resolvePush — Rabattsatz-Schutz', () => {
  it('schreibt den Rabattsatz als Admin (NUMERIC-String)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'hersteller', payload }],
      'u1',
      'admin',
    )
    const insert = captured.inserts.find((row) => row['id'] === 'h-1')
    expect(insert?.['rabattsatz']).toBe('20.00')
  })

  it('setzt den Rabattsatz fuer Nicht-Admins auf 0 (create)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'hersteller', payload }],
      'u1',
      'user',
    )
    const insert = captured.inserts.find((row) => row['id'] === 'h-1')
    expect(insert?.['rabattsatz']).toBe(0)
  })

  it('entfernt den Rabattsatz fuer Nicht-Admins (update)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        { id: 'h-1', name: 'Alt', rabattsatz: '20.00', geaendertAm: '2026-10-14T10:00:00.000Z' },
      ]),
      [{ op: 'update', entity: 'hersteller', payload }],
      'u1',
      'user',
    )
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]).not.toHaveProperty('rabattsatz')
  })
})

describe('mappeHerstellerRabattsatz', () => {
  it('wandelt den NUMERIC-String in eine Zahl (Admin)', () => {
    const rows = [{ id: 'h-1', name: 'Muster GmbH', rabattsatz: '12.50' }]
    expect(mappeHerstellerRabattsatz(rows, true)).toEqual([
      { id: 'h-1', name: 'Muster GmbH', rabattsatz: 12.5 },
    ])
  })

  it('liefert fuer Nicht-Admins 0 (kein Rabatt bekannt)', () => {
    const rows = [{ id: 'h-1', name: 'Muster GmbH', rabattsatz: '12.50' }]
    expect(mappeHerstellerRabattsatz(rows, false)).toEqual([
      { id: 'h-1', name: 'Muster GmbH', rabattsatz: 0 },
    ])
  })

  it('faellt auf 0 zurueck, wenn der Wert unbrauchbar ist', () => {
    const rows = [{ id: 'h-1', name: 'Muster GmbH', rabattsatz: null }]
    expect(mappeHerstellerRabattsatz(rows, true)[0]?.rabattsatz).toBe(0)
  })
})
