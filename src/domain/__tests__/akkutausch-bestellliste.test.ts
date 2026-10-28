// Tests for the plain-text order list (clipboard/e-mail).

import { describe, expect, it } from 'vitest'
import { bestelllisteText } from '../akkutausch/bestellliste'
import type { Bestellzeile } from '../akkutausch/types'

const labels = {
  titel: 'Bestellliste',
  inventurLabel: 'Inventur',
  kopfGroesse: 'Größe',
  kopfNennkapazitaet: 'Nennkapazität',
  kopfMenge: 'Menge',
  gesamtLabel: 'Gesamt',
}

function zeile(overrides: Partial<Bestellzeile> = {}): Bestellzeile {
  return {
    typId: 't-1',
    kapazitaetAh: 12.5,
    von: 12,
    bis: 12.9,
    menge: 4,
    ...overrides,
  }
}

describe('bestelllisteText', () => {
  it('rendert Kopf, Zeilen, Summe und Inventur-Stichtag', () => {
    const text = bestelllisteText(
      [zeile(), zeile({ typId: 't-2', kapazitaetAh: 2.3, von: 2, bis: 2.9, menge: 6 })],
      'de',
      {
        ...labels,
        quartal: 4,
        jahr: 2026,
        inventurDatum: '2026-10-27',
        inventurKuerzel: 'MM',
      },
    )
    const zeilen = text.split('\n')

    expect(zeilen[0]).toBe('Bestellliste – Q4 2026')
    expect(zeilen[1]).toBe('Inventur: 27.10.2026 (MM)')
    expect(text).toContain('Größe')
    expect(text).toContain('12–12,9 Ah')
    expect(text).toContain('12,5 Ah')
    expect(text).toContain('Gesamt: 10')
  })

  it('trennt die Spalten breit und richtet die Menge rechts aus', () => {
    const text = bestelllisteText([zeile(), zeile({ typId: 't-2', menge: 60 })], 'de', {
      ...labels,
      quartal: 4,
      jahr: 2026,
      inventurDatum: '2026-10-27',
      inventurKuerzel: 'MM',
    })
    const zeilen = text.split('\n')
    const kopf = zeilen[3]!
    const trenn = zeilen[4]!

    expect(kopf).toContain('Größe')
    expect(kopf).toMatch(/ {4}/)
    expect(trenn).toBe('-'.repeat(kopf.length))
    // Menge rechts ausgerichtet: die Werte enden in derselben Spalte.
    expect(zeilen[5]?.endsWith('4')).toBe(true)
    expect(zeilen[6]?.endsWith('60')).toBe(true)
    // Beide Zeilen enden an derselben (rechten) Kante.
    expect(zeilen[6]?.length).toBe(zeilen[5]?.length)
    // Summe am rechten Rand der Tabelle.
    const letzte = zeilen[zeilen.length - 1]
    expect(letzte?.endsWith('Gesamt: 64')).toBe(true)
    expect(letzte?.length).toBe(kopf.length)
  })

  it('kennzeichnet ein fehlendes Inventurdatum', () => {
    const text = bestelllisteText([zeile()], 'de', {
      ...labels,
      quartal: 1,
      jahr: 2027,
      inventurDatum: null,
      inventurKuerzel: null,
    })
    expect(text).toContain('Inventur: —')
  })
})
