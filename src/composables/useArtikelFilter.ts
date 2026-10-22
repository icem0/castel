// Gemeinsame Filterlogik fuer die Artikel-Listen.
//
// Bewusst als Composable und nicht im Artikel-Store: der Store-Kommentar
// in `src/stores/artikel.ts` warnt davor, Filter global zu machen — ein
// in /artikel gesetzter Filter hatte einmal die Dashboard-Zaehlung
// ueberschrieben. Jede View haelt ihren eigenen Filter-State; die
// Filterlogik selbst teilen sich Artikel- und Etiketten-Liste.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useBuchungStore } from '../stores/buchung'
import type { Artikel, ArtikelStatus } from '../db/types'

export type StatusFilter = 'alle' | ArtikelStatus

export interface ArtikelFilterState {
  suche: Ref<string>
  filterTyp: Ref<string>
  filterStatus: Ref<StatusFilter>
  filterStandort: Ref<string>
  gefiltert: ComputedRef<Artikel[]>
}

/**
 * `quelle` liefert die zu filternde Artikelliste (typisch
 * `() => artikelStore.artikel`). Als Getter statt Ref, damit der
 * Pinia-Store (der Refs aufloest) direkt uebergeben werden kann.
 */
export function useArtikelFilter(
  quelle: () => Artikel[],
  standardStatus: StatusFilter = 'verfuegbar',
): ArtikelFilterState {
  const buchungStore = useBuchungStore()

  const suche = ref('')
  const filterTyp = ref('')
  const filterStatus = ref<StatusFilter>(standardStatus)
  const filterStandort = ref('')

  // Buchungs-Lookup fuer den Standort-Filter: wir fragen den BuchungStore
  // direkt, statt eine Lookup-Funktion in den ArtikelStore zu injizieren.
  function artikelHatBuchungAufStandort(artikelId: string, standortId: string): boolean {
    const rows = buchungStore.byArtikel(artikelId)
    for (const b of rows) {
      if (b.standortId === standortId) return true
      if (b.standortZielId === standortId) return true
    }
    return false
  }

  const gefiltert = computed<Artikel[]>(() => {
    const sucheLower = suche.value.trim().toLowerCase()
    const status = filterStatus.value
    const typ = filterTyp.value
    const standortId = filterStandort.value
    return quelle().filter((a) => {
      if (status !== 'alle' && a.status !== status) return false
      if (typ && a.typ !== typ) return false
      if (standortId && !artikelHatBuchungAufStandort(a.id, standortId)) return false
      if (sucheLower) {
        // Der Barcode gehoert mit in die Suche — in der Etiketten-Ansicht
        // wird haeufig nach einem Code gesucht.
        const haystack =
          `${a.titel} ${a.typ} ${a.lieferant ?? ''} ${a.bestellnummer ?? ''} ${a.barcode ?? ''}`.toLowerCase()
        if (!haystack.includes(sucheLower)) return false
      }
      return true
    })
  })

  return { suche, filterTyp, filterStatus, filterStandort, gefiltert }
}
