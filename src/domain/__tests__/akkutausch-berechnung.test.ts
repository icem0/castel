import { describe, expect, it } from 'vitest'
import {
  berechnePlanung,
  faelligkeit,
  istIsoDatum,
  neuerMindestbestand,
  parseDatum,
  parseKapazitaet,
  pruefeTypen,
  quartalVonDatum,
  typFuerKapazitaet,
} from '../akkutausch/berechnung'
import { parseAkkuTypen, serialisiereAkkuTypen } from '../akkutausch/serialisierung'
import { DEFAULT_AKKU_GROESSEN } from '../akkutausch/defaults'
import {
  artikelTitel,
  csvDatei,
  formatDatum,
  formatKapazitaet,
  formatKapazitaetBereich,
  formatZahl,
} from '../akkutausch/formatierung'
import type { AkkuTyp, Netzteil, Projektakku } from '../akkutausch/types'

function typ(overrides: Partial<AkkuTyp> & { id: string }): AkkuTyp {
  return {
    kapazitaetAh: 1.2,
    von: 1.0,
    bis: 1.9,
    artikelId: null,
    ...overrides,
  }
}

function netzteil(overrides: Partial<Netzteil> & { id: string }): Netzteil {
  return {
    anlage: 'Anlage 1',
    objekt: 'Objekt 1',
    name: 'Notlichtaggregat',
    einbaudatum: '2020-01-15',
    intervallJahre: 5,
    kapazitaetAh: 1.2,
    anzahl: 2,
    gruppe: null,
    plz: null,
    vdsAnerkennung: null,
    bemerkung: null,
    geloescht: false,
    erstelltAm: '2024-01-01T00:00:00.000Z',
    geaendertAm: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function projektakku(overrides: Partial<Projektakku> & { id: string }): Projektakku {
  return {
    projekt: 'Bauvorhaben',
    menge: 4,
    artAh: 1.2,
    quartal: 1,
    jahr: 2025,
    geloescht: false,
    erstelltAm: '2024-01-01T00:00:00.000Z',
    geaendertAm: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('parseKapazitaet', () => {
  it('parses plain numbers', () => {
    expect(parseKapazitaet('5')).toBe(5)
    expect(parseKapazitaet(' 12 ')).toBe(12)
  })

  it('accepts comma and dot as decimal separator', () => {
    expect(parseKapazitaet('5,5')).toBe(5.5)
    expect(parseKapazitaet('5.5')).toBe(5.5)
  })

  it('accepts a leading dot', () => {
    expect(parseKapazitaet('.5')).toBe(0.5)
  })

  it('rejects empty, malformed and non-positive values', () => {
    expect(parseKapazitaet('')).toBeNull()
    expect(parseKapazitaet('abc')).toBeNull()
    expect(parseKapazitaet('1.2.3')).toBeNull()
    expect(parseKapazitaet('12,')).toBeNull()
    expect(parseKapazitaet('0')).toBeNull()
    expect(parseKapazitaet('-2')).toBeNull()
  })
})

describe('parseDatum', () => {
  it('normalizes ISO and German dates', () => {
    expect(parseDatum('2024-05-01')).toBe('2024-05-01')
    expect(parseDatum('1.5.2024')).toBe('2024-05-01')
    expect(parseDatum('01.05.2024')).toBe('2024-05-01')
  })

  it('rejects invalid calendar dates', () => {
    expect(parseDatum('2024-02-31')).toBeNull()
    expect(parseDatum('31.02.2024')).toBeNull()
    expect(parseDatum('2024-13-01')).toBeNull()
    expect(parseDatum('2024-00-10')).toBeNull()
    expect(parseDatum('')).toBeNull()
  })

  it('detects ISO dates', () => {
    expect(istIsoDatum('2024-05-01')).toBe(true)
    expect(istIsoDatum('01.05.2024')).toBe(false)
    expect(istIsoDatum('2024-02-31')).toBe(false)
  })

  it('computes the quarter', () => {
    expect(quartalVonDatum('2025-01-01')).toBe(1)
    expect(quartalVonDatum('2025-03-31')).toBe(1)
    expect(quartalVonDatum('2025-04-01')).toBe(2)
    expect(quartalVonDatum('2025-07-15')).toBe(3)
    expect(quartalVonDatum('2025-10-01')).toBe(4)
    expect(quartalVonDatum('kaputt')).toBeNull()
  })
})

describe('faelligkeit', () => {
  it('adds whole years', () => {
    expect(faelligkeit('2020-01-15', 5)).toBe('2025-01-15')
    expect(faelligkeit('2020-01-15', 1)).toBe('2021-01-15')
  })

  it('clamps the day to the last day of the target month', () => {
    expect(faelligkeit('2020-02-29', 1)).toBe('2021-02-28')
    expect(faelligkeit('2020-02-29', 4)).toBe('2024-02-29')
  })

  it('rejects invalid input', () => {
    expect(faelligkeit('2020-02-30', 1)).toBeNull()
    expect(faelligkeit('2020-01-15', 0)).toBeNull()
    expect(faelligkeit('2020-01-15', -2)).toBeNull()
  })
})

describe('typFuerKapazitaet', () => {
  const typen = [
    typ({ id: 't1', kapazitaetAh: 1.2, von: 1.0, bis: 1.9 }),
    typ({ id: 't2', kapazitaetAh: 2.5, von: 2.0, bis: 2.9 }),
  ]

  it('matches inclusive range bounds', () => {
    expect(typFuerKapazitaet(1.0, typen)?.id).toBe('t1')
    expect(typFuerKapazitaet(1.9, typen)?.id).toBe('t1')
    expect(typFuerKapazitaet(2.0, typen)?.id).toBe('t2')
  })

  it('returns null for unmatched capacities', () => {
    expect(typFuerKapazitaet(1.95, typen)).toBeNull()
    expect(typFuerKapazitaet(Number.NaN, typen)).toBeNull()
  })
})

describe('pruefeTypen', () => {
  it('accepts valid, non-overlapping ranges', () => {
    expect(
      pruefeTypen([
        typ({ id: 't1', von: 1.0, bis: 1.9, kapazitaetAh: 1.2 }),
        typ({ id: 't2', von: 2.0, bis: 2.9, kapazitaetAh: 2.5 }),
      ]),
    ).toEqual([])
  })

  it('detects overlapping ranges', () => {
    const fehler = pruefeTypen([
      typ({ id: 't1', von: 1.0, bis: 2.0, kapazitaetAh: 1.2 }),
      typ({ id: 't2', von: 1.5, bis: 2.5, kapazitaetAh: 2.0 }),
    ])
    expect(fehler).toHaveLength(1)
    expect(fehler[0]?.code).toBe('ueberlappung')
    expect(fehler[0]?.otherTypId).toBe('t2')
  })

  it('rejects invalid ranges and nominals outside the range', () => {
    const fehler = pruefeTypen([
      typ({ id: 't1', von: 3.0, bis: 1.0, kapazitaetAh: 1.2 }),
      typ({ id: 't2', von: 2.0, bis: 2.9, kapazitaetAh: 5 }),
      typ({ id: 't3', von: 4.0, bis: 4.9, kapazitaetAh: 0 }),
    ])
    expect(fehler.map((f) => f.code)).toEqual([
      'ungueltiger_bereich',
      'nominal_ausserhalb',
      'ungueltige_kapazitaet',
    ])
  })
})

describe('berechnePlanung', () => {
  const typen = [
    typ({ id: 't1', kapazitaetAh: 1.2, von: 1.0, bis: 1.9, artikelId: 'a1' }),
    typ({ id: 't2', kapazitaetAh: 2.5, von: 2.0, bis: 2.9, artikelId: 'a2' }),
  ]

  const bestand = new Map<string, number>([
    ['a1', 3],
    ['a2', 0],
  ])
  const puffer = new Map<string, number>([
    ['a1', 1],
    ['a2', 0],
  ])

  it('sums the devices due in the selected quarter', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [
        netzteil({ id: 'n1', einbaudatum: '2020-01-15', intervallJahre: 5, anzahl: 2 }),
        netzteil({ id: 'n2', einbaudatum: '2019-01-15', intervallJahre: 6, anzahl: 3 }),
      ],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.bedarf).toBe(5)
    expect(planung.zeilen[0]?.bestand).toBe(3)
    expect(planung.zeilen[0]?.puffer).toBe(1)
    expect(planung.zeilen[0]?.verfuegbar).toBe(2)
    expect(planung.zeilen[0]?.bestellmenge).toBe(3)
  })

  it('ignores devices due in another quarter or year', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', einbaudatum: '2020-06-15', intervallJahre: 5, anzahl: 2 })],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.bedarf).toBe(0)
  })

  it('adds the project batteries of the quarter', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [],
      projektakkus: [projektakku({ id: 'p1', artAh: 1.2, menge: 4, quartal: 1, jahr: 2025 })],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.bedarf).toBe(4)
    expect(planung.zeilen[0]?.bestellmenge).toBe(2)
  })

  it('keeps the buffer and never orders more than the demand', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', anzahl: 1 })],
      projektakkus: [],
      bestand: new Map([['a1', 10]]),
      puffer: new Map([['a1', 2]]),
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.verfuegbar).toBe(8)
    expect(planung.zeilen[0]?.bestellmenge).toBe(0)
  })

  it('treats negative stock as no stock', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', anzahl: 2 })],
      projektakkus: [],
      bestand: new Map([['a1', -5]]),
      puffer: new Map([['a1', 0]]),
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.verfuegbar).toBe(0)
    expect(planung.zeilen[0]?.bestellmenge).toBe(2)
  })

  it('orders the missing buffer when the stock stays below it', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', anzahl: 2 })],
      projektakkus: [],
      bestand: new Map([['a1', 1]]),
      puffer: new Map([['a1', 5]]),
      quartal: 1,
      jahr: 2025,
    })
    // Bedarf 2 - Bestand 1 + Puffer 5: der fehlende Puffer wird mitbestellt.
    expect(planung.zeilen[0]?.verfuegbar).toBe(0)
    expect(planung.zeilen[0]?.bestellmenge).toBe(6)
    expect(planung.bestellzeilen[0]?.menge).toBe(6)
  })

  it('ignores soft-deleted records', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', anzahl: 5, geloescht: true })],
      projektakkus: [projektakku({ id: 'p1', menge: 5, geloescht: true })],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.bedarf).toBe(0)
  })

  it('warns about capacities without a configured size', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', kapazitaetAh: 7.5, name: 'Notlicht' })],
      projektakkus: [projektakku({ id: 'p1', artAh: 99, projekt: 'Bau 7' })],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.warnungen.map((w) => w.code)).toEqual([
      'netzteil_keine_groesse',
      'projektakku_keine_groesse',
    ])
    expect(planung.warnungen[0]?.bezug).toBe('Notlicht')
    expect(planung.warnungen[0]?.anlage).toBe('Anlage 1')
    expect(planung.warnungen[0]?.netzteilId).toBe('n1')
  })

  it('warns about invalid installation dates', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', einbaudatum: '2020-02-30', name: 'Defekt' })],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.warnungen[0]?.code).toBe('netzteil_ungueltiges_datum')
  })

  it('warns about devices whose battery data is still incomplete', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', kapazitaetAh: null, anzahl: null, name: 'Ohne Angabe' })],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.warnungen[0]?.code).toBe('netzteil_unvollstaendig')
    expect(planung.warnungen[0]?.bezug).toBe('Ohne Angabe')
    expect(planung.warnungen[0]?.wert).toBe('kapazitaetAh,anzahl')
    expect(planung.warnungen[0]?.anlage).toBe('Anlage 1')
    expect(planung.warnungen[0]?.netzteilId).toBe('n1')
    // The device cannot be planned — it does not add any demand.
    expect(planung.zeilen[0]?.bedarf).toBe(0)
  })

  it('warns about sizes without an article', () => {
    const planung = berechnePlanung({
      typen: [typ({ id: 't1', artikelId: null })],
      netzteile: [],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen[0]?.warnungen[0]?.code).toBe('typ_ohne_artikel')
    expect(planung.zeilen[0]?.bestand).toBe(0)
  })

  it('builds the order list from the rows with demand', () => {
    const planung = berechnePlanung({
      typen,
      netzteile: [netzteil({ id: 'n1', anzahl: 5 })],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.bestellzeilen).toHaveLength(1)
    expect(planung.bestellzeilen[0]?.typId).toBe('t1')
    expect(planung.bestellzeilen[0]?.menge).toBe(3)
    expect(planung.bestellzeilen[0]?.von).toBe(1.0)
    expect(planung.bestellzeilen[0]?.bis).toBe(1.9)
  })

  it('sorts the rows by nominal capacity', () => {
    const planung = berechnePlanung({
      typen: [
        typ({ id: 't2', kapazitaetAh: 2.5, von: 2.0, bis: 2.9, artikelId: 'a2' }),
        typ({ id: 't1', kapazitaetAh: 1.2, von: 1.0, bis: 1.9, artikelId: 'a1' }),
      ],
      netzteile: [],
      projektakkus: [],
      bestand,
      puffer,
      quartal: 1,
      jahr: 2025,
    })
    expect(planung.zeilen.map((z) => z.typ.id)).toEqual(['t1', 't2'])
  })
})

describe('neuerMindestbestand', () => {
  it('setzt den Puffer auf Bedarf minus Bestand', () => {
    expect(neuerMindestbestand(10, 3)).toBe(7)
  })

  it('sinkt nie unter 0 — 0 bedeutet "kein Mindestbestand"', () => {
    expect(neuerMindestbestand(3, 10)).toBe(0)
    expect(neuerMindestbestand(5, 5)).toBe(0)
    expect(neuerMindestbestand(0, 0)).toBe(0)
  })

  it('zaehlt negative Bestaende als kein Bestand', () => {
    expect(neuerMindestbestand(2, -5)).toBe(2)
  })
})

describe('Standard-Akku-Größen', () => {
  it('uses the standard battery types with their capacity corridors', () => {
    expect(DEFAULT_AKKU_GROESSEN.map((d) => [d.kapazitaetAh, d.von, d.bis])).toEqual([
      [1.2, 1, 1.9],
      [2.3, 2, 2.9],
      [3.4, 3, 3.9],
      [5, 4.5, 5.9],
      [7.2, 7, 7.9],
      [9, 8.5, 9.9],
      [12, 10, 12.9],
      [18, 17, 19],
      [26, 22, 28],
      [45, 41, 49],
      [63, 60, 69],
    ])
  })

  it('passes the range validation (no overlaps, nominal inside the band)', () => {
    const typen = DEFAULT_AKKU_GROESSEN.map((d, i) => ({
      ...d,
      id: `default-${i}`,
      artikelId: null,
    }))
    expect(pruefeTypen(typen)).toEqual([])
  })
})

describe('akkuTypen serialisierung', () => {
  it('round-trips a list', () => {
    const typen = [typ({ id: 't1', artikelId: 'a1' })]
    expect(parseAkkuTypen(serialisiereAkkuTypen(typen))).toEqual(typen)
  })

  it('drops malformed entries instead of failing', () => {
    const wert = JSON.stringify([
      { id: 'ok', kapazitaetAh: 1.2, von: 1, bis: 1.9, artikelId: 'a1' },
      { id: '', kapazitaetAh: 1.2, von: 1, bis: 1.9 },
      { id: 'x', kapazitaetAh: 'nope', von: 1, bis: 1.9 },
      'kein objekt',
    ])
    expect(parseAkkuTypen(wert)).toHaveLength(1)
  })

  it('returns an empty list for broken JSON', () => {
    expect(parseAkkuTypen('{kein json')).toEqual([])
    expect(parseAkkuTypen('{"a":1}')).toEqual([])
  })
})

describe('formatierung', () => {
  it('formats numbers with the German locale', () => {
    expect(formatZahl(1234.5, 'de')).toBe('1.234,5')
    expect(formatZahl(12.5, 'de')).toBe('12,5')
  })

  it('formats capacities', () => {
    expect(formatKapazitaet(12.5, 'de')).toBe('12,5 Ah')
    expect(formatKapazitaetBereich(1, 1.9, 'de')).toBe('1–1,9 Ah')
  })

  it('builds the article title from the nominal capacity (not the band)', () => {
    expect(artikelTitel(12.5, 'de')).toBe('Akku 12,5 Ah')
    expect(artikelTitel(1, 'de')).toBe('Akku 1 Ah')
  })

  it('formats dates as TT.MM.JJJJ', () => {
    expect(formatDatum('2024-05-01', 'de')).toBe('01.05.2024')
  })

  it('builds a semicolon separated CSV with BOM', () => {
    const csv = csvDatei([['12,5', '3']], ['Groesse', 'Menge'])
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain('Groesse;Menge')
    expect(csv).toContain('12,5;3')
  })

  it('quotes values that contain the separator', () => {
    const csv = csvDatei([['a;b']], ['x'])
    expect(csv).toContain('"a;b"')
  })
})
