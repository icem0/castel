// Tests for the Akkutausch device CSV import.

import { beforeEach, describe, expect, it } from 'vitest'
import { CastelDb, setDb } from '../../../db/database'
import { parseCsv } from '../csv-parser'
import {
  defaultNetzteilMapping,
  normalisierterText,
  parseNetzteilDatum,
  parseIntervallJahre,
} from '../netzteil-mapping'
import {
  bereiteNetzteilCsvAuf,
  importNetzteileAusCsv,
  pruefeNetzteilImport,
} from '../netzteil-import'

const NETZTEILE_CSV = `Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit
10020_02;OKA - Orthopädische Kinderklinik Aschau;83229;10020 OKA;3. Neubau 1.UG Heim;;2;2.5;01/1990;4 Jahre;01/1994
14082_02;Wohnhaus Friedrich-Ebert-Str. 8;83059;14082 Fritz Hartinger;Zentrale;;2;1.2;01/2021;4 Jahre;01/2025`

let testDb: CastelDb

beforeEach(async () => {
  testDb = new CastelDb(`castel-netzteil-import-${Math.random().toString(36).slice(2)}`)
  setDb(testDb)
  await testDb.delete()
  await testDb.open()
})

describe('Netzteil CSV helpers', () => {
  it('normalizes month-year dates to the first day of the month', () => {
    expect(parseNetzteilDatum('01/1990')).toBe('1990-01-01')
    expect(parseNetzteilDatum('12/2021')).toBe('2021-12-01')
    expect(parseNetzteilDatum('01.02.2025')).toBe('2025-02-01')
  })

  it('parses interval text into years', () => {
    expect(parseIntervallJahre('4 Jahre')).toBe(4)
    expect(parseIntervallJahre('12 Monate')).toBe(1)
    expect(parseIntervallJahre('3')).toBe(3)
    expect(parseIntervallJahre('')).toBeNull()
  })

  it('maps the supplied German CSV headers to device fields', () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const mapping = defaultNetzteilMapping(parsed.headers)

    expect(mapping['Anlage']).toBe('anlage')
    expect(mapping['Firma']).toBe('objekt')
    expect(mapping['Name']).toBe('name')
    expect(mapping['Anzahl']).toBe('anzahl')
    expect(mapping['Kapazität']).toBe('kapazitaetAh')
    expect(mapping['Einbaudatum']).toBe('einbaudatum')
    expect(mapping['Austauschintervall']).toBe('intervallJahre')
    expect(mapping['Fälligkeit']).toBe('faelligkeit')
  })

  it('removes empty punctuation-only optional values', () => {
    expect(normalisierterText('---')).toBeNull()
    expect(normalisierterText('10020 OKA')).toBe('10020 OKA')
  })
})

describe('bereiteNetzteilCsvAuf', () => {
  it('repairs a header line with the first data row glued to it', () => {
    const csv = `Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit10020_02;OKA - Klinik;83229;10020 OKA;3. Neubau;;2;2.5;01/1990;4 Jahre;01/1994
14082_02;Wohnhaus Friedrich-Ebert-Str. 8;83059;14082 Fritz Hartinger;Zentrale;;2;1.2;01/2021;4 Jahre;01/2025`
    const parsed = parseCsv(csv)

    const daten = bereiteNetzteilCsvAuf(parsed.headers, parsed.rows)

    expect(daten.headers).toHaveLength(11)
    expect(daten.headers[10]).toBe('Fälligkeit')
    expect(daten.rows).toHaveLength(2)
    expect(daten.rows[0]?.[0]).toBe('10020_02')
    expect(daten.rows[0]?.[7]).toBe('2.5')
    expect(daten.zeilenOffset).toBe(1)
    expect(daten.hinweis).not.toBeNull()
  })

  it('leaves a well-formed CSV untouched', () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const daten = bereiteNetzteilCsvAuf(parsed.headers, parsed.rows)

    expect(daten.headers).toEqual(parsed.headers)
    expect(daten.rows).toEqual(parsed.rows)
    expect(daten.zeilenOffset).toBe(0)
    expect(daten.hinweis).toBeNull()
  })
})

describe('pruefeNetzteilImport', () => {
  it('accepts the known CSV shape', () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(true)
    expect(result.importierbar).toBe(2)
    expect(result.uebersprungen).toBe(0)
  })

  it('skips rows without capacity instead of aborting the import', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;2;1.2;01/2021;4 Jahre
B;Objekt;Ohne Akku;2;;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(true)
    expect(result.importierbar).toBe(1)
    expect(result.uebersprungen).toBe(1)
    expect(result.befunde.some((b) => b.art === 'uebersprungen')).toBe(true)
  })

  it('skips rows without a company (object)', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;;Gerät;2;1.2;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.importierbar).toBe(0)
    expect(result.uebersprungen).toBe(1)
  })

  it('assumes a count of 1 when the column is empty', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;;1.2;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.importierbar).toBe(1)
    expect(result.befunde.some((b) => b.meldung.includes('1 angenommen'))).toBe(true)
  })

  it('merges duplicated devices instead of failing', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;2;1.2;01/2021;4 Jahre
A;Objekt;Gerät;3;1.2;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(true)
    expect(result.importierbar).toBe(1)
    expect(result.uebersprungen).toBe(0)
    expect(result.befunde.some((b) => b.meldung.includes('gleiche Identität'))).toBe(true)
  })

  it('repairs a row with an unescaped semicolon inside a text field', () => {
    const csv = `Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit
10020_02;Elektro Hartinger und Sohn GmbH &amp; Co. KG;83259;14082 Fritz Hartinger;Zentrale;;2;1.2;01/2021;4 Jahre;01/2025`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.importierbar).toBe(1)
    expect(result.uebersprungen).toBe(0)
    expect(result.befunde.some((b) => b.art === 'repariert')).toBe(true)
  })

  it('reports rows whose column count cannot be repaired', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;2;1.2;01/2021;4 Jahre;überzählig;noch mehr
B;Objekt;Gerät 2;2;1.2;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.importierbar).toBe(1)
    expect(result.uebersprungen).toBe(1)
  })
})

describe('importNetzteileAusCsv', () => {
  it('imports a realistic excerpt of the device list without findings', () => {
    const csv = `Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit
10020_02;OKA - Orthopädische Kinderklinik Aschau;83229;10020 OKA;3. Neubau 1.UG Heim;;2;2.5;01/1990;4 Jahre;01/1994
14082_02;Wohnhaus Friedrich-Ebert-Str. 8;83059;14082 Fritz Hartinger;Zentrale;;2;1.2;01/2021;4 Jahre;01/2025
10932_02;Alpenpark Klinik;83707;10932 Kirinius Alpenpark;Defregger Haus 2.OG (TRH Luke);;2;1.2;05/2021;4 Jahre;05/2025
17564_02;VR-Bankgebäude Prien;83209;17564 VR Bank Ro;Zentrale 3;;2;2.3;05/2021;4 Jahre;05/2025
14914_02;ROS Büros;;14914 Werndl & Partner BWB Areal GmbH & Co. KG;Zentrale 4;;2;7.2;07/2021;4 Jahre;07/2025
10270_02;Caritas Altenheim St. Franziskus;83059;10270 Caritas München;3.OG Nebentreppenhaus;;2;1.2;08/2021;4 Jahre;08/2025
12709_06;Katharinenheim - Haus Sinnesgarten;83101;12709 Katharinenheim;Stromversorgung Zentrale / Station;;6;9;09/2021;4 Jahre;09/2025
15318_01;WEG Conradtystr. 5+6;83059;15318 WEG Y3;Aufzugsschacht;;2;1.2;10/2021;4 Jahre;10/2025`
    const parsed = parseCsv(csv)
    const pruefung = pruefeNetzteilImport(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(pruefung.ok).toBe(true)
    expect(pruefung.importierbar).toBe(8)
    expect(pruefung.uebersprungen).toBe(0)
    expect(pruefung.befunde).toEqual([])
  })

  it('creates devices and queues outbox ops', async () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const bericht = await importNetzteileAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultNetzteilMapping(parsed.headers),
    })

    expect(bericht.netzteilAngelegt).toBe(2)
    expect(bericht.netzteilAktualisiert).toBe(0)
    expect(bericht.uebersprungeneZeilen).toBe(0)

    const netzteile = await testDb.akkuNetzteile.toArray()
    expect(netzteile).toHaveLength(2)

    const oka = netzteile.find((n) => n.name === '3. Neubau 1.UG Heim')
    expect(oka?.anlage).toBe('10020_02')
    expect(oka?.objekt).toBe('OKA - Orthopädische Kinderklinik Aschau')
    expect(oka?.gruppe).toBe('10020 OKA')
    expect(oka?.einbaudatum).toBe('1990-01-01')
    expect(oka?.intervallJahre).toBe(4)
    expect(oka?.kapazitaetAh).toBe(2.5)
    expect(oka?.anzahl).toBe(2)

    const outbox = await testDb.outbox.toArray()
    const ops = outbox.filter((o) => o.entity === 'akku_netzteil' && o.op === 'create')
    expect(ops).toHaveLength(2)
    expect(ops.every((o) => o.syncedAt === null)).toBe(true)
  })

  it('imports the valid rows of a mixed file and reports the rest', async () => {
    const csv = `Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit
10020_02;OKA - Klinik;83229;10020 OKA;3. Neubau;;2;2.5;01/1990;4 Jahre;01/1994
10021_02;Ohne Akku;83229;10021 OKA;Zentrale;;2;;01/2021;4 Jahre;01/2025
10022_02;Elektro Hartinger und Sohn GmbH &amp; Co. KG;83259;14082 Fritz Hartinger;Zentrale;;2;1.2;01/2021;4 Jahre;01/2025`
    const parsed = parseCsv(csv)
    const bericht = await importNetzteileAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultNetzteilMapping(parsed.headers),
    })

    expect(bericht.netzteilAngelegt).toBe(2)
    expect(bericht.uebersprungeneZeilen).toBe(1)
    expect(bericht.reparierteZeilen).toBe(1)

    const netzteile = await testDb.akkuNetzteile.toArray()
    expect(netzteile).toHaveLength(2)
    const hartinger = netzteile.find((n) => n.anlage === '10022_02')
    expect(hartinger?.objekt).toBe('Elektro Hartinger und Sohn GmbH & Co. KG')
    expect(hartinger?.kapazitaetAh).toBe(1.2)
  })

  it('does not duplicate rows on a second identical import', async () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const mapping = defaultNetzteilMapping(parsed.headers)

    await importNetzteileAusCsv({ rows: parsed.rows, headers: parsed.headers, mapping })
    const zweiter = await importNetzteileAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping,
    })

    expect(zweiter.netzteilAngelegt).toBe(0)
    expect(zweiter.netzteilAktualisiert).toBe(0)
    expect(zweiter.netzteilUebersprungen).toBe(2)
    expect(await testDb.akkuNetzteile.count()).toBe(2)

    const outbox = await testDb.outbox.toArray()
    expect(outbox.filter((o) => o.entity === 'akku_netzteil' && o.op === 'create')).toHaveLength(2)
  })

  it('updates an existing device by natural key', async () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    await importNetzteileAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultNetzteilMapping(parsed.headers),
    })
    const before = await testDb.akkuNetzteile.where('anlage').equals('10020_02').first()

    const updatedCsv = NETZTEILE_CSV.replace(';2;2.5;01/1990;', ';3;2.8;01/1990;')
    const updated = parseCsv(updatedCsv)
    const bericht = await importNetzteileAusCsv({
      rows: updated.rows,
      headers: updated.headers,
      mapping: defaultNetzteilMapping(updated.headers),
    })

    expect(bericht.netzteilAktualisiert).toBe(1)
    expect(bericht.netzteilAngelegt).toBe(0)
    expect(await testDb.akkuNetzteile.count()).toBe(2)

    const after = await testDb.akkuNetzteile.get(before?.id ?? '')
    expect(after?.anzahl).toBe(3)
    expect(after?.kapazitaetAh).toBe(2.8)

    const outbox = await testDb.outbox.toArray()
    expect(outbox.filter((o) => o.entity === 'akku_netzteil' && o.op === 'update')).toHaveLength(1)
  })
})
