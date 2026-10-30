// Tests der OCR-Extraktion (Kommissionsnummer aus Kameratext).
//
// Der OCR-Text ist unsauber — Labels stehen mal inline ("Projektnummer:
// AA 1234"), mal in einem Block ueber den Werten. Beide Faelle muessen
// funktionieren. Ohne Label greift der Rueckfall: freie Nummern.

import { describe, expect, it } from 'vitest'
import {
  extrahiereKommissionsNummer,
  istPlausibleNummer,
  normalisiereOcrNummer,
} from '../kommission-ocr'

describe('extrahiereKommissionsNummer — Inline-Labels', () => {
  it('erkennt die Nummer nach "Projektnummer:"', () => {
    const kandidaten = extrahiereKommissionsNummer('Projektnummer: AA 1234')
    expect(kandidaten).toHaveLength(1)
    expect(kandidaten[0]?.wert).toBe('AA 1234')
    expect(kandidaten[0]?.keyword).toBe('Projektnummer')
    expect(kandidaten[0]?.quelle).toBe('label')
  })

  it('erkennt die Nummer nach "AA:"', () => {
    const kandidaten = extrahiereKommissionsNummer('AA: 908454')
    expect(kandidaten[0]?.wert).toBe('908454')
    expect(kandidaten[0]?.keyword).toBe('AA')
  })

  it('erkennt die Nummer nach "SA:"', () => {
    const kandidaten = extrahiereKommissionsNummer('SA: 5678')
    expect(kandidaten[0]?.wert).toBe('5678')
    expect(kandidaten[0]?.keyword).toBe('SA')
  })

  it('erkennt die Nummer nach "Servicenummer"', () => {
    const kandidaten = extrahiereKommissionsNummer('Servicenummer 91011')
    expect(kandidaten[0]?.wert).toBe('91011')
    expect(kandidaten[0]?.keyword).toBe('Servicenummer')
  })

  it('erkennt die Nummer nach "Kommission"', () => {
    const kandidaten = extrahiereKommissionsNummer('Kommission: K-22')
    expect(kandidaten[0]?.wert).toBe('K-22')
    expect(kandidaten[0]?.keyword).toBe('Kommission')
  })

  it('laesst kein Feld nach der Nummer mit einfaangen', () => {
    const kandidaten = extrahiereKommissionsNummer('Projektnummer: AA 1234 Datum: 05.03.2024')
    expect(kandidaten[0]?.wert).toBe('AA 1234')
  })

  it('ignoriert "AA" ohne Doppelpunkt (z. B. Fliesstext)', () => {
    const kandidaten = extrahiereKommissionsNummer('Wir reparieren die Anlage AA im Haus')
    expect(kandidaten).toHaveLength(0)
  })
})

describe('extrahiereKommissionsNummer — Label-Block ueber Wert-Block', () => {
  const BLOCK = `Projektnummer:
Servicenummer:
Kommission:
908454
00012775`

  it('ordnet die Werte den Labels positionell zu', () => {
    const kandidaten = extrahiereKommissionsNummer(BLOCK)
    const werte = kandidaten.map((k) => k.wert)
    expect(werte).toContain('908454')
    expect(werte).toContain('00012775')
  })
})

describe('extrahiereKommissionsNummer — Rueckfall ohne Label', () => {
  it('bietet eine freie Nummer an, wenn kein Label erkannt wird', () => {
    const kandidaten = extrahiereKommissionsNummer('12345')
    expect(kandidaten).toHaveLength(1)
    expect(kandidaten[0]?.wert).toBe('12345')
    expect(kandidaten[0]?.quelle).toBe('frei')
  })

  it('verwirft Datum und Uhrzeit', () => {
    const kandidaten = extrahiereKommissionsNummer('05.03.2024 14:30')
    expect(kandidaten).toHaveLength(0)
  })

  it('verwirft Telefonnummern', () => {
    const kandidaten = extrahiereKommissionsNummer('+49 8031 616970')
    expect(kandidaten).toHaveLength(0)
  })
})

describe('istPlausibleNummer', () => {
  it('akzeptiert Nummern mit Praefix', () => {
    expect(istPlausibleNummer('AA-1234')).toBe(true)
    expect(istPlausibleNummer('K-22')).toBe(true)
  })

  it('lehnt Datum, Uhrzeit und Telefon ab', () => {
    expect(istPlausibleNummer('05.03.2024')).toBe(false)
    expect(istPlausibleNummer('14:30')).toBe(false)
    expect(istPlausibleNummer('+498031616970')).toBe(false)
  })

  it('lehnt Texte ohne Ziffern ab', () => {
    expect(istPlausibleNummer('Müller')).toBe(false)
  })
})

describe('normalisiereOcrNummer', () => {
  it('trimmt und fasst Leerzeichen zusammen', () => {
    expect(normalisiereOcrNummer('  AA   1234 ')).toBe('AA 1234')
  })
})
