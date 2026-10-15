// Buchungs-Store: lädt die `buchungen`-Tabelle reaktiv via Dexie liveQuery.
// Mutationen delegieren an die Domain-Schicht (PLAN §5.1).
// Bestandsberechnung läuft ebenfalls über `domain/bestand`.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Buchung } from '../db/types'
import {
  createEinlagerung,
  createEntnahme,
  createUmlagerung,
  createKommission,
  createInventur,
  stornieren,
  type KommissionEingabe,
  type StornoEingabe,
} from '../domain/buchungen'
import { berechneBestand, berechneBestandProStandort } from '../domain/bestand'

export const useBuchungStore = defineStore('buchung', () => {
  const buchungen = ref<Buchung[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() =>
      getDb().buchungen.orderBy('erstelltAm').reverse().toArray(),
    ).subscribe({
      next: (rows) => {
        buchungen.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('buchung liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  function byArtikel(artikelId: string): Buchung[] {
    return buchungen.value.filter((b) => b.artikelId === artikelId)
  }

  function getBestand(artikelId: string, standortId: string): number {
    return berechneBestand(byArtikel(artikelId), standortId)
  }

  function getBestandProStandort(artikelId: string): Map<string, number> {
    return berechneBestandProStandort(byArtikel(artikelId))
  }

  const alleAktiven = computed<Buchung[]>(() => buchungen.value.filter((b) => !b.storno))

  // Mutation-Wrapper: leiten 1:1 an die Domain durch.
  const mu = {
    einlagerung: createEinlagerung,
    entnahme: createEntnahme,
    umlagerung: createUmlagerung,
    kommission: (e: KommissionEingabe) => createKommission(e),
    inventur: createInventur,
    stornieren: (e: StornoEingabe) => stornieren(e),
  }

  return {
    buchungen,
    alleAktiven,
    geladen,
    start,
    stop,
    byArtikel,
    getBestand,
    getBestandProStandort,
    mu,
  }
})
