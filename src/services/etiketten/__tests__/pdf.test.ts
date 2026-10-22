// Tests der reinen PDF-Hilfsfunktionen (Geometrie + Textkuerzung).
// Das eigentliche PDF-Rendering braucht Canvas + DOM und wird im Browser
// ausgefuehrt; hier pruefen wir die deterministische Rechenbasis.

import { describe, it, expect } from 'vitest'
import { barcodeGeometrie, kuerze } from '../pdf'

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

describe('etiketten/kuerze', () => {
  it('laesst kurze Texte unveraendert', () => {
    expect(kuerze('Schraube', 20)).toBe('Schraube')
  })

  it('kuerzt lange Texte mit Auslassungspunkten', () => {
    const r = kuerze('Ein sehr langer Artikelname', 10)
    expect(r).toHaveLength(10)
    expect(r.endsWith('…')).toBe(true)
  })

  it('verträgt eine Maximallänge von 0', () => {
    expect(kuerze('egal', 0)).toBe('')
  })
})
