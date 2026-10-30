// Tests für die per-User-Einstellung `standardStandortId`.
//
// Die Einstellung ist Admin-only: Nicht-Admins dürfen den Key nicht schreiben
// — weder für ihre eigene User-ID noch global. Admins schreiben wie bisher
// per LWW auf geaendertAm.

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

function standortPayload(userId: string | null, value = 'standort-1') {
  return {
    op: 'upsert' as const,
    entity: 'einstellung' as const,
    payload: {
      key: 'standardStandortId' as const,
      userId,
      value,
      geaendertAm: '2026-10-15T10:00:00.000Z',
    },
  }
}

describe('resolvePush — Einstellung standardStandortId (Admin-only)', () => {
  it('lehnt Nicht-Admins mit eigener User-ID ab', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(makeMockDb(captured), [standortPayload('u1')], 'u1', 'user')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]?.code).toBe('VALIDATION')
    expect(captured.inserts).toHaveLength(0)
    expect(captured.updates).toHaveLength(0)
  })

  it('lehnt Nicht-Admins auch mit globalem userId=null ab', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(makeMockDb(captured), [standortPayload(null)], 'u1', 'user')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(captured.inserts).toHaveLength(0)
    expect(captured.updates).toHaveLength(0)
  })

  it('Admins dürfen die per-User-Einstellung schreiben', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(makeMockDb(captured), [standortPayload('u9')], 'u9', 'admin')
    expect(result.errors).toHaveLength(0)
    expect(captured.inserts[0]).toMatchObject({
      key: 'standardStandortId',
      userId: 'u9',
      value: 'standort-1',
    })
  })

  it('Nicht-Admins dürfen andere per-User-Keys (sprache) weiterhin schreiben', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured),
      [
        {
          op: 'upsert' as const,
          entity: 'einstellung' as const,
          payload: {
            key: 'sprache' as const,
            userId: 'u1',
            value: 'de',
            geaendertAm: '2026-10-15T10:00:00.000Z',
          },
        },
      ],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(captured.inserts[0]).toMatchObject({ key: 'sprache', userId: 'u1' })
  })
})
