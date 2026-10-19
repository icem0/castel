// Mindestbestand-Store: lädt die `mindestbestandEreignisse`-Tabelle
// reaktiv via Dexie liveQuery. Treibt das Glocken-Panel in der
// AppShell und den Admin-View `/einstellungen/mindestbestand`.
//
// "Neu" vs. "Gesehen": wir lesen den `letzteGesehenAm`-Marker aus
// `einstellungen` (userId='', local-only). Der Counter im Panel zeigt
// nur Events, die nach diesem Marker liegen. Beim Klick auf die Glocke
// oder beim Mount des Panels setzt der Store den Marker auf "jetzt".

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { MindestbestandEreignis } from '../db/types'
import { jetztIso, neueUuid } from '../domain/ids'

const GESEHEN_KEY = 'mindestbestand.letzteGesehenAm'

export const useMindestbestandStore = defineStore('mindestbestand', () => {
  const ereignisse = ref<MindestbestandEreignis[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() =>
      getDb().mindestbestandEreignisse.orderBy('erstelltAm').reverse().toArray(),
    ).subscribe({
      next: (rows) => {
        ereignisse.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('mindestbestand liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  /** Marker "zuletzt gesehen" — local-only, wird nicht gepusht. */
  const letzteGesehenAm = ref<string | null>(null)
  let markerSubscription: Subscription | null = null

  function startMarker() {
    if (markerSubscription) return
    markerSubscription = liveQuery(() => getDb().einstellungen.get([GESEHEN_KEY, ''])).subscribe({
      next: (row) => {
        letzteGesehenAm.value = row?.value ?? null
      },
      error: (e) => {
        console.error('mindestbestand marker liveQuery error:', e)
      },
    })
  }

  function stopMarker() {
    markerSubscription?.unsubscribe()
    markerSubscription = null
  }

  function setMarker(value: string): void {
    letzteGesehenAm.value = value
  }

  /** Anzahl "neuer" Events = seit dem letzten "Gesehen"-Marker. */
  const ungesehenCount = computed(() => {
    const marker = letzteGesehenAm.value
    if (!marker) {
      // Default-Verhalten: alle Events der letzten 24h zählen.
      // Wir wollen den Counter nicht künstlich hochtreiben, wenn der
      // User die PWA zum ersten Mal öffnet und 200 historische Events
      // in der DB liegen.
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      return ereignisse.value.filter((e) => e.erstelltAm > cutoff).length
    }
    return ereignisse.value.filter((e) => e.erstelltAm > marker).length
  })

  /**
   * Markiert alle aktuellen Events als "gesehen". Setzt den Marker
   * auf den Zeitpunkt des jüngsten Events, sodass der Counter sofort
   * auf 0 springt. Wird vom Glocken-Panel beim Öffnen und vom
   * Panel-View beim Mount aufgerufen.
   */
  async function markiereAlleGesehen(): Promise<void> {
    const now = jetztIso()
    await getDb().einstellungen.put({
      key: GESEHEN_KEY,
      userId: '',
      value: now,
      geaendertAm: now,
    })
    setMarker(now)
  }

  /** Liste der letzten 50 Events (für das Drop-Down). */
  const letzte50 = computed(() => ereignisse.value.slice(0, 50))

  // Hilfsimporte (noUnusedLocals)
  void neueUuid

  return {
    ereignisse,
    geladen,
    letzteGesehenAm,
    ungesehenCount,
    letzte50,
    start,
    stop,
    startMarker,
    stopMarker,
    markiereAlleGesehen,
  }
})
