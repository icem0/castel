// Buchungs-Store: lädt die `buchungen`-Tabelle reaktiv via Dexie liveQuery.
// Mutationen delegieren an die Domain-Schicht (PLAN §5.1).
//
// Der Bestand wird nicht mehr über die Summe lokaler Buchungen berechnet,
// sondern über die materialisierte `bestand`-Tabelle (je Artikel/Standort),
// die der Server beim Rebase und bei jeder gepushten Buchung führt.
// Korrektur für lokale, noch nicht zum Server gepushte Buchungen wird
// additiv aufgeschlagen, bis der Pull den aktuellen Server-Stand bringt.

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
  stornoAufheben,
  type KommissionEingabe,
  type StornoEingabe,
  type StornoAufhebenEingabe,
} from '../domain/buchungen'

export const useBuchungStore = defineStore('buchung', () => {
  const buchungen = ref<Buchung[]>([])
  const bestand = ref<Map<string, number>>(new Map()) // `artikelId#standortId` → Menge (serverseitig)
  const geladen = ref(false)
  let buchungSubscription: Subscription | null = null
  let bestandSubscription: Subscription | null = null

  function start() {
    if (buchungSubscription) return
    buchungSubscription = liveQuery(() =>
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
    bestandSubscription = liveQuery(() => getDb().bestand.toArray()).subscribe({
      next: (rows) => {
        const m = new Map<string, number>()
        for (const z of rows) m.set(`${z.artikelId}#${z.standortId}`, z.menge)
        bestand.value = m
      },
      error: (e) => {
        console.error('bestand liveQuery error:', e)
      },
    })
  }

  function stop() {
    buchungSubscription?.unsubscribe()
    buchungSubscription = null
    bestandSubscription?.unsubscribe()
    bestandSubscription = null
  }

  onScopeDispose(stop)

  function byArtikel(artikelId: string): Buchung[] {
    return buchungen.value.filter((b) => b.artikelId === artikelId)
  }

  /** Summe der lokal noch nicht gepushten Buchungen für ein Paar. */
  function pendingKorrektur(artikelId: string, standortId: string): number {
    let summe = 0
    for (const b of buchungen.value) {
      if (b.pendingSync !== true) continue
      if (b.artikelId === artikelId && b.standortId === standortId) summe += b.menge
    }
    return summe
  }

  function getBestand(artikelId: string, standortId: string): number {
    return (
      (bestand.value.get(`${artikelId}#${standortId}`) ?? 0) +
      pendingKorrektur(artikelId, standortId)
    )
  }

  function getBestandProStandort(artikelId: string): Map<string, number> {
    const map = new Map<string, number>()
    for (const [key, menge] of bestand.value) {
      const [aid, sid] = key.split('#') as [string, string]
      if (aid !== artikelId) continue
      map.set(sid, (map.get(sid) ?? 0) + menge)
    }
    for (const b of buchungen.value) {
      if (b.pendingSync !== true || b.artikelId !== artikelId) continue
      map.set(b.standortId, (map.get(b.standortId) ?? 0) + b.menge)
    }
    return map
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
    stornoAufheben: (e: StornoAufhebenEingabe) => stornoAufheben(e),
  }

  return {
    buchungen,
    bestand,
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
