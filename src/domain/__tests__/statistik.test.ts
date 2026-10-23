import { describe, expect, it } from 'vitest'
import type { Artikel, Buchung, BuchungsTyp, Standort } from '../../db/types'
import {
  berechneKpis,
  bestandGesamt,
  bestandProStandort,
  bewegungenProZeitraum,
  handlungsbedarf,
  lagerwertAuswertung,
  letzteBuchungen,
  topArtikelNachBewegung,
} from '../statistik'

function artikel(overrides: Partial<Artikel> & { id: string }): Artikel {
  return {
    id: overrides.id,
    sharePointId: null,
    titel: overrides.titel ?? overrides.id,
    status: overrides.status ?? 'verfuegbar',
    typ: overrides.typ ?? '',
    lieferant: null,
    verpackungseinheit: overrides.verpackungseinheit ?? 1,
    mindestbestand: overrides.mindestbestand ?? null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: false,
    listenpreis: null,
    einkaufspreis: overrides.einkaufspreis ?? null,
    geaendertAm: null,
    erstelltAm: '2026-01-01T00:00:00.000Z',
  }
}

function buchung(
  overrides: Partial<Buchung> & {
    id: string
    artikelId: string
    standortId: string
    menge: number
    typ: BuchungsTyp
    erstelltAm: string
  },
): Buchung {
  return {
    id: overrides.id,
    artikelId: overrides.artikelId,
    standortId: overrides.standortId,
    standortZielId: overrides.standortZielId ?? null,
    typ: overrides.typ,
    menge: overrides.menge,
    paarId: overrides.paarId ?? null,
    projekt: null,
    erstelltAm: overrides.erstelltAm,
    clientEingabeAm: overrides.erstelltAm,
    erstelltVon: 'tester',
    kommentar: null,
    mitteilungAn: null,
    stornoVon: null,
    storno: overrides.storno ?? false,
    storniertDurch: null,
    serverId: null,
  }
}

function standort(id: string, name: string, archiviert = false): Standort {
  return {
    id,
    name,
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard: false,
    archiviert,
    geaendertAm: null,
    erstelltAm: '2026-01-01T00:00:00.000Z',
  }
}

describe('statistik', () => {
  it('sums active bookings and ignores storno', () => {
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 10,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
      buchung({
        id: '2',
        artikelId: 'a',
        standortId: 's',
        menge: -3,
        typ: 'entnahme',
        erstelltAm: '2026-05-01T11:00:00.000Z',
      }),
      buchung({
        id: '3',
        artikelId: 'a',
        standortId: 's',
        menge: 99,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T12:00:00.000Z',
        storno: true,
      }),
    ]
    expect(bestandGesamt(rows)).toBe(7)
  })

  it('nets umlagerung to zero globally and keeps per-location balances', () => {
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 'lager',
        menge: -4,
        typ: 'umlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
        standortZielId: 'auto',
      }),
      buchung({
        id: '2',
        artikelId: 'a',
        standortId: 'auto',
        menge: 4,
        typ: 'umlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
    ]
    expect(bestandGesamt(rows)).toBe(0)
    const proStandort = bestandProStandort(rows, [
      standort('lager', 'Lager'),
      standort('auto', 'Auto'),
    ])
    expect(proStandort).toEqual([
      { standortId: 'auto', name: 'Auto', menge: 4 },
      { standortId: 'lager', name: 'Lager', menge: -4 },
    ])
  })

  it('detects negative stock and stock below minimum per location', () => {
    const artikelRows = [
      artikel({ id: 'a', titel: 'A', mindestbestand: 5 }),
      artikel({ id: 'b', titel: 'B', mindestbestand: null }),
      artikel({ id: 'c', titel: 'C', mindestbestand: 2, status: 'archiviert' }),
    ]
    const standorte = [standort('s', 'Hauptlager')]
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 2,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
      buchung({
        id: '2',
        artikelId: 'b',
        standortId: 's',
        menge: -1,
        typ: 'entnahme',
        erstelltAm: '2026-05-01T11:00:00.000Z',
      }),
      buchung({
        id: '3',
        artikelId: 'c',
        standortId: 's',
        menge: 0,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T12:00:00.000Z',
      }),
    ]
    const result = handlungsbedarf(artikelRows, rows, standorte)
    expect(result.anzahl).toBe(2)
    expect(result.eintraege.map((e) => e.artikelId)).toEqual(['a', 'b'])
    expect(result.eintraege[0]).toMatchObject({ bestand: 2, mindestbestand: 5, defizit: 3 })
  })

  it('buckets movements per day without double-counting umlagerung', () => {
    const jetzt = new Date(2026, 4, 10, 12, 0, 0)
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 10,
        typ: 'einlagerung',
        erstelltAm: new Date(2026, 4, 9, 9).toISOString(),
      }),
      buchung({
        id: '2',
        artikelId: 'a',
        standortId: 's',
        menge: -3,
        typ: 'entnahme',
        erstelltAm: new Date(2026, 4, 9, 10).toISOString(),
      }),
      buchung({
        id: '3',
        artikelId: 'a',
        standortId: 's',
        menge: -4,
        typ: 'umlagerung',
        erstelltAm: new Date(2026, 4, 10, 8).toISOString(),
      }),
      buchung({
        id: '4',
        artikelId: 'a',
        standortId: 'x',
        menge: 4,
        typ: 'umlagerung',
        erstelltAm: new Date(2026, 4, 10, 8).toISOString(),
      }),
    ]
    const buckets = bewegungenProZeitraum(rows, 7, jetzt)
    expect(buckets).toHaveLength(7)
    const gestern = buckets[5]!
    const heute = buckets[6]!
    expect(gestern.einlagerung).toBe(10)
    expect(gestern.entnahme).toBe(3)
    expect(heute.umlagerung).toBe(4)
    expect(heute.einlagerung).toBe(0)
  })

  it('values positive stock using purchase price per packaging unit', () => {
    const artikelRows = [
      artikel({
        id: 'a',
        titel: 'A',
        verpackungseinheit: 10,
        einkaufspreis: 500,
        mindestbestand: null,
      }),
      artikel({ id: 'b', titel: 'B', verpackungseinheit: 1, einkaufspreis: null }),
    ]
    const standorte = [standort('s', 'Lager')]
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 25,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
      buchung({
        id: '2',
        artikelId: 'b',
        standortId: 's',
        menge: 4,
        typ: 'einlagerung',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
      buchung({
        id: '3',
        artikelId: 'a',
        standortId: 's',
        menge: -2,
        typ: 'entnahme',
        erstelltAm: '2026-05-01T11:00:00.000Z',
      }),
    ]
    const wert = lagerwertAuswertung(artikelRows, rows, standorte)
    // 23 Stueck / VE 10 * 500 Cent = 1150 Cent
    expect(wert.gesamtCent).toBe(1150)
    expect(wert.proStandort[0]).toMatchObject({ name: 'Lager', menge: 23, wertCent: 1150 })
    expect(wert.topArtikel[0]).toMatchObject({ titel: 'A', wertCent: 1150 })
    expect(wert.artikelOhneEinkaufspreis).toBe(1)
  })

  it('ignores negative stock in the inventory value', () => {
    const artikelRows = [artikel({ id: 'a', verpackungseinheit: 1, einkaufspreis: 100 })]
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: -5,
        typ: 'entnahme',
        erstelltAm: '2026-05-01T10:00:00.000Z',
      }),
    ]
    expect(lagerwertAuswertung(artikelRows, rows, [standort('s', 'Lager')]).gesamtCent).toBe(0)
  })

  it('ranks top moving articles and limits the activity list', () => {
    const jetzt = new Date(2026, 4, 10, 12, 0, 0)
    const artikelRows = [artikel({ id: 'a', titel: 'A' }), artikel({ id: 'b', titel: 'B' })]
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 50,
        typ: 'einlagerung',
        erstelltAm: new Date(2026, 4, 8, 10).toISOString(),
      }),
      buchung({
        id: '2',
        artikelId: 'b',
        standortId: 's',
        menge: -5,
        typ: 'entnahme',
        erstelltAm: new Date(2026, 4, 9, 10).toISOString(),
      }),
    ]
    expect(topArtikelNachBewegung(artikelRows, rows, 30, jetzt)).toEqual([
      { artikelId: 'a', titel: 'A', menge: 50 },
      { artikelId: 'b', titel: 'B', menge: 5 },
    ])
    expect(letzteBuchungen(rows, 1)[0]?.id).toBe('2')
  })

  it('provides dashboard KPIs', () => {
    const jetzt = new Date(2026, 4, 10, 12, 0, 0)
    const artikelRows = [
      artikel({ id: 'a', titel: 'A', mindestbestand: 10, einkaufspreis: 100 }),
      artikel({ id: 'arch', titel: 'Arch', status: 'archiviert' }),
    ]
    const standorte = [standort('s', 'Lager'), standort('arch', 'Alt', true)]
    const rows = [
      buchung({
        id: '1',
        artikelId: 'a',
        standortId: 's',
        menge: 5,
        typ: 'einlagerung',
        erstelltAm: new Date(2026, 4, 9, 10).toISOString(),
      }),
    ]
    const kpis = berechneKpis({ artikel: artikelRows, buchungen: rows, standorte, tage: 30, jetzt })
    expect(kpis.aktiveArtikel).toBe(1)
    expect(kpis.aktiveStandorte).toBe(1)
    expect(kpis.bestandGesamt).toBe(5)
    expect(kpis.buchungenImZeitraum).toBe(1)
    expect(kpis.handlungsbedarfAnzahl).toBe(1)
    expect(kpis.lagerwertCent).toBe(500)
  })
})
