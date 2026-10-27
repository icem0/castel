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
import { importNetzteileAusCsv, validiereNetzteilDaten } from '../netzteil-import'

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

describe('validiereNetzteilDaten', () => {
  it('accepts the known CSV shape', () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const result = validiereNetzteilDaten(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(true)
    expect(result.probleme).toEqual([])
  })

  it('rejects an invalid installation date before importing', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;2;1.2;unknown;4 Jahre`
    const parsed = parseCsv(csv)
    const result = validiereNetzteilDaten(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(false)
    expect(result.probleme.some((p) => p.meldung.includes('einbaudatum'))).toBe(true)
  })

  it('rejects duplicate natural keys inside one CSV file', () => {
    const csv = `Anlage;Firma;Name;Anzahl;Kapazität;Einbaudatum;Austauschintervall
A;Objekt;Gerät;2;1.2;01/2021;4 Jahre
A;Objekt;Gerät;3;1.2;01/2021;4 Jahre`
    const parsed = parseCsv(csv)
    const result = validiereNetzteilDaten(
      defaultNetzteilMapping(parsed.headers),
      parsed.rows,
      parsed.headers,
    )

    expect(result.ok).toBe(false)
    expect(result.probleme.some((p) => p.meldung.includes('doppelte'))).toBe(true)
  })
})

describe('importNetzteileAusCsv', () => {
  it('creates devices and queues outbox ops', async () => {
    const parsed = parseCsv(NETZTEILE_CSV)
    const bericht = await importNetzteileAusCsv({
      rows: parsed.rows,
      headers: parsed.headers,
      mapping: defaultNetzteilMapping(parsed.headers),
    })

    expect(bericht.netzteilAngelegt).toBe(2)
    expect(bericht.netzteilAktualisiert).toBe(0)

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
