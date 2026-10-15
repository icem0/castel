// Tests für den CSV-Import-Pfad.

import { beforeEach, describe, expect, it } from 'vitest'
import { CastelDb, setDb } from '../../../db/database'
import { parseCsv } from '../csv-parser'
import { defaultArtikelMapping, defaultWarenMapping } from '../mapping'
import { validiereArtikelMapping } from '../validierung'
import { importArtikelAusCsv, importAusCsv, importWarenAusCsv } from '../import'

// Mini-Fixtures (Test-Plan §12): repräsentieren einen SharePoint-Export.
const LAGER_CSV = `ID;Foto;Title;Status;Type;Lieferant;VE;Bestand-min;Nachbestellung;Bestellnr.;Listenpreis;Geändert
1;https://example.com/ms400.jpg;MS 400;verfügbar;Alarmierung;Bosch;1;20;bald;MS400;1299,00;01.01.2025
2;https://example.com/bx.jpg;BX-SOL-CT-W;verfügbar;Brandmelder;Bosch;1;10;;BXSOL;459,50;15.02.2025`

const WAREN_CSV = `Entnahme;Projekt-AA-SA-Nummer;Artikel;Menge;Erstellt;Erstellt-von;Entnommen aus;Kommentar
Einlagerung;220405;MS 400;10;02.01.2025 08:30;alex;Hauptlager;Wareneingang
Entnahme;220405;MS 400;3;03.01.2025 09:15;alex;Bauer Pro;für Projekt
Einlagerung;;BX-SOL-CT-W;5;16.02.2025 10:00;alex;Hauptlager;`

let testDb: CastelDb

beforeEach(async () => {
  testDb = new CastelDb(`castel-import-${Math.random().toString(36).slice(2)}`)
  setDb(testDb)
  await testDb.delete()
  await testDb.open()
})

describe('parseCsv', () => {
  it('erkennt ";" als Trenner', () => {
    const parsed = parseCsv(LAGER_CSV)
    expect(parsed.delimiter).toBe(';')
    expect(parsed.headers).toContain('Title')
    expect(parsed.rowCount).toBe(2)
  })

  it('erkennt "," als Trenner', () => {
    const parsed = parseCsv('a,b,c\n1,2,3')
    expect(parsed.delimiter).toBe(',')
    expect(parsed.rowCount).toBe(1)
  })

  it('trimmt Zellen und entfernt Anführungszeichen', () => {
    const parsed = parseCsv('"a","b"\n" 1 "," 2 "\n"3","4"')
    expect(parsed.rows[0]?.[0]).toBe('1')
    expect(parsed.rows[0]?.[1]).toBe('2')
  })
})

describe('defaultArtikelMapping', () => {
  it('mappt SharePoint-Header auf Dexie-Felder', () => {
    const parsed = parseCsv(LAGER_CSV)
    const mapping = defaultArtikelMapping(parsed.headers)
    expect(mapping['Title']).toBe('titel')
    expect(mapping['Status']).toBe('status')
    expect(mapping['Lieferant']).toBe('lieferant')
    expect(mapping['VE']).toBe('verpackungseinheit')
    expect(mapping['Bestellnr.']).toBe('bestellnummer')
    expect(mapping['Geändert']).toBe('geaendertAm')
  })

  it('mappt Barcode-/EAN-Spalten auf das barcode-Feld', () => {
    const parsed = parseCsv('ID;Title;Barcode;EAN\n1;Foo;4006381333931;4006381333931\n')
    const mapping = defaultArtikelMapping(parsed.headers)
    expect(mapping['Barcode']).toBe('barcode')
    expect(mapping['EAN']).toBe('barcode')
  })
})

describe('defaultWarenMapping', () => {
  it('mappt Entnahme/Artikel/Menge', () => {
    const parsed = parseCsv(WAREN_CSV)
    const mapping = defaultWarenMapping(parsed.headers)
    expect(mapping['Entnahme']).toBe('typ')
    expect(mapping['Artikel']).toBe('artikelTitle')
    expect(mapping['Menge']).toBe('menge')
    expect(mapping['Projekt-AA-SA-Nummer']).toBe('projekt')
  })
})

describe('Validierung', () => {
  it('akzeptiert vollständiges Artikel-Mapping', () => {
    const parsed = parseCsv(LAGER_CSV)
    const mapping = defaultArtikelMapping(parsed.headers)
    const res = validiereArtikelMapping(mapping, parsed.rows, parsed.headers)
    expect(res.ok).toBe(true)
  })

  it('meldet fehlendes Pflichtfeld', () => {
    const parsed = parseCsv(LAGER_CSV)
    const mapping = defaultArtikelMapping(parsed.headers)
    const gebrochen: typeof mapping = { ...mapping }
    for (const k of Object.keys(gebrochen)) {
      if (gebrochen[k] === 'titel') gebrochen[k] = null
    }
    const res = validiereArtikelMapping(gebrochen, parsed.rows, parsed.headers)
    expect(res.ok).toBe(false)
    expect(res.probleme.some((p) => p.meldung.includes('titel'))).toBe(true)
  })
})

describe('importArtikelAusCsv (nur Stammdaten)', () => {
  it('legt Artikel aus der Lager-CSV an, ohne Waren-Buchungen zu erzeugen', async () => {
    const lager = parseCsv(LAGER_CSV)
    const artikelMap = defaultArtikelMapping(lager.headers)
    const bericht = await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: artikelMap,
    })
    expect(bericht.artikelAngelegt).toBe(2)
    expect(bericht.buchungenAngelegt).toBe(0)
    expect(bericht.konflikte).toEqual([])

    const artikel = await testDb.artikel.toArray()
    expect(artikel).toHaveLength(2)
    // Kein Hauptlager angelegt – das ist Aufgabe des Waren-Imports.
    expect(await testDb.standorte.toArray()).toEqual([])
    expect(await testDb.buchungen.toArray()).toEqual([])
  })

  it('uebernimmt das barcode-Feld aus der CSV', async () => {
    const csv = `ID;Title;Barcode
1;Test;4006381333931
2;OhneBarcode;
`
    const parsed = parseCsv(csv)
    const bericht = await importArtikelAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultArtikelMapping(parsed.headers),
    })
    expect(bericht.artikelAngelegt).toBe(2)
    const artikel = await testDb.artikel.toArray()
    const mit = artikel.find((a) => a.titel === 'Test')
    const ohne = artikel.find((a) => a.titel === 'OhneBarcode')
    expect(mit?.barcode).toBe('4006381333931')
    expect(ohne?.barcode).toBeNull()
  })
})

describe('importWarenAusCsv (nur Bewegungen)', () => {
  it('legt Hauptlager und Buchungen an, sofern die Artikel existieren', async () => {
    // Artikel zuerst separat anlegen.
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    // Dann Waren importieren.
    const waren = parseCsv(WAREN_CSV)
    const bericht = await importWarenAusCsv({
      rows: waren.rows,
      headers: waren.headers,
      mapping: defaultWarenMapping(waren.headers),
      hauptLagerName: 'Hauptlager',
    })
    expect(bericht.buchungenAngelegt).toBe(3)
    expect(bericht.konflikte).toEqual([])

    const standorte = await testDb.standorte.toArray()
    expect(standorte.some((s) => s.standard && s.name === 'Hauptlager')).toBe(true)
  })

  it('meldet unbekannte Artikel als Konflikt, schreibt den Rest', async () => {
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const waren = parseCsv(WAREN_CSV)
    // Eine zusätzliche Zeile mit unbekanntem Artikel.
    const plusUnbekannt = [
      ...waren.rows,
      ['Entnahme', '999', 'NICHT-VORHANDEN', '1', '03.01.2025 09:15', 'alex', 'Hauptlager', ''],
    ]
    const bericht = await importWarenAusCsv({
      rows: plusUnbekannt,
      headers: waren.headers,
      mapping: defaultWarenMapping(waren.headers),
      hauptLagerName: 'Hauptlager',
    })
    expect(bericht.buchungenAngelegt).toBe(3)
    expect(bericht.konflikte).toHaveLength(1)
    expect(bericht.konflikte[0]).toContain('NICHT-VORHANDEN')
  })
})

describe('importAusCsv (kombiniert)', () => {
  it('legt Artikel an und der Bestand ist Summe der Buchungen', async () => {
    const lager = parseCsv(LAGER_CSV)
    const waren = parseCsv(WAREN_CSV)
    const bericht = await importAusCsv({
      artikel: {
        rows: lager.rows,
        headers: lager.headers,
        mapping: defaultArtikelMapping(lager.headers),
      },
      waren: {
        rows: waren.rows,
        headers: waren.headers,
        mapping: defaultWarenMapping(waren.headers),
        hauptLagerName: 'Hauptlager',
      },
    })
    expect(bericht.artikelAngelegt).toBe(2)
    expect(bericht.buchungenAngelegt).toBe(3)
    expect(bericht.konflikte).toEqual([])

    const artikel = await testDb.artikel.toArray()
    expect(artikel).toHaveLength(2)
    const ms400 = artikel.find((a) => a.titel === 'MS 400')
    expect(ms400?.status).toBe('verfuegbar')

    if (ms400) {
      const buchungen = await testDb.buchungen.where('artikelId').equals(ms400.id).toArray()
      const summe = buchungen.filter((b) => !b.storno).reduce((s, b) => s + b.menge, 0)
      // 1 Einlagerung +10, 1 Entnahme -3 = 7.
      expect(summe).toBe(7)
    }

    const standorte = await testDb.standorte.toArray()
    expect(standorte.some((s) => s.standard && s.name === 'Hauptlager')).toBe(true)
  })

  it('akzeptiert leere Eingabe und liefert leeren Bericht', async () => {
    const bericht = await importAusCsv({})
    expect(bericht).toEqual({ artikelAngelegt: 0, buchungenAngelegt: 0, konflikte: [] })
  })
})
