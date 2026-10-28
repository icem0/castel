// Tests for the inventory cut-off rule of the Akkutausch tool.

import { describe, expect, it } from 'vitest'
import { ermittleInventurStatus } from '../akkutausch/inventur'
import type { InventurBuchung } from '../akkutausch/types'

const JETZT = new Date('2026-10-28T12:00:00.000Z')

function inventur(
  erstelltAm: string,
  erstelltVon = 'Max Mustermann',
  overrides: Partial<InventurBuchung> = {},
): InventurBuchung {
  return {
    artikelId: 'a-1',
    typ: 'inventur',
    storno: false,
    erstelltAm,
    erstelltVon,
    ...overrides,
  }
}

describe('ermittleInventurStatus', () => {
  it('meldet fehlend, wenn keine Inventurbuchung existiert', () => {
    expect(ermittleInventurStatus([], ['a-1'], JETZT)).toEqual({
      gueltig: false,
      datum: null,
      kuerzel: null,
      anzahlBuchungen: 0,
    })
  })

  it('ignoriert Buchungen ausserhalb der letzten vier Wochen', () => {
    const status = ermittleInventurStatus([inventur('2026-09-29T09:00:00.000Z')], ['a-1'], JETZT)
    expect(status.gueltig).toBe(false)
  })

  it('nimmt das aelteste Datum innerhalb des Fensters', () => {
    const status = ermittleInventurStatus(
      [
        inventur('2026-10-20T09:00:00.000Z', 'Max Mustermann'),
        inventur('2026-10-01T09:00:00.000Z', 'Erika Musterfrau'),
        inventur('2026-10-10T09:00:00.000Z', 'Max Mustermann'),
      ],
      ['a-1'],
      JETZT,
    )
    expect(status).toEqual({
      gueltig: true,
      datum: '2026-10-01',
      kuerzel: 'EM',
      anzahlBuchungen: 3,
    })
  })

  it('nennt alle Kuerzel des Stichtags (auch mehrere Personen)', () => {
    const status = ermittleInventurStatus(
      [
        inventur('2026-10-01T08:00:00.000Z', 'Max Mustermann'),
        inventur('2026-10-01T10:00:00.000Z', 'Erika Musterfrau'),
        inventur('2026-10-20T09:00:00.000Z', 'Anderer Tag'),
      ],
      ['a-1'],
      JETZT,
    )
    expect(status.kuerzel).toBe('EM, MM')
    expect(status.datum).toBe('2026-10-01')
  })

  it('ignoriert stornierte Inventuren, andere Artikel und andere Buchungsarten', () => {
    const status = ermittleInventurStatus(
      [
        inventur('2026-10-01T09:00:00.000Z', 'Max Mustermann', { storno: true }),
        inventur('2026-10-02T09:00:00.000Z', 'Max Mustermann', { artikelId: 'a-2' }),
        inventur('2026-10-03T09:00:00.000Z', 'Max Mustermann', { typ: 'entnahme' }),
        inventur('2026-10-27T09:00:00.000Z', 'Erika Musterfrau'),
      ],
      ['a-1'],
      JETZT,
    )
    expect(status).toEqual({
      gueltig: true,
      datum: '2026-10-27',
      kuerzel: 'EM',
      anzahlBuchungen: 1,
    })
  })

  it('akzeptiert den Grenztag vor genau vier Wochen', () => {
    const status = ermittleInventurStatus([inventur('2026-09-30T23:00:00.000Z')], ['a-1'], JETZT)
    expect(status.gueltig).toBe(true)
    expect(status.datum).toBe('2026-09-30')
  })
})
