// Tests für die Pure-Bestand-Funktionen und die neuen zod-Validatoren
// auf dem Server.

import { describe, expect, it } from 'vitest'
import {
  berechneBestandPure,
  berechneBestandProStandortPure,
  summeAktiveBuchungenPure,
  type BestandBuchung,
} from '../domain/bestand.js'
import { buchungSchema, pushPayloadSchema } from '../domain/validierung.js'

function b(artikel: string, standort: string, menge: number, storno = false): BestandBuchung {
  return { standortId: standort, menge, storno }
}

describe('berechneBestandPure (Server)', () => {
  it('leere Liste → 0', () => {
    expect(berechneBestandPure([], 's1')).toBe(0)
  })

  it('summiert nur nicht-stornierte Buchungen an dem Standort', () => {
    const buchungen: BestandBuchung[] = [
      b('a', 's1', 10),
      b('a', 's1', -3),
      b('a', 's2', 7),
      b('a', 's1', 5, /* storno */ true), // wird ignoriert
    ]
    expect(berechneBestandPure(buchungen, 's1')).toBe(7)
    expect(berechneBestandPure(buchungen, 's2')).toBe(7)
    expect(berechneBestandPure(buchungen, 's3')).toBe(0)
  })

  it('Umlagerungs-Teilbuchungen: jede trägt standortId auf der betroffenen Seite', () => {
    // Modellierung: entnahme (s1, -30), einlagerung (s2, +30)
    const buchungen: BestandBuchung[] = [
      b('a', 's1', 100),
      b('a', 's1', -30, /* storno */ false), // entnahme
      b('a', 's2', 30, /* storno */ false), // einlagerung
    ]
    expect(berechneBestandPure(buchungen, 's1')).toBe(70)
    expect(berechneBestandPure(buchungen, 's2')).toBe(30)
  })
})

describe('berechneBestandProStandortPure (Server)', () => {
  it('gruppiert nach Standort', () => {
    const buchungen: BestandBuchung[] = [
      b('a', 's1', 10),
      b('a', 's2', 20),
      b('a', 's1', -4),
      b('a', 's3', 7, /* storno */ true),
    ]
    const map = berechneBestandProStandortPure(buchungen)
    expect(map.get('s1')).toBe(6)
    expect(map.get('s2')).toBe(20)
    expect(map.get('s3')).toBeUndefined()
  })
})

describe('summeAktiveBuchungenPure (Server)', () => {
  it('summiert nur nicht-stornierte Buchungen über alle Standorte', () => {
    const buchungen: BestandBuchung[] = [
      b('a', 's1', 10),
      b('a', 's2', 20),
      b('a', 's1', 5, /* storno */ true),
    ]
    expect(summeAktiveBuchungenPure(buchungen)).toBe(30)
  })
})

describe('Zukunfts-Daten-Validator', () => {
  function parseBuchung(erstelltAm: string) {
    return buchungSchema.safeParse({
      id: 'b1',
      artikelId: 'a1',
      standortId: 's1',
      typ: 'einlagerung',
      menge: 5,
      erstelltAm,
      erstelltVon: 'u1',
      storno: false,
    })
  }

  it('lehnt Zukunfts-Daten > 1 min in der Zukunft ab', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    const r = parseBuchung(future)
    expect(r.success).toBe(false)
  })

  it('akzeptiert Daten in der Vergangenheit', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const r = parseBuchung(past)
    expect(r.success).toBe(true)
  })

  it('akzeptiert Daten innerhalb der Clock-Drift-Toleranz (jetzt + 30s)', () => {
    const almost = new Date(Date.now() + 30_000).toISOString()
    const r = parseBuchung(almost)
    expect(r.success).toBe(true)
  })

  it('lehnt Nicht-ISO-Strings ab', () => {
    const r = parseBuchung('kein-datum')
    expect(r.success).toBe(false)
  })

  it('lehnt Zukunfts-Push im pushPayloadSchema ebenfalls ab', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    const r = pushPayloadSchema.safeParse({
      ops: [
        {
          op: 'create',
          entity: 'buchung',
          payload: {
            id: 'b1',
            artikelId: 'a1',
            standortId: 's1',
            typ: 'einlagerung',
            menge: 1,
            erstelltAm: future,
            erstelltVon: 'u1',
            storno: false,
          },
        },
      ],
    })
    expect(r.success).toBe(false)
  })
})
