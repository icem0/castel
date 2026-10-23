// Tests des gemeinsamen Artikel-Filters (Suche/Typ/Status/Standort).
// Der Filter wird von der Artikel-Liste und der Etiketten-Ansicht
// genutzt — er darf deshalb nicht im globalen Store liegen.

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useArtikelFilter } from '../useArtikelFilter'
import type { Artikel, ArtikelStatus } from '../../db/types'

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
})
