import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'

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
  id: 'a-1',
  titel: 'Testartikel',
  status: 'verfuegbar',
  typ: 'Demo',
  einkaufspreis: 9876,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

describe('resolvePush — Einkaufspreis-Schutz', () => {
  it('forces null on create for non-admins', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'artikel', payload }],
      'u1',
      'user',
    )
    const artikelInsert = captured.inserts.find((row) => 'geaendertAm' in row)
    expect(artikelInsert?.['einkaufspreis']).toBeNull()
  })

  it('removes the field on update for non-admins', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        {
          id: 'a-1',
          einkaufspreis: 500,
          geaendertAm: '2026-10-14T10:00:00.000Z',
        },
      ]),
      [{ op: 'update', entity: 'artikel', payload }],
      'u1',
      'user',
    )
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]).not.toHaveProperty('einkaufspreis')
  })

  it('keeps the field for admins', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'artikel', payload }],
      'u1',
      'admin',
    )
    const artikelInsert = captured.inserts.find((row) => 'geaendertAm' in row)
    expect(artikelInsert?.['einkaufspreis']).toBe(9876)
  })
})
