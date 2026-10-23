// Unit-Tests für die Buchungsoperationen.
// Test-DB pro Test isoliert: fresh Dexie mit eigenem Namen.

import { beforeEach, describe, expect, it } from 'vitest'
import { CastelDb, setDb } from '../../db/database'
import type { Artikel, Standort } from '../../db/types'
import {
  createEinlagerung,
  createEntnahme,
  createInventur,
  createKommission,
  createUmlagerung,
  stornieren,
  stornoAufheben,
} from '../buchungen'
import { berechneBestand, berechneBestandProStandort } from '../bestand'
import {
  BereitsStorniertError,
  GleicherStandortError,
  NegativerBestandWarnung,
  PflichtfeldFehltError,
  StornoNichtAufhebbarError,
  UnbekannteReferenzError,
  UngueltigeMengeError,
  ZukunftsDatumError,
} from '../errors'

// Test-IDs sind absichtlich deterministisch lesbar, nicht zufällig.
let testDb: CastelDb
const A = (n: number) => `art-${n}`
const S = (n: number) => `std-${n}`

async function seedArtikel(
  id: string,
  name: string,
  mindestbestand: number | null = null,
): Promise<void> {
  const artikel: Artikel = {
    id,
    sharePointId: null,
    titel: name,
    status: 'verfuegbar',
    typ: 'Test',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: true,
    listenpreis: null,
    einkaufspreis: null,
    geaendertAm: null,
    erstelltAm: '2025-01-01T00:00:00.000Z',
  }
  await testDb.artikel.add(artikel)
}

async function seedStandort(id: string, name: string, standard = false): Promise<void> {
  const standort: Standort = {
    id,
    name,
    typ: 'lager',
    projekt: null,
    kennzeichen: null,
    standard,
    archiviert: false,
    geaendertAm: '2025-01-01T00:00:00.000Z',
    erstelltAm: '2025-01-01T00:00:00.000Z',
  }
  await testDb.standorte.add(standort)
}

beforeEach(async () => {
  // frische DB pro Test (in-memory fake-indexeddb)
  testDb = new CastelDb(`castel-test-${Math.random().toString(36).slice(2)}`)
  setDb(testDb)
  await testDb.delete()
  await testDb.open()
  // Stammdaten anlegen
  await seedStandort(S(1), 'Hauptlager', true)
  await seedStandort(S(2), 'Auto-1')
  await seedArtikel(A(1), 'MS 400')
  await seedArtikel(A(2), 'BX-SOL-CT-W')
  await seedArtikel(A(3), 'MS 300 mit Mindestbestand', 5)
})

describe('createEinlagerung', () => {
  it('legt eine Buchung mit positiver Menge an', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 10,
      erstelltVon: 'tester',
    })
    expect(b.typ).toBe('einlagerung')
    expect(b.menge).toBe(10)
    expect(b.storno).toBe(false)
    const alle = await testDb.buchungen.toArray()
    expect(alle).toHaveLength(1)
  })

  it('wirft bei Menge <= 0', async () => {
    await expect(
      createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 0, erstelltVon: 't' }),
    ).rejects.toThrow(UngueltigeMengeError)
  })

  it('wirft bei fehlendem Pflichtfeld', async () => {
    await expect(
      // @ts-expect-error: teste fehlendes Feld
      createEinlagerung({ artikelId: A(1), standortId: S(1), erstelltVon: 't' }),
    ).rejects.toThrow(UngueltigeMengeError)
  })
})

describe('createEntnahme + Bestand', () => {
  it('addiert Einlagerungen und subtrahiert Entnahmen korrekt', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 50, erstelltVon: 't' })
    const ergebnis = await createEntnahme({
      artikelId: A(1),
      standortId: S(1),
      menge: 20,
      erstelltVon: 't',
    })
    expect(ergebnis.buchung.menge).toBe(-20)
    expect(ergebnis.warnung).toBeNull()
    expect(ergebnis.mindestbestandWarnung).toBeNull() // A(1) hat keinen Mindestbestand
    const buchungen = await testDb.buchungen.toArray()
    const bestand = berechneBestand(buchungen, S(1))
    expect(bestand).toBe(30) // 50 - 20
  })

  it('warnt bei Überzeichnung, schreibt aber trotzdem', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 5, erstelltVon: 't' })
    const ergebnis = await createEntnahme({
      artikelId: A(1),
      standortId: S(1),
      menge: 10,
      erstelltVon: 't',
    })
    expect(ergebnis.warnung).toBeInstanceOf(NegativerBestandWarnung)
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(-5)
  })
})

describe('createUmlagerung', () => {
  it('erzeugt zwei Buchungen mit gleicher paarId, verschiebt den Bestand', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 100, erstelltVon: 't' })
    const r = await createUmlagerung({
      artikelId: A(1),
      vonId: S(1),
      nachId: S(2),
      menge: 30,
      erstelltVon: 't',
    })
    expect(r.entnahme.typ).toBe('umlagerung')
    expect(r.einlagerung.typ).toBe('umlagerung')
    expect(r.entnahme.paarId).toBe(r.paarId)
    expect(r.einlagerung.paarId).toBe(r.paarId)
    expect(r.entnahme.menge).toBe(-30)
    expect(r.einlagerung.menge).toBe(30)
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(70)
    expect(berechneBestand(buchungen, S(2))).toBe(30)
  })

  it('wirft GleicherStandortError bei identischem Quell-/Ziel-Standort', async () => {
    await expect(
      createUmlagerung({
        artikelId: A(1),
        vonId: S(1),
        nachId: S(1),
        menge: 1,
        erstelltVon: 't',
      }),
    ).rejects.toThrow(GleicherStandortError)
  })

  it('warnt wenn am Quellstandort nicht genug vorhanden ist', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 5, erstelltVon: 't' })
    const r = await createUmlagerung({
      artikelId: A(1),
      vonId: S(1),
      nachId: S(2),
      menge: 50,
      erstelltVon: 't',
    })
    expect(r.warnung).toBeInstanceOf(NegativerBestandWarnung)
  })
})

describe('createInventur', () => {
  it('schreibt eine Differenz-Buchung so dass die Summe dem Soll entspricht', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 17, erstelltVon: 't' })
    const r = await createInventur({
      artikelId: A(1),
      standortId: S(1),
      sollMenge: 20,
      erstelltVon: 't',
    })
    expect(r.vorher).toBe(17)
    expect(r.differenz).toBe(3)
    expect(r.buchung.menge).toBe(3)
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(20)
  })

  it('akzeptiert 0 als Soll-Menge und erzeugt ggf. negative Korrektur', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 7, erstelltVon: 't' })
    const r = await createInventur({
      artikelId: A(1),
      standortId: S(1),
      sollMenge: 0,
      erstelltVon: 't',
    })
    expect(r.differenz).toBe(-7)
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(0)
  })
})

describe('stornieren', () => {
  it('erzeugt Storno-Buchung mit invertierter Menge und markiert Original', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 10,
      erstelltVon: 't',
    })
    const r = await stornieren({ buchungId: b.id, grund: 'falsche Eingabe', erstelltVon: 't' })
    expect(r.storno.menge).toBe(-10)
    expect(r.storno.stornoVon).toBe(b.id)
    expect(r.original.storno).toBe(true)
    expect(r.original.storniertDurch).toBe(r.storno.id)
    const buchungen = await testDb.buchungen.toArray()
    expect(berechneBestand(buchungen, S(1))).toBe(0) // Original + Storno = 0
  })

  it('verbietet Doppel-Storno', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 10,
      erstelltVon: 't',
    })
    await stornieren({ buchungId: b.id, grund: 'x', erstelltVon: 't' })
    await expect(stornieren({ buchungId: b.id, grund: 'y', erstelltVon: 't' })).rejects.toThrow(
      BereitsStorniertError,
    )
  })
})

describe('stornoAufheben', () => {
  it('reaktiviert das Original und stellt den Bestand wieder her', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 10,
      erstelltVon: 't',
    })
    const s = await stornieren({ buchungId: b.id, grund: 'falsche Eingabe', erstelltVon: 't' })
    expect(berechneBestand(await testDb.buchungen.toArray(), S(1))).toBe(0)

    const r = await stornoAufheben({
      stornoId: s.storno.id,
      grund: 'doch richtig',
      erstelltVon: 't',
    })

    expect(r.original.id).toBe(b.id)
    expect(r.original.storno).toBe(false)
    expect(r.original.storniertDurch).toBeNull()
    expect(r.aufhebung.typ).toBe('storno')
    expect(r.aufhebung.storno).toBe(true) // zählt nicht in den Bestand
    expect(r.aufhebung.stornoVon).toBe(s.storno.id)
    expect(r.aufhebung.menge).toBe(10)
    const alle = await testDb.buchungen.toArray()
    expect(berechneBestand(alle, S(1))).toBe(10)
  })

  it('verbietet doppeltes Aufheben', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 4,
      erstelltVon: 't',
    })
    const s = await stornieren({ buchungId: b.id, grund: 'x', erstelltVon: 't' })
    await stornoAufheben({ stornoId: s.storno.id, grund: 'y', erstelltVon: 't' })
    await expect(
      stornoAufheben({ stornoId: s.storno.id, grund: 'z', erstelltVon: 't' }),
    ).rejects.toThrow(StornoNichtAufhebbarError)
  })

  it('verbietet das Aufheben einer Nicht-Storno-Buchung', async () => {
    const b = await createEinlagerung({
      artikelId: A(1),
      standortId: S(1),
      menge: 4,
      erstelltVon: 't',
    })
    await expect(stornoAufheben({ stornoId: b.id, grund: 'x', erstelltVon: 't' })).rejects.toThrow(
      StornoNichtAufhebbarError,
    )
  })

  it('verbietet das Aufheben eines Kommission-Stornos', async () => {
    const b = await createEntnahme({
      artikelId: A(1),
      standortId: S(1),
      menge: 5,
      projekt: '220405',
      erstelltVon: 't',
    })
    const k = await createKommission({
      buchungId: b.buchung.id,
      neuesProjekt: '220999',
      erstelltVon: 't',
    })
    await expect(
      stornoAufheben({ stornoId: k.storno.id, grund: 'x', erstelltVon: 't' }),
    ).rejects.toThrow(StornoNichtAufhebbarError)
  })
})

describe('createKommission', () => {
  it('storniert Original und legt neue Buchung mit neuem Projekt an, Bestand bleibt konstant', async () => {
    const b = await createEntnahme({
      artikelId: A(1),
      standortId: S(1),
      menge: 5,
      projekt: '220405',
      erstelltVon: 't',
    })
    const r = await createKommission({
      buchungId: b.buchung.id,
      neuesProjekt: '220999',
      erstelltVon: 't',
    })
    expect(r.storno.typ).toBe('storno')
    expect(r.neubuchung.typ).toBe('kommission')
    expect(r.neubuchung.projekt).toBe('220999')
    expect(r.neubuchung.menge).toBe(b.buchung.menge) // gleiches Vorzeichen
    expect(r.storno.menge).toBe(-b.buchung.menge)
    const buchungen = await testDb.buchungen.toArray()
    // Storno zählt nicht, neue Kommission-Buchung ersetzt das Original semantisch
    expect(berechneBestand(buchungen, S(1))).toBe(-5)
  })

  it('wirft bei fehlendem Original', async () => {
    await expect(
      createKommission({ buchungId: 'gibt-es-nicht', neuesProjekt: 'x', erstelltVon: 't' }),
    ).rejects.toThrow(PflichtfeldFehltError)
  })
})

describe('berechneBestandProStandort', () => {
  it('gruppiert Bestände korrekt', async () => {
    await createEinlagerung({ artikelId: A(1), standortId: S(1), menge: 10, erstelltVon: 't' })
    await createUmlagerung({
      artikelId: A(1),
      vonId: S(1),
      nachId: S(2),
      menge: 4,
      erstelltVon: 't',
    })
    const map = berechneBestandProStandort(await testDb.buchungen.toArray())
    expect(map.get(S(1))).toBe(6)
    expect(map.get(S(2))).toBe(4)
  })
})

describe('Validierung: Referenzen, Zeit, Mindestbestand', () => {
  it('createEinlagerung lehnt unbekannten Artikel ab', async () => {
    await expect(
      createEinlagerung({
        artikelId: 'gibt-es-nicht',
        standortId: S(1),
        menge: 5,
        erstelltVon: 't',
      }),
    ).rejects.toBeInstanceOf(UnbekannteReferenzError)
  })

  it('createEinlagerung lehnt unbekannten Standort ab', async () => {
    await expect(
      createEinlagerung({
        artikelId: A(1),
        standortId: 'gibt-es-nicht',
        menge: 5,
        erstelltVon: 't',
      }),
    ).rejects.toBeInstanceOf(UnbekannteReferenzError)
  })

  it('createUmlagerung lehnt unbekannten Ziel-Standort ab', async () => {
    await expect(
      createUmlagerung({
        artikelId: A(1),
        vonId: S(1),
        nachId: 'gibt-es-nicht',
        menge: 1,
        erstelltVon: 't',
      }),
    ).rejects.toBeInstanceOf(UnbekannteReferenzError)
  })

  it('createEinlagerung lehnt Zukunfts-Datum ab', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    await expect(
      createEinlagerung({
        artikelId: A(1),
        standortId: S(1),
        menge: 5,
        erstelltAm: future,
        erstelltVon: 't',
      }),
    ).rejects.toBeInstanceOf(ZukunftsDatumError)
  })

  it('createEntnahme lehnt Zukunfts-Datum ab', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    await expect(
      createEntnahme({
        artikelId: A(1),
        standortId: S(1),
        menge: 5,
        erstelltAm: future,
        erstelltVon: 't',
      }),
    ).rejects.toBeInstanceOf(ZukunftsDatumError)
  })

  it('createEntnahme liefert MindestbestandWarnung bei Unterschreitung', async () => {
    // A(3) hat mindestbestand=5
    await createEinlagerung({ artikelId: A(3), standortId: S(1), menge: 6, erstelltVon: 't' })
    const r = await createEntnahme({
      artikelId: A(3),
      standortId: S(1),
      menge: 2,
      erstelltVon: 't',
    })
    // bestand nach Entnahme: 4 < mindestbestand 5
    expect(r.mindestbestandWarnung).not.toBeNull()
    expect(r.mindestbestandWarnung?.mindestbestand).toBe(5)
    expect(r.mindestbestandWarnung?.bestand).toBe(4)
  })

  it('createEntnahme ohne Unterschreitung — keine MindestbestandWarnung', async () => {
    await createEinlagerung({ artikelId: A(3), standortId: S(1), menge: 20, erstelltVon: 't' })
    const r = await createEntnahme({
      artikelId: A(3),
      standortId: S(1),
      menge: 5,
      erstelltVon: 't',
    })
    expect(r.mindestbestandWarnung).toBeNull()
  })

  it('createUmlagerung liefert MindestbestandWarnung am Quellstandort', async () => {
    await createEinlagerung({ artikelId: A(3), standortId: S(1), menge: 6, erstelltVon: 't' })
    const r = await createUmlagerung({
      artikelId: A(3),
      vonId: S(1),
      nachId: S(2),
      menge: 2,
      erstelltVon: 't',
    })
    expect(r.mindestbestandWarnung).not.toBeNull()
    expect(r.mindestbestandWarnung?.standortId).toBe(S(1))
  })
})
