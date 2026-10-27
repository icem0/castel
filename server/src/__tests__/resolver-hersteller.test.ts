import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'
import { pushPayloadSchema } from '../domain/validierung.js'

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

const herstellerPayload = {
  id: 'h-1',
  name: 'Musterhersteller',
  bestellEmail: 'bestellung@muster.example',
  bestellWebseite: null,
  geaendertAm: '2026-10-15T10:00:00.000Z',
  erstelltAm: '2026-10-15T09:00:00.000Z',
}

describe('resolvePush — Hersteller', () => {
  it('legt einen neuen Hersteller an', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'hersteller', payload: herstellerPayload }],
      'u1',
      'admin',
    )
    expect(result.errors).toHaveLength(0)
    expect(result.accepted).toContain('h-1')
    const herstellerInserts = captured.inserts.filter((row) => row['id'] === 'h-1')
    expect(herstellerInserts).toHaveLength(1)
    expect(herstellerInserts[0]).toMatchObject({
      id: 'h-1',
      name: 'Musterhersteller',
      bestellEmail: 'bestellung@muster.example',
    })
  })

  it('aktualisiert per Last-Writer-Wins, wenn der Server-Stand aelter ist', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        { id: 'h-1', name: 'Alt', geaendertAm: '2026-10-14T10:00:00.000Z' },
      ]),
      [{ op: 'update', entity: 'hersteller', payload: herstellerPayload }],
      'u1',
      'admin',
    )
    expect(captured.inserts.filter((row) => row['id'] === 'h-1')).toHaveLength(0)
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]).toMatchObject({ name: 'Musterhersteller' })
  })

  it('legt bei einem Artikel mit unbekanntem Hersteller einen Platzhalter an', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const artikelPayload = {
      id: 'a-1',
      titel: 'Testartikel',
      status: 'verfuegbar',
      typ: 'Demo',
      verpackungseinheit: 1,
      herstellerId: 'h-neu',
      bestellstatus: 'offen',
      geaendertAm: '2026-10-15T10:00:00.000Z',
      erstelltAm: '2026-10-15T09:00:00.000Z',
    }
    await resolvePush(
      makeMockDb(captured),
      [{ op: 'create', entity: 'artikel', payload: artikelPayload }],
      'u1',
      'admin',
    )
    const platzhalter = captured.inserts.find((row) => row['id'] === 'h-neu')
    expect(platzhalter).toBeDefined()
    expect(platzhalter?.['name']).toBe('')
    expect((platzhalter?.['geaendertAm'] as Date).getTime()).toBe(0)
    expect(captured.inserts.some((row) => row['id'] === 'a-1')).toBe(true)
  })
})

describe('pushPayloadSchema — hersteller', () => {
  it('akzeptiert einen gueltigen Hersteller-Push', () => {
    const parsed = pushPayloadSchema.safeParse({
      ops: [{ op: 'create', entity: 'hersteller', payload: herstellerPayload }],
    })
    expect(parsed.success).toBe(true)
  })

  it('lehnt einen leeren Herstellernamen ab', () => {
    const parsed = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'create',
          entity: 'hersteller',
          payload: { ...herstellerPayload, name: '' },
        },
      ],
    })
    expect(parsed.success).toBe(false)
  })
})
