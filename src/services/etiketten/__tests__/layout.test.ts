// Tests der Etiketten-Geometrie (reine Funktionen, ohne jsPDF/DOM).

import { describe, it, expect } from 'vitest'
import { planeEtiketten, presetWarnungen } from '../layout'
import {
  ETIKETTEN_PRESETS,
  PRESET_21ER,
  PRESET_LISTE,
  benutzerdefiniertesPreset,
  etikettenJeSeite,
  randPreset,
  seitenAnzahl,
  startfeldVersatz,
} from '../presets'

describe('etiketten/presets', () => {
  it('alle Presets passen auf A4', () => {
    for (const p of ETIKETTEN_PRESETS) {
      expect(presetWarnungen(p)).toEqual([])
    }
  })

  it('etikettenJeSeite multipliziert Spalten und Zeilen', () => {
    expect(etikettenJeSeite(PRESET_21ER)).toBe(21)
    expect(etikettenJeSeite(PRESET_LISTE)).toBe(40)
  })

  it('seitenAnzahl rundet auf ganze Seiten auf', () => {
    expect(seitenAnzahl(0, PRESET_21ER)).toBe(0)
    expect(seitenAnzahl(1, PRESET_21ER)).toBe(1)
    expect(seitenAnzahl(21, PRESET_21ER)).toBe(1)
    expect(seitenAnzahl(22, PRESET_21ER)).toBe(2)
    expect(seitenAnzahl(43, PRESET_21ER)).toBe(3)
  })

  it('zentriert den Etikettenblock, wenn keine Raender gesetzt sind', () => {
    const { marginX, marginY } = randPreset(PRESET_21ER)
    const belegtX = 3 * 63.5 + 2 * 2.5
    expect(marginX).toBeCloseTo((210 - belegtX) / 2, 5)
    expect(marginY).toBeCloseTo((297 - 7 * 38.1) / 2, 5)
  })

  it('nutzt gesetzte Raender unveraendert', () => {
    const p = { ...benutzerdefiniertesPreset(), marginX: 10, marginY: 5 }
    expect(randPreset(p)).toEqual({ marginX: 10, marginY: 5 })
  })
})

describe('etiketten/layout', () => {
  it('ordnet die Etiketten zeilenweise an', () => {
    const pos = planeEtiketten(4, PRESET_21ER)
    expect(pos).toHaveLength(4)
    expect(pos[0]).toMatchObject({ seite: 1, spalte: 0, zeile: 0 })
    expect(pos[1]).toMatchObject({ seite: 1, spalte: 1, zeile: 0 })
    expect(pos[2]).toMatchObject({ seite: 1, spalte: 2, zeile: 0 })
    expect(pos[3]).toMatchObject({ seite: 1, spalte: 0, zeile: 1 })
  })

  it('bricht nach etikettenJeSeite auf die naechste Seite um', () => {
    const pos = planeEtiketten(22, PRESET_21ER)
    expect(pos[20]).toMatchObject({ seite: 1, zeile: 6, spalte: 2 })
    expect(pos[21]).toMatchObject({ seite: 2, zeile: 0, spalte: 0 })
  })

  it('liefert bei leerer Auswahl keine Positionen', () => {
    expect(planeEtiketten(0, PRESET_21ER)).toEqual([])
    expect(planeEtiketten(-1, PRESET_21ER)).toEqual([])
  })

  it('haelt die Etiketten innerhalb der A4-Flaeche', () => {
    const pos = planeEtiketten(21, PRESET_21ER)
    for (const p of pos) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(210.001)
      expect(p.y + p.h).toBeLessThanOrEqual(297.001)
    }
  })

  it('meldet Presets, die nicht auf A4 passen', () => {
    const zuBreit = { ...benutzerdefiniertesPreset(), cols: 10, labelW: 63.5, gapX: 0 }
    expect(presetWarnungen(zuBreit)).toContain('zuBreit')

    const zuHoch = { ...benutzerdefiniertesPreset(), rows: 30, labelH: 38.1, gapY: 0 }
    expect(presetWarnungen(zuHoch)).toContain('zuHoch')

    const unsinnig = { ...benutzerdefiniertesPreset(), cols: 0 }
    expect(presetWarnungen(unsinnig)).toContain('cols')
  })
})

describe('etiketten/startfeld', () => {
  it('berechnet den Versatz aus dem Startfeld', () => {
    expect(startfeldVersatz(1, PRESET_21ER)).toBe(0)
    expect(startfeldVersatz(7, PRESET_21ER)).toBe(6)
    expect(startfeldVersatz(21, PRESET_21ER)).toBe(20)
  })

  it('begrenzt den Versatz auf die Feldzahl des Bogens', () => {
    expect(startfeldVersatz(0, PRESET_21ER)).toBe(0)
    expect(startfeldVersatz(999, PRESET_21ER)).toBe(20)
    expect(startfeldVersatz(Number.NaN, PRESET_21ER)).toBe(0)
  })

  it('startet ab dem gewaehlten Feld (Feld 1 = oben links)', () => {
    // 21er-Bogen: 3 Spalten — Feld 7 ist die erste Spalte der dritten Zeile.
    const pos = planeEtiketten(4, PRESET_21ER, 7)
    expect(pos[0]).toMatchObject({ seite: 1, spalte: 0, zeile: 2 })
    expect(pos[1]).toMatchObject({ seite: 1, spalte: 1, zeile: 2 })
    expect(pos[2]).toMatchObject({ seite: 1, spalte: 2, zeile: 2 })
    expect(pos[3]).toMatchObject({ seite: 1, spalte: 0, zeile: 3 })
  })

  it('nutzt auf der ersten Seite nur die freien Felder', () => {
    const pos = planeEtiketten(15, PRESET_21ER, 7)
    expect(pos).toHaveLength(15)
    expect(pos[14]).toMatchObject({ seite: 1, zeile: 6, spalte: 2 })

    // Das 16. Etikett passt nicht mehr auf die erste Seite.
    const pos2 = planeEtiketten(16, PRESET_21ER, 7)
    expect(pos2[15]).toMatchObject({ seite: 2, zeile: 0, spalte: 0 })
  })

  it('zaehlt Seiten mit dem verkleinerten ersten Bogen', () => {
    expect(seitenAnzahl(15, PRESET_21ER, 7)).toBe(1)
    expect(seitenAnzahl(16, PRESET_21ER, 7)).toBe(2)
    expect(seitenAnzahl(21, PRESET_21ER, 7)).toBe(2)
    expect(seitenAnzahl(36, PRESET_21ER, 7)).toBe(2)
    expect(seitenAnzahl(37, PRESET_21ER, 7)).toBe(3)
    // Ohne Startfeld unveraendert.
    expect(seitenAnzahl(21, PRESET_21ER, 1)).toBe(1)
  })

  it('startet im Listen-Layout ab der gewaehlten Zeile', () => {
    const pos = planeEtiketten(3, PRESET_LISTE, 5)
    expect(pos[0]).toMatchObject({ seite: 1, zeile: 4, spalte: 0 })
    expect(pos[2]).toMatchObject({ seite: 1, zeile: 6, spalte: 0 })
  })
})
