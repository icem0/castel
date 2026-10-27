// Tests für die Kommissionen-Einstellung (`einstellungen.kommissionen`).
//
// Kern der Prüfung: Nicht-Admins dürfen die globale Liste nur ERGÄNZEN. Der
// Server merged ihren Beitrag mit dem gespeicherten Stand (Union), damit ein
// veralteter Client die Liste nie leeren kann. Admins behalten Replace/LWW.

import { describe, expect, it } from 'vitest'
import { resolvePush } from '../sync/resolver.js'
import {
  MAX_KOMMISSIONEN,
  MAX_KOMMISSION_LAENGE,
  mergeKommissionen,
  parseGespeicherteKommissionen,
  parseKommissionenWert,
} from '../domain/kommissionen.js'

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

function kommissionenPayload(value: string, geaendertAm = '2026-10-15T10:00:00.000Z') {
  return {
    op: 'update' as const,
    entity: 'einstellung' as const,
    payload: { key: 'kommissionen' as const, userId: null, value, geaendertAm },
  }
}

describe('parseKommissionenWert', () => {
  it('liest eine Liste von Namen', () => {
    const ergebnis = parseKommissionenWert('["Projekt Müller","Projekt Schmidt"]')
    expect(ergebnis.fehler).toHaveLength(0)
    expect(ergebnis.kommissionen).toEqual(['Projekt Müller', 'Projekt Schmidt'])
  })

  it('entfernt leere Namen und Duplikate', () => {
    const ergebnis = parseKommissionenWert('["A","  ","A","B"]')
    expect(ergebnis.fehler).toHaveLength(0)
    expect(ergebnis.kommissionen).toEqual(['A', 'B'])
  })

  it('lehnt kaputtes JSON ab', () => {
    expect(parseKommissionenWert('{kein json').fehler.length).toBeGreaterThan(0)
  })

  it('lehnt ein No-Array ab', () => {
    expect(parseKommissionenWert('{"a":1}').fehler.length).toBeGreaterThan(0)
  })

  it('lehnt zu lange Namen ab', () => {
    const zuLang = 'x'.repeat(MAX_KOMMISSION_LAENGE + 1)
    expect(parseKommissionenWert(JSON.stringify([zuLang])).fehler.length).toBeGreaterThan(0)
  })

  it('lehnt zu viele Einträge ab', () => {
    const viele = Array.from({ length: MAX_KOMMISSIONEN + 1 }, (_, i) => `K${i}`)
    expect(parseKommissionenWert(JSON.stringify(viele)).fehler.length).toBeGreaterThan(0)
  })
})

describe('parseGespeicherteKommissionen', () => {
  it('liefert bei kaputtem Altbestand eine leere Liste', () => {
    expect(parseGespeicherteKommissionen('kaputt')).toEqual([])
    expect(parseGespeicherteKommissionen(null)).toEqual([])
  })
})

describe('mergeKommissionen', () => {
  it('vereinigt beide Listen und behält die Reihenfolge des Bestands', () => {
    expect(mergeKommissionen(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C'])
  })

  it('ignoriert den eingehenden Wert, wenn er leer ist', () => {
    expect(mergeKommissionen(['A'], [])).toEqual(['A'])
  })
})

describe('resolvePush — Einstellung kommissionen', () => {
  it('legt die Liste an, wenn sie noch nicht existiert', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured),
      [kommissionenPayload('["Projekt Müller"]')],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    const inserts = captured.inserts.filter((row) => row['key'] === 'kommissionen')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      key: 'kommissionen',
      userId: null,
      value: '["Projekt Müller"]',
    })
  })

  it('merged für Nicht-Admins (Union) und speichert einen neueren Zeitstempel', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured, [
        {
          key: 'kommissionen',
          userId: null,
          value: '["Projekt Müller"]',
          geaendertAm: '2026-10-15T09:00:00.000Z',
        },
      ]),
      [kommissionenPayload('["Projekt Müller","Projekt Schmidt"]')],
      'u1',
      'user',
    )
    expect(result.errors).toHaveLength(0)
    expect(captured.inserts.filter((row) => row['key'] === 'kommissionen')).toHaveLength(0)
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]?.['value']).toBe('["Projekt Müller","Projekt Schmidt"]')
    const gestempelt = captured.updates[0]?.['geaendertAm'] as Date
    expect(gestempelt.getTime()).toBeGreaterThan(new Date('2026-10-15T10:00:00.000Z').getTime())
  })

  it('merged auch, wenn der eingehende Stand älter ist (veralteter Client)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        {
          key: 'kommissionen',
          userId: null,
          value: '["Projekt Müller"]',
          geaendertAm: '2026-10-15T12:00:00.000Z',
        },
      ]),
      [kommissionenPayload('["Projekt Müller","Projekt Schmidt"]', '2026-10-15T08:00:00.000Z')],
      'u1',
      'user',
    )
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]?.['value']).toBe('["Projekt Müller","Projekt Schmidt"]')
    const gestempelt = captured.updates[0]?.['geaendertAm'] as Date
    expect(gestempelt.getTime()).toBeGreaterThan(new Date('2026-10-15T12:00:00.000Z').getTime())
  })

  it('lässt die Liste unverändert, wenn nichts hinzukommt', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        {
          key: 'kommissionen',
          userId: null,
          value: '["Projekt Müller"]',
          geaendertAm: '2026-10-15T09:00:00.000Z',
        },
      ]),
      [kommissionenPayload('["Projekt Müller"]')],
      'u1',
      'user',
    )
    expect(captured.updates).toHaveLength(0)
  })

  it('Nicht-Admins dürfen Einträge nicht entfernen', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        {
          key: 'kommissionen',
          userId: null,
          value: '["Projekt Müller","Projekt Schmidt"]',
          geaendertAm: '2026-10-15T09:00:00.000Z',
        },
      ]),
      [kommissionenPayload('["Projekt Schmidt"]')],
      'u1',
      'user',
    )
    // Der Merge ergibt dieselbe Liste → kein Schreibvorgang, nichts geht verloren.
    expect(captured.updates).toHaveLength(0)
  })

  it('Admins ersetzen die Liste (Replace/LWW)', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    await resolvePush(
      makeMockDb(captured, [
        {
          key: 'kommissionen',
          userId: null,
          value: '["Projekt Müller","Projekt Schmidt"]',
          geaendertAm: '2026-10-15T09:00:00.000Z',
        },
      ]),
      [kommissionenPayload('["Projekt Schmidt"]')],
      'u1',
      'admin',
    )
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0]?.['value']).toBe('["Projekt Schmidt"]')
  })

  it('lehnt einen kaputten Wert ab', async () => {
    const captured: Captured = { inserts: [], updates: [] }
    const result = await resolvePush(
      makeMockDb(captured),
      [kommissionenPayload('kein json')],
      'u1',
      'admin',
    )
    expect(result.errors.length).toBeGreaterThan(0)
    expect(captured.inserts.filter((row) => row['key'] === 'kommissionen')).toHaveLength(0)
    expect(captured.updates).toHaveLength(0)
  })
})
