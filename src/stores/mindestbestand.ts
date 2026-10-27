// Mindestbestand-Store: lädt die `mindestbestandEreignisse`-Tabelle
// reaktiv via Dexie liveQuery. Treibt das Glocken-Panel in der
// AppShell und den Admin-View `/einstellungen/mindestbestand`.
//
// WICHTIG — Ereignis vs. Alarmzustand:
// `mindestbestand_ereignisse` ist ein Append-only Log. `bestandDanach`
// ist der eingefrorene Bestand aus dem Moment der auslösenden Buchung.
// Wird der Artikel danach wieder aufgefüllt, behauptet das Event weiter
// ein Defizit ("Bestand 3" neben einem realen Bestand von 15). Deshalb
// wird jedes Event hier gegen den LIVE-Bestand aus den Buchungen
// ausgewertet (`zeilen`): nur Events, deren Unterschreitung HEUTE noch
// gilt, zählen als offener Alarm. Historisch bleibt das Event im Log
// sichtbar, ist aber als "erledigt" markiert und wird nicht mehr
// gezählt und nicht mehr geklingelt.
//
// "Neu" vs. "Gesehen": wir lesen den `letzteGesehenAm`-Marker aus
// `einstellungen` (userId='', local-only). Der Counter im Panel zeigt
// nur offene Events, die nach diesem Marker liegen. Beim Klick auf die Glocke
// oder beim Mount des Panels setzt der Store den Marker auf "jetzt".

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Artikel, MindestbestandEreignis } from '../db/types'
import { jetztIso, neueUuid } from '../domain/ids'
import { berechneDefizitAktuell, sollteWarnungAusloesen } from '../domain/mindestbestand'
import { useArtikelStore } from './artikel'
import { useArtikelStandortMindestbestandStore } from './artikelStandortMindestbestand'
import { useBuchungStore } from './buchung'

const GESEHEN_KEY = 'mindestbestand.letzteGesehenAm'
/**
 * Cooldown-Anker für Audio + Blitz. Bewusst ein SEPARATER Marker
 * von `GESEHEN_KEY`:
 *
 * - `letzteGesehenAm` steuert den Badge (kosmetisch, wird beim Öffnen
 *   der Glocke gesetzt).
 * - `letztesSignalAm` steuert, ob ein Alarm ausgelöst wird.
 *
 * Warum zwei? Beim Öffnen der Glocke wird "gesehen" gesetzt, aber der
 * Alarm soll in dem Moment nicht erneut klingeln. Mit einem gemeinsamen
 * Marker würde das zweite Klingeln unterdrückt, was wir beim
 * Wiedererklingen eigentlich wollen.
 */
const SIGNAL_KEY = 'mindestbestand.letztesSignalAm'

/**
 * Ein historisches Ereignis, live gegen den aktuellen Bestand
 * ausgewertet. `ereignis.bestandDanach` bleibt der historische
 * Snapshot; `aktuellerBestand` ist die Zahl, die heute gilt.
 */
export interface MindestbestandZeile {
  ereignis: MindestbestandEreignis
  /** Bestand an `ereignis.standortId`, live aus den Buchungen berechnet. */
  aktuellerBestand: number
  /**
   * Heute gültige Schwelle. `null`, wenn der Admin den Mindestbestand
   * entfernt hat — dann ist der Alarm gegenstandslos. Der Snapshot aus
   * dem Event greift nur, solange der Artikel selbst nicht geladen ist.
   */
  schwelle: number | null
  /** Defizit gegen den aktuellen Bestand, nie negativ. */
  defizit: number
  /** Unterschreitung gilt heute noch — nur diese Zeilen sind aktive Alarme. */
  offen: boolean
}

export const useMindestbestandStore = defineStore('mindestbestand', () => {
  const ereignisse = ref<MindestbestandEreignis[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  // Live-Quelle für den aktuellen Bestand. Beide Stores werden global in
  // `App.vue` gestartet, die Daten stehen also auch dann bereit, wenn nur
  // die Glocke (admin-only) den Mindestbestand-Store instanziiert.
  const buchungStore = useBuchungStore()
  const artikelStore = useArtikelStore()
  const konfigStore = useArtikelStandortMindestbestandStore()

  function schwelleFuer(ev: MindestbestandEreignis, a: Artikel | undefined): number | null {
    // Artikel geladen: es gilt die HEUTE gesetzte Schwelle des Paares
    // (Artikel, Standort). Fehlt die Konfiguration oder ist sie <= 0, ist
    // der Alarm erledigt und darf nicht vom historischen Snapshot am
    // Leben gehalten werden. Bewusst KEIN Fallback auf den globalen
    // `artikel.mindestbestand`.
    if (a) {
      const wert = konfigStore.wertFuer(ev.artikelId, ev.standortId)
      return wert > 0 ? wert : null
    }
    // Artikel nicht geladen (gelöscht oder noch nicht gespiegelt): der
    // Snapshot ist die beste verfügbare Information.
    return ev.mindestbestand > 0 ? ev.mindestbestand : null
  }

  /** Alle Ereignisse, jeweils live gegen den aktuellen Bestand geprüft. */
  const zeilen = computed<MindestbestandZeile[]>(() =>
    ereignisse.value.map((ev) => {
      const aktuellerBestand = buchungStore.getBestand(ev.artikelId, ev.standortId)
      const schwelle = schwelleFuer(ev, artikelStore.byId(ev.artikelId))
      return {
        ereignis: ev,
        aktuellerBestand,
        schwelle,
        defizit: schwelle === null ? 0 : berechneDefizitAktuell(schwelle, aktuellerBestand),
        offen: schwelle !== null && sollteWarnungAusloesen(schwelle, aktuellerBestand),
      }
    }),
  )

  /** Nur die Zeilen, deren Unterschreitung heute noch gilt. */
  const offeneZeilen = computed(() => zeilen.value.filter((z) => z.offen))

  function start() {
    // Die Alarm-Schwelle kommt aus der Konfig-Tabelle, also muss deren
    // Spiegel ebenfalls live sein.
    konfigStore.start()
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
  /** Cooldown-Anker für Audio + Blitz — local-only, wird nicht gepusht. */
  const letztesSignalAm = ref<string | null>(null)
  let markerSubscription: Subscription | null = null

  function startMarker() {
    if (markerSubscription) return
    markerSubscription = liveQuery(() =>
      getDb()
        .einstellungen.bulkGet([
          [GESEHEN_KEY, ''],
          [SIGNAL_KEY, ''],
        ])
        .then((rows) => rows),
    ).subscribe({
      next: (rows) => {
        const gesehen = rows[0]
        const signal = rows[1]
        letzteGesehenAm.value = gesehen?.value ?? null
        letztesSignalAm.value = signal?.value ?? null
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

  /**
   * Anzahl "neuer, noch offener" Alarme = Ereignisse, die UND
   *   * nach dem letzten "Gesehen"-Marker liegen UND
   *   * deren Unterschreitung heute noch gilt.
   *
   * Der zweite Teil ist der Fix: wurde der Bestand nach dem Alarm wieder
   * aufgefüllt, zählt das Ereignis nicht mehr — die Glocke ist dann
   * wieder ruhig, ohne dass jemand den Marker von Hand setzen muss.
   */
  const ungesehenCount = computed(() => {
    const marker = letzteGesehenAm.value
    const cutoff = marker ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    return offeneZeilen.value.filter((z) => z.ereignis.erstelltAm > cutoff).length
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

  /** Liste der letzten 50 Events (für das Drop-drawdown / den Watch-Trigger). */
  const letzte50 = computed(() => ereignisse.value.slice(0, 50))

  /**
   * Dasselbe für die Anzeige, aber live ausgewertet: liefert den
   * aktuellen Bestand und den Status offen/erledigt je Zeile.
   */
  const letzte50Zeilen = computed(() => zeilen.value.slice(0, 50))

  /**
   * Markiert, dass soeben ein Signal (Audio + Blitz + Notification)
   * ausgelöst wurde. Setzt den Cooldown-Anker auf "jetzt" — damit
   * feuert in den nächsten 60 s kein weiterer Alarm.
   *
   * Bewusst unabhängig von `markiereAlleGesehen()`: das Öffnen der
   * Glocke setzt den Gesehen-Marker, löst aber keinen Alarm aus.
   */
  async function markiereSignalGesendet(): Promise<void> {
    const now = jetztIso()
    await getDb().einstellungen.put({
      key: SIGNAL_KEY,
      userId: '',
      value: now,
      geaendertAm: now,
    })
    letztesSignalAm.value = now
  }

  /** Löscht den Cooldown-Anker (für den "Testen"-Knopf in den Settings). */
  async function signalAnkerZuruecksetzen(): Promise<void> {
    await getDb().einstellungen.delete([SIGNAL_KEY, ''])
    letztesSignalAm.value = null
  }

  // Hilfsimporte (noUnusedLocals)
  void neueUuid

  return {
    ereignisse,
    zeilen,
    offeneZeilen,
    geladen,
    letzteGesehenAm,
    letztesSignalAm,
    ungesehenCount,
    letzte50,
    letzte50Zeilen,
    start,
    stop,
    startMarker,
    stopMarker,
    markiereAlleGesehen,
    markiereSignalGesendet,
    signalAnkerZuruecksetzen,
  }
})
