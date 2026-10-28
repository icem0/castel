// Tests for the order options of the Akkutausch tool.
//
// The order options resolve every battery of the order list to its article
// and its supplier and group the lines by supplier — the UI shows one
// option per supplier and lists the articles it covers.

import { describe, expect, it } from 'vitest'
import {
  bestelloptionText,
  ermittleBestelloptionen,
  type ArtikelKontakt,
  type HerstellerKontakt,
} from '../akkutausch/bestelloptionen'
import type { AkkuTyp, Bestellzeile } from '../akkutausch/types'

function typ(id: string, artikelId: string | null, von = 12, bis = 12.9): AkkuTyp {
  return { id, kapazitaetAh: 12.5, von, bis, artikelId }
}

function zeile(typId: string, menge = 4, von = 12, bis = 12.9): Bestellzeile {
  return { typId, kapazitaetAh: 12.5, von, bis, menge }
}

function artikel(
  id: string,
  herstellerId: string | null,
  titel = `Akku ${id}`,
  bestellnummer: string | null = `B-${id}`,
): ArtikelKontakt {
  return { id, titel, bestellnummer, herstellerId }
}

function hersteller(
  id: string,
  name: string,
  bestellEmail: string | null = null,
  bestellWebseite: string | null = null,
): HerstellerKontakt {
  return { id, name, bestellEmail, bestellWebseite }
}

const labels = {
  titel: 'Bestellliste',
  inventurLabel: 'Inventur',
  kopfArtikel: 'Artikel',
  kopfGroesse: 'Größe',
  kopfMenge: 'Menge',
  kopfBestellnummer: 'Bestellnummer',
  gesamtLabel: 'Gesamt',
}

describe('ermittleBestelloptionen', () => {
  it('gruppiert die Bestellzeilen nach Lieferant', () => {
    const ergebnis = ermittleBestelloptionen({
      zeilen: [zeile('t1', 4), zeile('t2', 6)],
      typen: [typ('t1', 'a1'), typ('t2', 'a2')],
      artikel: new Map([
        ['a1', artikel('a1', 'h1', 'Akku 12,5 Ah')],
        ['a2', artikel('a2', 'h2', 'Akku 20 Ah')],
      ]),
      hersteller: new Map([
        ['h1', hersteller('h1', 'Lieferant Nord', 'nord@example.com')],
        ['h2', hersteller('h2', 'Lieferant Süd', 'sued@example.com')],
      ]),
    })

    expect(ergebnis.optionen).toHaveLength(2)
    expect(ergebnis.optionen[0]?.herstellerName).toBe('Lieferant Nord')
    expect(ergebnis.optionen[0]?.zeilen[0]?.artikelTitel).toBe('Akku 12,5 Ah')
    expect(ergebnis.optionen[0]?.gesamtMenge).toBe(4)
    expect(ergebnis.optionen[1]?.herstellerName).toBe('Lieferant Süd')
    expect(ergebnis.optionen[1]?.zeilen[0]?.artikelTitel).toBe('Akku 20 Ah')
    expect(ergebnis.optionen[1]?.gesamtMenge).toBe(6)
    expect(ergebnis.ohneKontakt).toHaveLength(0)
  })

  it('fasst Größen mit demselben Artikel zusammen', () => {
    const ergebnis = ermittleBestelloptionen({
      zeilen: [zeile('t1', 4), zeile('t2', 3, 20, 20.9)],
      typen: [typ('t1', 'a1'), typ('t2', 'a1', 20, 20.9)],
      artikel: new Map([['a1', artikel('a1', 'h1')]]),
      hersteller: new Map([['h1', hersteller('h1', 'Lieferant', 'l@example.com')]]),
    })

    const option = ergebnis.optionen[0]
    expect(option?.zeilen).toHaveLength(1)
    expect(option?.zeilen[0]?.menge).toBe(7)
    expect(option?.zeilen[0]?.von).toBe(12)
    expect(option?.zeilen[0]?.bis).toBe(20.9)
    expect(option?.gesamtMenge).toBe(7)
  })

  it('meldet Zeilen ohne Artikel, Lieferant oder Bestellkontakt', () => {
    const ergebnis = ermittleBestelloptionen({
      zeilen: [zeile('t1'), zeile('t2'), zeile('t3')],
      typen: [typ('t1', null), typ('t2', 'a2'), typ('t3', 'a3')],
      artikel: new Map([
        ['a2', artikel('a2', null)],
        ['a3', artikel('a3', 'h3')],
      ]),
      hersteller: new Map([['h3', hersteller('h3', 'Lieferant ohne Kontakt')]]),
    })

    expect(ergebnis.optionen).toHaveLength(0)
    expect(ergebnis.ohneKontakt.map((z) => z.grund)).toEqual([
      'kein_artikel',
      'kein_hersteller',
      'kein_bestellkontakt',
    ])
  })

  it('akzeptiert einen Lieferanten mit Webseite als Bestellkontakt', () => {
    const ergebnis = ermittleBestelloptionen({
      zeilen: [zeile('t1')],
      typen: [typ('t1', 'a1')],
      artikel: new Map([['a1', artikel('a1', 'h1')]]),
      hersteller: new Map([['h1', hersteller('h1', 'Lieferant', null, 'https://shop.example')]]),
    })

    expect(ergebnis.optionen).toHaveLength(1)
    expect(ergebnis.optionen[0]?.bestellWebseite).toBe('https://shop.example')
  })
})

describe('bestelloptionText', () => {
  it('nennt Artikel, Größe, Menge, Bestellnummer und Summe', () => {
    const ergebnis = ermittleBestelloptionen({
      zeilen: [zeile('t1', 4)],
      typen: [typ('t1', 'a1')],
      artikel: new Map([['a1', artikel('a1', 'h1', 'Akku 12,5 Ah', 'ART-77')]]),
      hersteller: new Map([['h1', hersteller('h1', 'Lieferant', 'l@example.com')]]),
    })

    const text = bestelloptionText(ergebnis.optionen[0]!, {
      ...labels,
      quartal: 4,
      jahr: 2026,
      inventurDatum: '2026-10-27',
      inventurKuerzel: 'MM',
      locale: 'de',
    })

    expect(text).toContain('Bestellliste – Q4 2026')
    expect(text).toContain('Inventur: 27.10.2026 (MM)')
    expect(text).toContain(
      [
        '1. Artikel: Akku 12,5 Ah',
        '   Bestellnummer: ART-77',
        '   Größe: 12–12,9 Ah',
        '   Menge: 4',
      ].join('\n'),
    )
    expect(text).toContain('Gesamt: 4')
  })
})
