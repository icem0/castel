// Tests der OCR-Extraktion (Kommissionsnummer aus Kameratext).
//
// Der OCR-Text ist unsauber — Labels stehen mal inline ("Projektnummer:
// AA 1234"), mal in einem Block ueber den Werten. Beide Faelle muessen
// funktionieren. Ohne Label greift der Rueckfall: freie Nummern.

import { describe, expect, it } from 'vitest'
import {
  MAX_OCR_SKALIERUNG,
  MIN_OCR_HOEHE,
  berechneOcrSkalierung,
  berechneVideoAusschnitt,
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

describe('berechneVideoAusschnitt — Crop auf die Video-Pixel abbilden', () => {
  it('bildet 1:1 ab, wenn Container und Video dasselbe Seitenverhaeltnis haben', () => {
    const ausschnitt = berechneVideoAusschnitt(
      { width: 640, height: 360 },
      { width: 1280, height: 720 },
      { x: 25.6, y: 154.8, width: 588.8, height: 50.4 },
      'cover',
    )
    expect(ausschnitt.x).toBeCloseTo(0.04, 3)
    expect(ausschnitt.y).toBeCloseTo(0.43, 3)
    expect(ausschnitt.width).toBeCloseTo(0.92, 3)
    expect(ausschnitt.height).toBeCloseTo(0.14, 3)
  })

  it('beruecksichtigt den Beschnitt bei cover (Video schmaler als der Container)', () => {
    // Container 640x360 (16:9), Video 320x240 (4:3) — cover schneidet oben
    // und unten ab, der sichtbare Streifen beginnt bei 12,5 % Hoehe.
    const ausschnitt = berechneVideoAusschnitt(
      { width: 640, height: 360 },
      { width: 320, height: 240 },
      { x: 0, y: 0, width: 640, height: 360 },
      'cover',
    )
    expect(ausschnitt.x).toBeCloseTo(0, 3)
    expect(ausschnitt.y).toBeCloseTo(0.125, 3)
    expect(ausschnitt.width).toBeCloseTo(1, 3)
    expect(ausschnitt.height).toBeCloseTo(0.75, 3)
  })

  it('beruecksichtigt die Letterbox-Raender bei contain', () => {
    const ausschnitt = berechneVideoAusschnitt(
      { width: 640, height: 200 },
      { width: 640, height: 480 },
      { x: 200, y: 0, width: 100, height: 200 },
      'contain',
    )
    expect(ausschnitt.x).toBeCloseTo(0.05, 2)
    expect(ausschnitt.width).toBeCloseTo(0.375, 2)
    expect(ausschnitt.height).toBeCloseTo(1, 2)
  })

  it('schneidet den Ausschnitt auf das Video zu', () => {
    const ausschnitt = berechneVideoAusschnitt(
      { width: 640, height: 360 },
      { width: 1280, height: 720 },
      { x: -100, y: -50, width: 5000, height: 5000 },
      'cover',
    )
    expect(ausschnitt.x).toBe(0)
    expect(ausschnitt.y).toBe(0)
    expect(ausschnitt.width).toBe(1)
    expect(ausschnitt.height).toBe(1)
  })

  it('liefert das ganze Bild, wenn noch kein Videobild vorliegt', () => {
    const ausschnitt = berechneVideoAusschnitt(
      { width: 640, height: 360 },
      { width: 0, height: 0 },
      { x: 0, y: 0, width: 640, height: 360 },
    )
    expect(ausschnitt).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('extrahiereKommissionsNummer — alleinstehende Nummer ohne Label', () => {
  it('erkennt eine Nummer, die allein steht', () => {
    const kandidaten = extrahiereKommissionsNummer('AA 1234')
    expect(kandidaten).toHaveLength(1)
    expect(kandidaten[0]?.wert).toBe('AA 1234')
    expect(kandidaten[0]?.quelle).toBe('frei')
  })

  it('erkennt eine reine Ziffernfolge ohne Praefix', () => {
    const kandidaten = extrahiereKommissionsNummer('908454')
    expect(kandidaten).toHaveLength(1)
    expect(kandidaten[0]?.wert).toBe('908454')
    expect(kandidaten[0]?.quelle).toBe('frei')
  })

  it('behaelt das Buchstaben-Praefix bei der Nummer', () => {
    // "AA 1234" ist eine andere Kommission als "1234" — das Praefix
    // gehoert zur Nummer.
    const kandidaten = extrahiereKommissionsNummer('K-22')
    expect(kandidaten[0]?.wert).toBe('K-22')
  })

  it('nimmt das Label nicht in die Nummer auf', () => {
    const kandidaten = extrahiereKommissionsNummer('Nr. 1234')
    expect(kandidaten[0]?.wert).toBe('1234')
  })

  it('erkennt mehrere alleinstehende Nummern', () => {
    const kandidaten = extrahiereKommissionsNummer('908454 und 00012775')
    const werte = kandidaten.map((k) => k.wert)
    expect(werte).toContain('908454')
    expect(werte).toContain('00012775')
  })
})

describe('berechneOcrSkalierung', () => {
  it('skaliert einen kleinen Kamera-Streifen hoch', () => {
    // 640x480-Kamera, 14 % Streifenhoehe = 67 px
    const skala = berechneOcrSkalierung(589, 67)
    expect(skala).toBeGreaterThan(1)
    expect(67 * skala).toBeGreaterThanOrEqual(MIN_OCR_HOEHE)
  })

  it('laesst ein ausreichend grosses Bild unveraendert', () => {
    expect(berechneOcrSkalierung(1400, 120)).toBe(1)
  })

  it('begrenzt die Skalierung', () => {
    expect(berechneOcrSkalierung(50, 10)).toBe(MAX_OCR_SKALIERUNG)
  })

  it('liefert 1 bei ungueltigen Massen', () => {
    expect(berechneOcrSkalierung(0, 0)).toBe(1)
  })
})
