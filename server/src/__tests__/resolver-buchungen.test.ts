// Strategie-Tests für den Resolver.
// Echte DB-Integration würde gegen eine Test-Postgres laufen; in dieser Stufe
// testen wir nur die Error-Klassen und das Zod-Limit.

import { describe, it, expect } from 'vitest'
import {
  NegativerBestandError,
  UnbekannteReferenzError,
  ValidationError,
} from '../domain/errors.js'
import { pushPayloadSchema } from '../domain/validierung.js'
import type { PushOp } from '../sync/resolver.js'

describe('Resolver — Strategie', () => {
  it('NegativerBestandError liefert genug Kontext für Client-UI', () => {
    const e = new NegativerBestandError('a1', 's1', 2, 5)
    expect(e.aktuellerBestand).toBe(2)
    expect(e.angeforderteMenge).toBe(5)
    expect(e.message).toContain('aktuell 2')
  })

  it('UnbekannteReferenzError unterscheidet Entity', () => {
    expect(new UnbekannteReferenzError('artikel', 'a').entity).toBe('artikel')
    expect(new UnbekannteReferenzError('standort', 's').entity).toBe('standort')
  })

  it('ValidationError bei Buchung-op != create', () => {
    const e = new ValidationError('buchung.op', 'nur "create" erlaubt (append-only)')
    expect(e.code).toBe('VALIDATION')
  })

  it('Push-Eingabe akzeptiert maximal 500 ops (zod-Limit)', () => {
    const ops = Array.from({ length: 501 }, (_, i) => ({
      op: 'create' as const,
      entity: 'buchung' as const,
      payload: {
        id: `b${i}`,
        artikelId: 'a1',
        standortId: 's1',
        typ: 'einlagerung' as const,
        menge: 1,
        erstelltAm: '2025-04-14T11:00:00.000Z',
        erstelltVon: 'u1',
        storno: false,
      },
    }))
    const r = pushPayloadSchema.safeParse({ ops })
    expect(r.success).toBe(false)
  })
})

describe('resolvePush — Buchungs-Resolver', () => {
  it('Umlagerung mit fehlender Hälfte wird als Conflict markiert (Retry beim nächsten Sync)', async () => {
    // Nur die Entnahme-Hälfte einer Umlagerung, ohne den Pair-Partner.
    // resolvePush muss dies als Conflict zurückgeben, damit der Client beim
    // nächsten Tick erneut pusht, sobald auch die Einlagerung-Hälfte da ist.
    const { resolvePush } = await import('../sync/resolver.js')
    // Minimaler Mock: nur die Methoden, die resolvePush aufruft.
    const txMock = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: () => ({ values: () => Promise.resolve() }),
    }
    const dbMock = {
      transaction: (fn: (tx: typeof txMock) => Promise<void>) => fn(txMock),
    } as never

    const ops: PushOp[] = [
      {
        op: 'create',
        entity: 'buchung',
        payload: {
          id: 'uml-1',
          artikelId: 'a1',
          standortId: 's1',
          standortZielId: 's2',
          typ: 'umlagerung',
          menge: -5,
          paarId: 'paar-1',
          erstelltAm: '2025-04-14T11:00:00.000Z',
          erstelltVon: 'u1',
          storno: false,
        },
      },
    ]
    const result = await resolvePush(dbMock, ops, 'u1', 'user')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.reason).toContain('paar-1')
    expect(result.accepted).toHaveLength(0)
  })
})

describe('pushPayloadSchema — einstellung', () => {
  it('akzeptiert gültigen upsert auf globalen Key', () => {
    const r = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'artikelTypen',
            userId: null,
            value: '["A","B"]',
            geaendertAm: '2025-04-14T11:00:00.000Z',
          },
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('akzeptiert gültigen upsert auf per-user-Key', () => {
    const r = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'sprache',
            userId: 'user-123',
            value: 'de',
            geaendertAm: '2025-04-14T11:00:00.000Z',
          },
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('lehnt unbekannte Keys ab (Whitelist)', () => {
    const r = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'upsert',
          entity: 'einstellung',
          payload: {
            key: 'fremderKey',
            userId: null,
            value: 'x',
            geaendertAm: '2025-04-14T11:00:00.000Z',
          },
        },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('lehnt andere Ops als upsert ab (Settings sind nur upsert)', () => {
    const r = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'create',
          entity: 'einstellung',
          payload: {
            key: 'sprache',
            userId: 'u1',
            value: 'de',
            geaendertAm: '2025-04-14T11:00:00.000Z',
          },
        },
      ],
    })
    expect(r.success).toBe(false)
  })
})