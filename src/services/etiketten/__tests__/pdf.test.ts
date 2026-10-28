// Tests der Etiketten-PDF-Helfer: Barcode-Geometrie, Textlayout und die
// Textwiedergabe im Renderer. Der eigentliche Barcode-Render braucht ein
// Canvas (im jsdom-Test nicht vorhanden -> Platzhalter); jsPDF ist ersetzt
// durch einen Fake, der jede Textausgabe mitzaehlt.

import { describe, it, expect, vi } from 'vitest'
import {
  barcodeGeometrie,
  einzeilig,
  erzeugeEtikettenPdf,
  kuerzeBreite,
  passeTextEin,
  zeilenHoeheMm,
  zeilenUmbrechen,
  type EtikettDaten,
  type SkalenMesser,
} from '../pdf'
import { PRESET_21ER, PRESET_LISTE, benutzerdefiniertesPreset, randPreset } from '../presets'

/** faux-Messer: 2 mm je Zeichen (unabhaengig vom Schriftgrad). */
const flacherMesser = (text: string) => text.length * 2
/** faux-Messer: 0.2 mm je Zeichen und pt. */
const skalenMesser: SkalenMesser = (text, groessePt) => text.length * groessePt * 0.2

const LANGER_NAME = 'Sehr langer Artikelname mit vielen Woertern und jeder Menge Zusatzinfo'

describe('etiketten/barcodeGeometrie', () => {
  it('haelt die Balkenhoehe im verfuegbaren Platz', () => {
    const geo = barcodeGeometrie(95, 60, 26)
    expect(geo.hoeheMm).toBeLessThanOrEqual(26)
    expect(geo.hoehePx).toBeGreaterThan(0)
  })

  it('begrenzt die Balkenhoehe auf die Wunschhoehe', () => {
    const geo = barcodeGeometrie(95, 60, 500)
    expect(geo.hoeheMm).toBe(12)
  })

  it('skaliert die Modulbreite herunter, wenn der Code nicht passt', () => {
    // 400 Module passen nicht auf 60 mm -> die Modulbreite muss schrumpfen.
    const lang = barcodeGeometrie(400, 60, 26)
    const kurz = barcodeGeometrie(40, 60, 26)
    expect(lang.modulPx).toBeLessThan(kurz.modulPx)
    expect(lang.modulPx).toBeGreaterThanOrEqual(1)
  })

  it('liefert mindestens 1 px Modulbreite', () => {
    const geo = barcodeGeometrie(5000, 10, 10)
    expect(geo.modulPx).toBeGreaterThanOrEqual(1)
  })
})

describe('etiketten/zeilenHoeheMm', () => {
  it('waechst mit dem Schriftgrad', () => {
    expect(zeilenHoeheMm(7)).toBeGreaterThan(zeilenHoeheMm(5))
    expect(zeilenHoeheMm(0)).toBe(0)
  })
})

describe('etiketten/zeilenUmbrechen', () => {
  it('bricht an Wortgrenzen um', () => {
    expect(zeilenUmbrechen('Alpha Beta Gamma', 20, flacherMesser)).toEqual(['Alpha Beta', 'Gamma'])
  })

  it('trennt ein ueberlanger Wort hart', () => {
    expect(zeilenUmbrechen('AAAAAAAAAA', 10, flacherMesser)).toEqual(['AAAAA', 'AAAAA'])
  })

  it('nutzt die ganze Breite aus, wenn der Name in eine Zeile passt', () => {
    const zeilen = zeilenUmbrechen(LANGER_NAME, 200, flacherMesser)
    expect(zeilen).toHaveLength(1)
    expect(zeilen[0]).toBe(LANGER_NAME)
  })

  it('laesst keinen Text weg', () => {
    const zeilen = zeilenUmbrechen(LANGER_NAME, 30, flacherMesser)
    expect(zeilen.length).toBeGreaterThan(2)
    expect(zeilen.join(' ')).toBe(LANGER_NAME)
    for (const zeile of zeilen) expect(flacherMesser(zeile)).toBeLessThanOrEqual(30)
  })

  it('liefert keine Zeilen bei leerem Text oder null Breite', () => {
    expect(zeilenUmbrechen('   ', 20, flacherMesser)).toEqual([])
    expect(zeilenUmbrechen('Alpha', 0, flacherMesser)).toEqual([])
  })
})

describe('etiketten/kuerzeBreite', () => {
  it('laesst passende Texte unveraendert', () => {
    expect(kuerzeBreite('Schraube', 20, flacherMesser)).toBe('Schraube')
  })

  it('kuerzt auf die Breite und markiert mit Auslassungspunkten', () => {
    const r = kuerzeBreite('Ein sehr langer Name', 10, flacherMesser)
    expect(r.endsWith('…')).toBe(true)
    expect(flacherMesser(r)).toBeLessThanOrEqual(10)
  })
})

describe('etiketten/passeTextEin', () => {
  const GROESSSEN = [7, 6.5, 6, 5.5, 5]

  it('haelt die groesste Schrift fuer kurze Namen', () => {
    const r = passeTextEin('Schraube', GROESSSEN, 60, 9, skalenMesser)
    expect(r.groessePt).toBe(7)
    expect(r.zeilen).toEqual(['Schraube'])
    expect(r.abgeschnitten).toBe(false)
  })

  it('bricht lange Namen um und erhaelt sie vollstaendig', () => {
    const r = passeTextEin(LANGER_NAME, GROESSSEN, 40, 9, skalenMesser)
    expect(r.abgeschnitten).toBe(false)
    expect(r.zeilen.join(' ')).toBe(LANGER_NAME)
    expect(r.zeilen.length * zeilenHoeheMm(r.groessePt)).toBeLessThanOrEqual(9)
    for (const zeile of r.zeilen) {
      expect(skalenMesser(zeile, r.groessePt)).toBeLessThanOrEqual(40)
    }
  })

  it('verkleinert die Schrift, bevor der Name gekuerzt wird', () => {
    const knapp = passeTextEin(LANGER_NAME, GROESSSEN, 40, 6, skalenMesser)
    expect(knapp.abgeschnitten).toBe(false)
    expect(knapp.groessePt).toBeLessThan(7)
    expect(knapp.zeilen.join(' ')).toBe(LANGER_NAME)
  })

  it('kuerzt erst, wenn auch die kleinste Schrift nicht passt', () => {
    const r = passeTextEin(LANGER_NAME, [7, 5], 60, 3, skalenMesser)
    expect(r.groessePt).toBe(5)
    expect(r.abgeschnitten).toBe(true)
    expect(r.zeilen).toHaveLength(1)
    const letzte = r.zeilen[0] ?? ''
    expect(letzte.endsWith('…')).toBe(true)
    expect(skalenMesser(letzte, 5)).toBeLessThanOrEqual(60)
  })

  it('vertraegt leere Texte und leere Groessenlisten', () => {
    expect(passeTextEin('  ', GROESSSEN, 60, 9, skalenMesser).zeilen).toEqual([])
    const r = passeTextEin('Alpha', [], 60, 9, skalenMesser)
    expect(r.abgeschnitten).toBe(true)
    expect(r.zeilen).toEqual([])
  })
})

describe('etiketten/einzeilig', () => {
  it('waehlt die groesste Schrift, die in eine Zeile passt', () => {
    const r = einzeilig('4001234500012', [6, 5.5, 5, 4.5], 40, skalenMesser)
    expect(r.groessePt).toBe(6)
    expect(r.text).toBe('4001234500012')
  })

  it('verkleinert lange Barcode-Werte statt sie abschneiden zu lassen', () => {
    const lang = 'ARTIKELNUMMER-12345678901234567890'
    const r = einzeilig(lang, [6, 5.5, 5, 4.5], 34, skalenMesser)
    expect(r.groessePt).toBe(5)
    expect(r.text).toBe(lang)
  })

  it('kuerzt, wenn auch die kleinste Schrift zu breit ist', () => {
    const r = einzeilig('X'.repeat(40), [6, 4.5], 10, skalenMesser)
    expect(r.groessePt).toBe(4.5)
    expect(r.text.endsWith('…')).toBe(true)
    expect(skalenMesser(r.text, 4.5)).toBeLessThanOrEqual(10)
  })
})

// ---------------------------------------------------------------------------
// Integrationspruefung des Renderers: der Artikelname muss vollstaendig und
// ohne Ueberlappung aufs Etikett. jsPDF ist durch einen Fake ersetzt, der
// jede Textausgabe samt Position mitzaehlt. Der Barcode scheitert im jsdom
// (kein Canvas) und wird zum Platzhalter — fuer die Textpruefung irrelevant.
// ---------------------------------------------------------------------------

interface ZeichenWeise {
  text: string
  x: number
  y: number
  groessePt: number
}

const gezeichnet = vi.hoisted(() => ({ texte: [] as ZeichenWeise[] }))

vi.mock('jspdf', () => {
  class FakeDoc {
    private groessePt = 12
    setFont(): void {}
    setTextColor(): void {}
    setFontSize(groessePt: number): void {
      this.groessePt = groessePt
    }
    getTextWidth(text: string): number {
      return text.length * this.groessePt * 0.2
    }
    text(text: string | string[], x: number, y: number): void {
      for (const zeile of Array.isArray(text) ? text : [text]) {
        gezeichnet.texte.push({ text: zeile, x, y, groessePt: this.groessePt })
      }
    }
    addImage(): void {}
    addPage(): void {}
    output(): Blob {
      return new Blob(['fake'], { type: 'application/pdf' })
    }
  }
  return { jsPDF: FakeDoc }
})

const BARCODE_WERT = '4012345678901'

/** Nur die Zeilen des Artikelnamens (Barcode-Wert und Platzhalter abziehen). */
function namenZeilen(): ZeichenWeise[] {
  return gezeichnet.texte.filter(
    (e) => e.text !== BARCODE_WERT && !e.text.startsWith('kein gueltiger'),
  )
}

/** Hinweise wegen gekuerzter Artikelnamen. */
function kurzenzHinweise(warnungen: string[]): string[] {
  return warnungen.filter((w) => w.includes('Name passt nicht'))
}

describe('etiketten/erzeugeEtikettenPdf — Artikelname', () => {
  const SEHR_LANGER_NAME = 'Fuellwort '.repeat(30).trim()

  function artikel(titel: string): EtikettDaten {
    return { id: 'a1', titel, typ: 'Demo', barcode: BARCODE_WERT }
  }

  function aufZeichnen(): void {
    gezeichnet.texte.length = 0
  }

  it('zeichnet den vollen Namen im Raster-Etikett (mehrzeilig, ohne Auslassung)', async () => {
    aufZeichnen()
    const ergebnis = await erzeugeEtikettenPdf([artikel(LANGER_NAME)], PRESET_21ER, 'EAN13')
    const zeilen = namenZeilen()
    expect(zeilen.length).toBeGreaterThan(1)
    expect(zeilen.map((z) => z.text).join(' ')).toBe(LANGER_NAME)
    expect(kurzenzHinweise(ergebnis.warnungen)).toEqual([])
  })

  it('laesst auch 270 Zeichen auf dem 21er-Etikett stehen', async () => {
    aufZeichnen()
    const ergebnis = await erzeugeEtikettenPdf([artikel(SEHR_LANGER_NAME)], PRESET_21ER, 'EAN13')
    const zeilen = namenZeilen()
    expect(zeilen.map((z) => z.text).join(' ')).toBe(SEHR_LANGER_NAME)
    expect(zeilen.some((z) => z.text.endsWith('…'))).toBe(false)
    expect(kurzenzHinweise(ergebnis.warnungen)).toEqual([])
  })

  it('zeichnet den vollen Namen in der Listen-Variante', async () => {
    aufZeichnen()
    const ergebnis = await erzeugeEtikettenPdf([artikel(LANGER_NAME)], PRESET_LISTE, 'EAN13')
    expect(
      namenZeilen()
        .map((z) => z.text)
        .join(' '),
    ).toBe(LANGER_NAME)
    expect(kurzenzHinweise(ergebnis.warnungen)).toEqual([])
  })

  it('haelt Namenszeilen und Barcode-Wert getrennt innerhalb des Etiketts', async () => {
    aufZeichnen()
    await erzeugeEtikettenPdf([artikel(SEHR_LANGER_NAME)], PRESET_21ER, 'EAN13')
    const { marginY } = randPreset(PRESET_21ER)
    const etikettOben = marginY
    const etikettUnten = marginY + PRESET_21ER.labelH
    const zeilen = namenZeilen()
    const wert = gezeichnet.texte.find((e) => e.text === BARCODE_WERT)
    expect(wert).toBeDefined()
    for (const zeile of zeilen) {
      expect(zeile.y).toBeLessThanOrEqual(etikettUnten - 1)
      expect(zeile.y - 0.75 * zeilenHoeheMm(zeile.groessePt)).toBeGreaterThanOrEqual(etikettOben)
    }
    const tiefsteNameBaseline = Math.max(...zeilen.map((z) => z.y))
    expect((wert as ZeichenWeise).y - tiefsteNameBaseline).toBeGreaterThanOrEqual(2)
  })

  it('meldet eine Warnung, wenn der Name wirklich nicht passt', async () => {
    aufZeichnen()
    const winzig = { ...benutzerdefiniertesPreset(), cols: 1, rows: 1, labelW: 30, labelH: 12 }
    const ergebnis = await erzeugeEtikettenPdf([artikel(LANGER_NAME)], winzig, 'EAN13')
    expect(kurzenzHinweise(ergebnis.warnungen)).toHaveLength(1)
    const zeilen = namenZeilen()
    expect(zeilen[zeilen.length - 1]?.text.endsWith('…')).toBe(true)
    expect(zeilen.map((z) => z.text).join(' ')).not.toBe(LANGER_NAME)
  })
})
