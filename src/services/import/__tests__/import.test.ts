// Tests für den CSV-Import-Pfad.

import { beforeEach, describe, expect, it } from 'vitest'
import { CastelDb, setDb } from '../../../db/database'
import type {
  Artikel,
  AuditLogEintrag,
  Buchung,
  Einstellung,
  Projekt,
  Standort,
} from '../../../db/types'
import { jetztIso, neueUuid } from '../../../domain/ids'
import { parseCsv } from '../csv-parser'
import { defaultArtikelMapping, defaultWarenMapping, parseIsoDatum } from '../mapping'
import { validiereArtikelMapping, validiereArtikelDaten, validiereWarenDaten } from '../validierung'
import { ImportValidierungError } from '../../../domain/errors'
import { importArtikelAusCsv, importAusCsv, importWarenAusCsv } from '../import'
import { exportVollBackup, backupAlsText, restoreBackup, type Backup } from '../export'

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

describe('parseIsoDatum', () => {
  it('akzeptiert ISO-Strings (mit und ohne Zeit)', () => {
    expect(parseIsoDatum('2025-01-15T10:00:00Z')).toBe('2025-01-15T10:00:00.000Z')
    expect(parseIsoDatum('2025-01-15')).toBe('2025-01-15T00:00:00.000Z')
  })

  it('akzeptiert deutsches DD.MM.YYYY', () => {
    // Der exakte UTC-Wert haengt von der Test-Laufzeit-TZ ab (CET
    // vs CEST). Wir vergleichen deshalb den per `new Date(...,
    // local-args)`-Konstruktion des gleichen Datums — der
    // `parseIsoDatum`-Wert muss identisch sein, was die Logik unab-
    // haengig von der Testmaschine pruefbar macht.
    const expected = new Date(2025, 1, 15).toISOString()
    expect(parseIsoDatum('15.02.2025')).toBe(expected)
  })

  it('akzeptiert deutsches DD.MM.YYYY HH:mm', () => {
    const expected = new Date(2025, 1, 15, 10, 30).toISOString()
    expect(parseIsoDatum('15.02.2025 10:30')).toBe(expected)
  })

  it('liefert null fuer leeren oder unparsebaren Input', () => {
    expect(parseIsoDatum('')).toBeNull()
    expect(parseIsoDatum('   ')).toBeNull()
    expect(parseIsoDatum('kein datum')).toBeNull()
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
    expect(mapping['Projekt-AA-SA-Nummer']).toBe('commission')
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

  it('uebernimmt das projekt-Feld aus der commission-Spalte', async () => {
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const waren = parseCsv(WAREN_CSV)
    const bericht = await importWarenAusCsv({
      rows: waren.rows,
      headers: waren.headers,
      mapping: defaultWarenMapping(waren.headers),
      hauptLagerName: 'Hauptlager',
    })
    expect(bericht.buchungenAngelegt).toBe(3)
    const buchungen = await testDb.buchungen.toArray()
    const ms400MitProjekt = buchungen.find((b) => b.projekt === '220405' && b.typ === 'entnahme')
    expect(ms400MitProjekt).toBeDefined()
  })

  it('lehnt Dezimalmengen als Validierungsfehler ab (Pre-Flight blockt den ganzen Import)', async () => {
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const csv = `Entnahme;Projekt-AA-SA-Nummer;Artikel;Menge;Erstellt;Erstellt-von;Entnommen aus;Kommentar
Einlagerung;;MS 400;2,5;02.01.2025 08:30;alex;Hauptlager;dezimal`
    const waren = parseCsv(csv)
    await expect(
      importWarenAusCsv({
        rows: waren.rows,
        headers: waren.headers,
        mapping: defaultWarenMapping(waren.headers),
        hauptLagerName: 'Hauptlager',
      }),
    ).rejects.toBeInstanceOf(ImportValidierungError)
    expect(await testDb.buchungen.toArray()).toHaveLength(0)
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

describe('Outbox-Integration', () => {
  it('importArtikelAusCsv enqueued jeden neuen Artikel als create-Op', async () => {
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const outbox = await testDb.outbox.toArray()
    const artikelOps = outbox.filter((o) => o.entity === 'artikel' && o.op === 'create')
    expect(artikelOps).toHaveLength(2)
    expect(artikelOps.every((o) => o.syncedAt === null)).toBe(true)
    const payloads = artikelOps.map((o) => JSON.parse(o.payload) as { titel: string })
    expect(payloads.map((p) => p.titel).sort()).toEqual(['BX-SOL-CT-W', 'MS 400'])
  })

  it('importWarenAusCsv enqueued Buchungen und das Hauptlager', async () => {
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const waren = parseCsv(WAREN_CSV)
    await importWarenAusCsv({
      rows: waren.rows,
      headers: waren.headers,
      mapping: defaultWarenMapping(waren.headers),
      hauptLagerName: 'Hauptlager',
    })
    const outbox = await testDb.outbox.toArray()
    const buchungOps = outbox.filter((o) => o.entity === 'buchung' && o.op === 'create')
    expect(buchungOps).toHaveLength(3)
    const standortOps = outbox.filter((o) => o.entity === 'standort' && o.op === 'create')
    expect(standortOps).toHaveLength(1)
    const standortPayload = JSON.parse(standortOps[0]!.payload) as {
      name: string
      standard: boolean
    }
    expect(standortPayload.name).toBe('Hauptlager')
    expect(standortPayload.standard).toBe(true)
  })

  it('zweiter Waren-Import findet das Hauptlager und enqueued nur ein update', async () => {
    // Erstes Hauptlager manuell anlegen (nicht standard).
    const s: Standort = {
      id: neueUuid(),
      name: 'Hauptlager',
      typ: 'lager',
      projekt: null,
      kennzeichen: null,
      standard: false,
      archiviert: false,
      geaendertAm: jetztIso(),
      erstelltAm: jetztIso(),
    }
    await testDb.standorte.add(s)
    // Outbox leeren, damit nur die Import-Outbox-Items gezaehlt werden.
    await testDb.outbox.clear()

    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    const waren = parseCsv(WAREN_CSV)
    await importWarenAusCsv({
      rows: waren.rows,
      headers: waren.headers,
      mapping: defaultWarenMapping(waren.headers),
      hauptLagerName: 'Hauptlager',
    })

    const outbox = await testDb.outbox.toArray()
    const standortCreates = outbox.filter((o) => o.entity === 'standort' && o.op === 'create')
    const standortUpdates = outbox.filter((o) => o.entity === 'standort' && o.op === 'update')
    expect(standortCreates).toHaveLength(0)
    expect(standortUpdates).toHaveLength(1)
    const refreshed = await testDb.standorte.get(s.id)
    expect(refreshed?.standard).toBe(true)
  })

  it('geaendertAm fällt auf erstelltAm zurück, wenn die CSV-Spalte fehlt oder leer ist', async () => {
    // Regression: Server-Schema verlangt `geaendertAm: string` (kein null).
    // Wenn die Geändert-Spalte fehlt, konnte der Import `null` in den
    // Outbox-Payload schreiben — der Push brach mit VALIDATION ab.
    const csv = `ID;Title;Status;Type;Lieferant;VE
1;Ohne Geaendert-Spalte;verfügbar;Demo;Bosch;1
2;Mit leerer Geaendert-Spalte;verfügbar;Demo;Bosch;1;`
    const parsed = parseCsv(csv)
    const before = jetztIso()
    await importArtikelAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultArtikelMapping(parsed.headers),
    })
    const after = jetztIso()

    const outbox = await testDb.outbox.toArray()
    const artikelOps = outbox.filter((o) => o.entity === 'artikel' && o.op === 'create')
    expect(artikelOps).toHaveLength(2)
    for (const op of artikelOps) {
      const payload = JSON.parse(op.payload) as { geaendertAm: string; erstelltAm: string }
      expect(typeof payload.geaendertAm).toBe('string')
      // Fallback muss zwischen before/after liegen (= erstelltAm).
      expect(payload.geaendertAm >= before).toBe(true)
      expect(payload.geaendertAm <= after).toBe(true)
      expect(payload.geaendertAm).toBe(payload.erstelltAm)
    }
  })
})

describe('Dezimalwerte in Stammdaten', () => {
  it('parst mindestbestand und listenpreis als int (Dezimal -> null)', async () => {
    const csv = `ID;Title;Bestand-min;Listenpreis
1;Mit Komma;2,5;12,99
2;Ganzzahlig;20;459
3;Mit Tausender;1.234;1.299,00
4;Leer;;
`
    const parsed = parseCsv(csv)
    await importArtikelAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultArtikelMapping(parsed.headers),
    })
    const artikel = await testDb.artikel.toArray()
    const mitKomma = artikel.find((a) => a.titel === 'Mit Komma')
    expect(mitKomma?.mindestbestand).toBeNull()
    expect(mitKomma?.listenpreis).toBeNull()
    const ganzzahlig = artikel.find((a) => a.titel === 'Ganzzahlig')
    expect(ganzzahlig?.mindestbestand).toBe(20)
    expect(ganzzahlig?.listenpreis).toBe(459)
    const mitTausender = artikel.find((a) => a.titel === 'Mit Tausender')
    expect(mitTausender?.mindestbestand).toBe(1234)
    expect(mitTausender?.listenpreis).toBe(1299)
    const leer = artikel.find((a) => a.titel === 'Leer')
    expect(leer?.mindestbestand).toBeNull()
    expect(leer?.listenpreis).toBeNull()
  })
})

describe('exportVollBackup / restoreBackup', () => {
  const artikel: Artikel = {
    id: 'a1',
    sharePointId: 1,
    foto: null,
    fotoUrls: [],
    titel: 'MS 400',
    status: 'verfuegbar',
    typ: 'Alarmierung',
    lieferant: 'Bosch',
    verpackungseinheit: 1,
    mindestbestand: 20,
    nachbestellHinweis: 'bald',
    bestellnummer: 'MS400',
    barcode: '4006381333931',
    listenpreis: 1299,
    geaendertAm: '2025-01-01T08:00:00Z',
    erstelltAm: '2025-01-01T08:00:00Z',
  }
  const standort: Standort = {
    id: 's1',
    name: 'Hauptlager',
    typ: 'lager',
    kennzeichen: null,
    projekt: null,
    standard: true,
    archiviert: false,
    geaendertAm: '2025-01-01T08:00:00Z',
    erstelltAm: '2025-01-01T08:00:00Z',
  }
  const buchung: Buchung = {
    id: 'b1',
    artikelId: 'a1',
    standortId: 's1',
    standortZielId: null,
    typ: 'einlagerung',
    menge: 10,
    paarId: null,
    projekt: null,
    erstelltAm: '2025-01-02T08:00:00Z',
    clientEingabeAm: '2025-01-02T08:00:00Z',
    erstelltVon: 'test',
    kommentar: null,
    mitteilungAn: null,
    storno: false,
    stornoVon: null,
    storniertDurch: null,
    serverId: null,
  }
  const projekt: Projekt = {
    id: 'p1',
    nummer: 'P-1',
    name: null,
    archiviert: false,
    geaendertAm: null,
    erstelltAm: '2025-01-01T08:00:00Z',
  }
  const einstellung: Einstellung = {
    key: 'sprache',
    userId: '',
    value: 'de-DE',
    geaendertAm: '2025-01-01T08:00:00Z',
  }
  const audit: AuditLogEintrag = {
    id: 'l1',
    aktion: 'test',
    entitaet: 'artikel',
    entitaetId: 'a1',
    daten: '{}',
    zeit: '2025-01-01T08:00:00Z',
  }

  const backup: Backup = {
    schema: 'castel-backup-1',
    exportiertAm: '2025-01-01T00:00:00Z',
    artikel: [artikel],
    standorte: [standort],
    buchungen: [buchung],
    commission: [projekt],
    einstellungen: [einstellung],
    auditLog: [audit],
  }

  it('exportVollBackup liefert alle Tabellen mit korrektem Schema', async () => {
    await testDb.artikel.add(artikel)
    await testDb.standorte.add(standort)
    await testDb.buchungen.add(buchung)
    await testDb.commission.add(projekt)
    await testDb.einstellungen.add(einstellung)
    await testDb.auditLog.add(audit)

    const exp = await exportVollBackup()
    expect(exp.schema).toBe('castel-backup-1')
    expect(exp.artikel).toHaveLength(1)
    expect(exp.standorte).toHaveLength(1)
    expect(exp.buchungen).toHaveLength(1)
    expect(exp.commission).toHaveLength(1)
    expect(exp.einstellungen).toHaveLength(1)
    expect(exp.auditLog).toHaveLength(1)
    expect(typeof exp.exportiertAm).toBe('string')
  })

  it('backupAlsText erzeugt parsebares JSON', () => {
    const text = backupAlsText(backup)
    const parsed = JSON.parse(text) as Backup
    expect(parsed.schema).toBe('castel-backup-1')
    expect(parsed.artikel[0]!.titel).toBe('MS 400')
  })

  it('restoreBackup ersetzt alle Daten transaktional', async () => {
    // Altbestand anlegen, der überschrieben werden soll.
    await testDb.artikel.add({ ...artikel, titel: 'ALT' })
    await testDb.standorte.add({ ...standort, name: 'ALT' })

    await restoreBackup(backup)

    const artikelNachher = await testDb.artikel.toArray()
    expect(artikelNachher).toHaveLength(1)
    expect(artikelNachher[0]!.titel).toBe('MS 400')

    const standorteNachher = await testDb.standorte.toArray()
    expect(standorteNachher).toHaveLength(1)
    expect(standorteNachher[0]!.name).toBe('Hauptlager')

    const buchungenNachher = await testDb.buchungen.toArray()
    expect(buchungenNachher).toHaveLength(1)
    expect(buchungenNachher[0]!.menge).toBe(10)
  })

  it('restoreBackup wirft bei unbekanntem Schema', async () => {
    await expect(
      restoreBackup({ ...backup, schema: 'castel-backup-99' } as Backup),
    ).rejects.toThrow(/Unbekanntes Backup-Schema/)
  })
})

// ---------- Daten-Validierung (Pre-Flight pro Zeile) ----------
//
// Spiegel der Server-Schema-Anforderungen: liefert die CSV Werte, die
// der Push-Schema ablehnen wuerde, schlaegt die Validierung an, BEVOR
// wir in die Dexie-Transaktion gehen. Verhindert genau den Push-400,
// der durch `geaendertAm: null` oder Dezimalmengen ausgeloest wird.

describe('validiereArtikelDaten', () => {
  it('meldet unbekannten status-Wert pro Zeile', () => {
    const csv = `Title;Type;Status
A;Demo;verfuegbar
B;Demo;kaputt
C;Demo;reserviert
`
    const parsed = parseCsv(csv)
    const r = validiereArtikelDaten(
      defaultArtikelMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )
    expect(r.ok).toBe(false)
    expect(r.probleme).toHaveLength(1)
    expect(r.probleme[0]?.meldung).toContain('"kaputt"')
    expect(r.probleme[0]?.meldung).toContain('Zeile 3')
  })

  it('meldet nicht-parsebares geaendertAm nur, wenn die Spalte gemappt ist', () => {
    const csv = `Title;Type;Geändert
A;Demo;kein datum
B;Demo;01.02.2025
`
    const parsed = parseCsv(csv)
    const r = validiereArtikelDaten(
      defaultArtikelMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )
    expect(r.ok).toBe(false)
    expect(r.probleme[0]?.meldung).toContain('kein datum')
  })

  it('meldet verpackungseinheit = 0 oder negativ', () => {
    const csv = `Title;Type;VE
A;Demo;0
B;Demo;-3
C;Demo;1
`
    const parsed = parseCsv(csv)
    const r = validiereArtikelDaten(
      defaultArtikelMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )
    expect(r.ok).toBe(false)
    expect(r.probleme).toHaveLength(2)
    expect(r.probleme[0]?.meldung).toContain('muss > 0')
  })

  it('ist ok, wenn die problematischen Spalten gar nicht gemappt sind', () => {
    // CSV ohne Geaendert-Spalte: das ist der Normalfall, wenn der
    // SharePoint-Export die Spalte weggelassen hat. Pre-Flight soll
    // NICHT meckern — der Import faellt auf erstelltAm zurueck.
    const csv = `Title;Type
A;Demo
`
    const parsed = parseCsv(csv)
    const r = validiereArtikelDaten(
      defaultArtikelMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )
    expect(r.ok).toBe(true)
  })
})

describe('validiereWarenDaten', () => {
  it('meldet Dezimalmengen und Null', () => {
    const csv = `Entnahme;Artikel;Menge
Einlagerung;MS 400;2,5
Einlagerung;MS 400;0
`
    const parsed = parseCsv(csv)
    const r = validiereWarenDaten(defaultWarenMapping(parsed.headers), parsed.rows, parsed.headers)
    expect(r.ok).toBe(false)
    expect(r.probleme.some((p) => p.meldung.includes('2,5'))).toBe(true)
    expect(r.probleme.some((p) => p.meldung.includes('darf nicht 0'))).toBe(true)
  })

  it('meldet unbekannten Buchungstyp', () => {
    const csv = `Entnahme;Artikel;Menge
Verkauf;MS 400;1
`
    const parsed = parseCsv(csv)
    const r = validiereWarenDaten(defaultWarenMapping(parsed.headers), parsed.rows, parsed.headers)
    expect(r.ok).toBe(false)
    expect(r.probleme[0]?.meldung).toContain('Verkauf')
  })

  it('meldet nicht-parsebares erstelltAm', () => {
    const csv = `Entnahme;Artikel;Menge;Erstellt
Entnahme;MS 400;1;kein datum
`
    const parsed = parseCsv(csv)
    const r = validiereWarenDaten(defaultWarenMapping(parsed.headers), parsed.rows, parsed.headers)
    expect(r.ok).toBe(false)
    expect(r.probleme[0]?.meldung).toContain('erstelltAm')
  })
})

describe('Import wirft ImportValidierungError bei Daten-Problemen', () => {
  it('importArtikelAusCsv: abgebrochen, kein Artikel in DB, Outbox leer', async () => {
    const csv = `Title;Type;Status
A;Demo;quatsch
B;Demo;reserviert
`
    const parsed = parseCsv(csv)
    await expect(
      importArtikelAusCsv({
        rows: parsed.rows,
        headers: parsed.headers,
        mapping: defaultArtikelMapping(parsed.headers),
      }),
    ).rejects.toBeInstanceOf(ImportValidierungError)
    expect(await testDb.artikel.toArray()).toEqual([])
    expect(await testDb.outbox.toArray()).toEqual([])
  })

  it('importWarenAusCsv: abgebrochen bei Dezimalmenge, keine Buchung geschrieben', async () => {
    // Erst Artikel anlegen — ohne Pre-Flight-Blocker.
    const lager = parseCsv(LAGER_CSV)
    await importArtikelAusCsv({
      rows: lager.rows,
      headers: lager.headers,
      mapping: defaultArtikelMapping(lager.headers),
    })
    // Outbox leeren, damit nur die Waren-Import-Outbox-Items geprueft
    // werden — die zwei Artikel-Items aus dem Pre-Step sollen hier
    // nicht stören.
    await testDb.outbox.clear()

    const csv = `Entnahme;Artikel;Menge
Entnahme;MS 400;3,5
`
    const parsed = parseCsv(csv)
    await expect(
      importWarenAusCsv({
        rows: parsed.rows,
        headers: parsed.headers,
        mapping: defaultWarenMapping(parsed.headers),
        hauptLagerName: 'Hauptlager',
      }),
    ).rejects.toBeInstanceOf(ImportValidierungError)
    // Wichtig: kein Hauptlager, keine Buchung, kein Outbox-Item. Vorher
    // (ohne Pre-Flight) hatte `stelleHauptLagerSicher` schon im Outbox
    // gelandet, BEVOR die Validierung lief — der Outbox-Standort-Op
    // blieb dann als Geist zurueck, obwohl der eigentliche Import
    // fehlschlug. Pre-Flight loest das, weil die Transaktion NIE startet.
    expect(await testDb.buchungen.toArray()).toEqual([])
    expect(await testDb.standorte.toArray()).toEqual([])
    expect(await testDb.outbox.toArray()).toEqual([])
  })

  it('ImportValidierungError enthaelt die Problemliste', async () => {
    const csv = `Title;Type;Status
A;Demo;quatsch
B;Demo;Mist
`
    const parsed = parseCsv(csv)
    try {
      await importArtikelAusCsv({
        rows: parsed.rows,
        headers: parsed.headers,
        mapping: defaultArtikelMapping(parsed.headers),
      })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ImportValidierungError)
      const err = e as ImportValidierungError
      expect(err.probleme).toHaveLength(2)
      expect(err.probleme[0]?.zeile).toBe(0)
      expect(err.probleme[0]?.meldung).toContain('Zeile 2')
    }
  })
})
