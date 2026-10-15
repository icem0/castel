// Tests für den Bootstrap beim allerersten Setup: Hauptlager + 5 Test-Artikel
// werden automatisch angelegt. Wir testen hier die Pure-Bestandteile (Inhalt
// pro Sprache, Datensatz-Form, Lokalisierung). Die DB-Interaktion selbst
// ist eine duenne Wrapper-Schicht um `tx.insert()` und wird in der
// Integration gegen die echte Test-Postgres verifiziert (siehe README).

import { describe, expect, it } from 'vitest'
import { bootstrapInhalt } from '../domain/validierung.js'
import { __test__ } from '../auth/bootstrap.js'

describe('bootstrapInhalt', () => {
  it('liefert deutschen Hauptlager-Namen + 5 deutsche Test-Artikel (de-DE)', () => {
    const inhalt = bootstrapInhalt('de-DE')

    expect(inhalt.hauptlagerName).toBe('Hauptlager')
    expect(inhalt.testArtikel).toHaveLength(5)
    expect(inhalt.testArtikel.every((a) => a.titel.startsWith('Beispielartikel '))).toBe(true)
    expect(inhalt.testArtikel.every((a) => a.typ === 'Demo')).toBe(true)
    expect(inhalt.testArtikel.every((a) => a.verpackungseinheit === 1)).toBe(true)
    expect(inhalt.testArtikel.every((a) => a.mindestbestand === 0)).toBe(true)
  })

  it('liefert englischen Hauptlager-Namen + 5 englische Test-Artikel (en-US)', () => {
    const inhalt = bootstrapInhalt('en-US')

    expect(inhalt.hauptlagerName).toBe('Main Warehouse')
    expect(inhalt.testArtikel).toHaveLength(5)
    expect(inhalt.testArtikel.every((a) => a.titel.startsWith('Sample Article '))).toBe(true)
    expect(inhalt.testArtikel.every((a) => a.typ === 'Demo')).toBe(true)
  })

  it('Test-Artikel haben eindeutige Titel', () => {
    for (const locale of ['de-DE', 'en-US'] as const) {
      const inhalt = bootstrapInhalt(locale)
      const titel = inhalt.testArtikel.map((a) => a.titel)
      expect(new Set(titel).size).toBe(titel.length)
    }
  })
})

describe('buildHauptlager', () => {
  it('liefert einen Standard-Lager-Standort mit den erwarteten Flags', () => {
    const standort = __test__.buildHauptlager(bootstrapInhalt('de-DE'))

    expect(standort.name).toBe('Hauptlager')
    expect(standort.typ).toBe('lager')
    expect(standort.standard).toBe(true)
    expect(standort.archiviert).toBe(false)
    expect(standort.projekt).toBeNull()
    expect(standort.kennzeichen).toBeNull()
    expect(typeof standort.id).toBe('string')
    expect(standort.id.length).toBeGreaterThan(0)
  })

  it('verwendet den sprachspezifischen Namen', () => {
    const standort = __test__.buildHauptlager(bootstrapInhalt('en-US'))
    expect(standort.name).toBe('Main Warehouse')
  })
})

describe('buildTestArtikel', () => {
  it('liefert genau 5 verfuegbare Demo-Artikel ohne Lieferant/Bestellnummer/Barcode', () => {
    const artikel = __test__.buildTestArtikel(bootstrapInhalt('de-DE'))

    expect(artikel).toHaveLength(5)
    expect(artikel.every((a) => a.status === 'verfuegbar')).toBe(true)
    expect(artikel.every((a) => a.typ === 'Demo')).toBe(true)
    expect(artikel.every((a) => a.lieferant === null)).toBe(true)
    expect(artikel.every((a) => a.bestellnummer === null)).toBe(true)
    expect(artikel.every((a) => a.barcode === null)).toBe(true)
    expect(artikel.every((a) => a.listenpreis === null)).toBe(true)
    expect(artikel.every((a) => a.archiviert === false)).toBe(true)
    expect(artikel.every((a) => typeof a.id === 'string' && a.id.length > 0)).toBe(true)
  })

  it('alle IDs sind eindeutig (UUIDs)', () => {
    const artikel = __test__.buildTestArtikel(bootstrapInhalt('de-DE'))
    const ids = artikel.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
