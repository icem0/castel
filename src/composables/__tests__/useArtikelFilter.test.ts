// Tests des gemeinsamen Artikel-Filters (Suche/Typ/Status/Standort).
// Der Filter wird von der Artikel-Liste und der Etiketten-Ansicht
// genutzt — er darf deshalb nicht im globalen Store liegen.

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useArtikelFilter } from '../useArtikelFilter'
import { useHerstellerStore } from '../../stores/hersteller'
import type { Artikel, ArtikelStatus, Hersteller } from '../../db/types'

function artikel(patch: Partial<Artikel> & { id: string; titel: string }): Artikel {
  return {
    sharePointId: null,
    status: 'verfuegbar' as ArtikelStatus,
    typ: 'Material',
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    barcode: null,
    etikettenNeu: true,
    listenpreis: null,
    einkaufspreis: null,
    herstellerId: null,
    bestellstatus: 'offen',
    bestelltAm: null,
    bestelltVon: null,
    geaendertAm: null,
    erstelltAm: '2026-01-01T00:00:00.000Z',
    ...patch,
  }
}

const daten: Artikel[] = [
  artikel({ id: '1', titel: 'Schraube M6', typ: 'Material', barcode: '4006381333931' }),
  artikel({ id: '2', titel: 'Akkuschrauber', typ: 'Werkzeug', status: 'reserviert' }),
  artikel({
    id: '3',
    titel: 'Dübel',
    typ: 'Material',
    lieferant: 'Hilti',
    bestellnummer: 'B-42',
    barcode: '12345678',
  }),
]

function hersteller(id: string, name: string): Hersteller {
  return {
    id,
    name,
    bestellEmail: null,
    bestellWebseite: null,
    rabattsatz: 0,
    geaendertAm: null,
    erstelltAm: '2026-01-01T00:00:00.000Z',
  }
}

// Manufacturer fixtures: one article without the FK (CSV import), and one
// whose id has no master data anymore (deleted manufacturer).
const herstellerDaten: Artikel[] = [
  artikel({ id: '10', titel: 'Bohrkrone', herstellerId: 'h1' }),
  artikel({ id: '11', titel: 'Sägeblatt', herstellerId: 'h2' }),
  artikel({ id: '12', titel: 'Import-Dübel', lieferant: 'Hilti' }),
  artikel({ id: '13', titel: 'Altartikel', herstellerId: 'h3' }),
]

describe('useArtikelFilter', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('filtert standardmäßig nach Status "verfuegbar"', () => {
    const f = useArtikelFilter(() => daten)
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['1', '3'])
  })

  it('zeigt bei Status "alle" jeden Artikel', () => {
    const f = useArtikelFilter(() => daten)
    f.filterStatus.value = 'alle'
    expect(f.gefiltert.value).toHaveLength(3)
  })

  it('filtert nach Typ', () => {
    const f = useArtikelFilter(() => daten)
    f.filterStatus.value = 'alle'
    f.filterTyp.value = 'Werkzeug'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['2'])
  })

  it('sucht in Titel, Typ, Lieferant, Bestellnummer und Barcode', () => {
    const f = useArtikelFilter(() => daten)
    f.filterStatus.value = 'alle'

    f.suche.value = 'schraube m6'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['1'])

    // Teiltreffer trifft mehrere Artikel ("Schraube" steckt auch in "Akkuschrauber")
    f.suche.value = 'schraube'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['1', '2'])

    f.suche.value = 'hilti'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['3'])

    f.suche.value = 'b-42'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['3'])

    f.suche.value = '4006381333931'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['1'])
  })

  it('ignoriert die Gross-/Kleinschreibung in der Suche', () => {
    const f = useArtikelFilter(() => daten)
    f.filterStatus.value = 'alle'
    f.suche.value = 'DÜBEL'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['3'])
  })

  it('filtert nach Hersteller', () => {
    const store = useHerstellerStore()
    store.hersteller = [hersteller('h1', 'Bosch'), hersteller('h2', 'Metabo')]
    const f = useArtikelFilter(() => herstellerDaten)
    f.filterStatus.value = 'alle'
    f.filterHersteller.value = 'h2'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['11'])
  })

  it('faengt Artikel ohne Hersteller-Referenz nicht unter einem Hersteller-Filter ab', () => {
    const f = useArtikelFilter(() => herstellerDaten)
    f.filterStatus.value = 'alle'
    f.filterHersteller.value = 'h1'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['10'])
  })

  it('bietet nur die benutzten Hersteller, nach Name sortiert, als Optionen an', () => {
    const store = useHerstellerStore()
    store.hersteller = [hersteller('h2', 'Metabo'), hersteller('h1', 'Bosch')]
    const f = useArtikelFilter(() => herstellerDaten)
    expect(f.herstellerOptionen.value).toEqual([
      { id: 'h1', name: 'Bosch' },
      { id: 'h2', name: 'Metabo' },
    ])
  })

  it('laesst Hersteller-IDs ohne Stammdaten aus den Optionen weg', () => {
    const store = useHerstellerStore()
    store.hersteller = [hersteller('h1', 'Bosch'), hersteller('h2', 'Metabo')]
    const f = useArtikelFilter(() => herstellerDaten)
    expect(f.herstellerOptionen.value.map((o) => o.id)).toEqual(['h1', 'h2'])
  })

  it('kombiniert Hersteller- mit Typ- und Status-Filter', () => {
    const store = useHerstellerStore()
    store.hersteller = [hersteller('h1', 'Bosch'), hersteller('h2', 'Metabo')]
    const f = useArtikelFilter(() => herstellerDaten)
    f.filterStatus.value = 'alle'
    f.filterTyp.value = 'Material'
    f.filterHersteller.value = 'h1'
    expect(f.gefiltert.value.map((a) => a.id)).toEqual(['10'])
  })
})
