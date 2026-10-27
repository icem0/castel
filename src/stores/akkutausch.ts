// Akkutausch-Store: Netzteile, Projektakkus und die daraus abgeleitete
// Austauschplanung.
//
// Die Daten liegen in Dexie (Spiegel der Server-Tabellen `akku_netzteile`
// und `akku_projekte`) und werden ueber die Outbox synchronisiert.
// Geloescht wird per Soft-Delete (`geloescht = true`) — die Zeile bleibt
// als Tombstone erhalten, damit die Loeschung auch auf anderen Geraeten
// ankommt.
//
// Die Planung selbst liegt in `src/domain/akkutausch/berechnung.ts` (pure
// Funktion). Dieser Store liefert nur die Daten zu:
//   - Bestand  = Summe der aktiven Buchungen ueber alle Standorte
//   - Reserve  = Mindestbestand des Akku-Artikels am Hauptlager
//                (Konfiguration aus `artikel_standort_mindestbestaende`)

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, onScopeDispose, ref } from 'vue'
import { getDb } from '../db/database'
import type { Netzteil, Projektakku } from '../db/types'
import { jetztIso, neueUuid } from '../domain/ids'
import { queueOp } from '../services/sync/worker'
import { berechnePlanung, faelligkeit } from '../domain/akkutausch/berechnung'
import type { AkkuTyp, Planung } from '../domain/akkutausch/types'
import { useArtikelStandortMindestbestandStore } from './artikelStandortMindestbestand'
import { useBuchungStore } from './buchung'
import { useSettingsStore } from './settings'
import { useStandortStore } from './standort'

/** Eingabewerte fuer ein Netzteil (Anlegen und Bearbeiten). */
export interface NetzteilEingabe {
  id?: string
  anlage: string
  objekt: string
  name: string
  /** Einbaudatum als `YYYY-MM-DD`. */
  einbaudatum: string
  intervallJahre: number
  kapazitaetAh: number
  anzahl: number
  gruppe: string | null
  plz: string | null
  vdsAnerkennung: string | null
  bemerkung: string | null
}

/** Eingabewerte fuer einen Projektakku. */
export interface ProjektakkuEingabe {
  id?: string
  projekt: string
  menge: number
  artAh: number
  quartal: number
  jahr: number
}

function aktuellesQuartal(): number {
  return Math.floor(new Date().getMonth() / 3) + 1
}

export const useAkkutauschStore = defineStore('akkutausch', () => {
  const netzteile = ref<Netzteil[]>([])
  const projekte = ref<Projektakku[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  const settings = useSettingsStore()
  const buchungStore = useBuchungStore()
  const standortStore = useStandortStore()
  const mindestbestandStore = useArtikelStandortMindestbestandStore()

  /** Konfigurierte Akku-Groessen (globale Einstellung `akkuTypen`). */
  const typen = computed<AkkuTyp[]>(() => settings.settings.akkuTypen)
  /** Das Hauptlager — dort wirkt der Mindestbestand als Reserve. */
  const hauptlagerId = computed<string | null>(() => standortStore.standardlager?.id ?? null)

  /** Quartal und Jahr der Planung. */
  const quartal = ref(aktuellesQuartal())
  const jahr = ref(new Date().getFullYear())

  function start() {
    // Bestand (Buchungen), Reserve (Konfiguration) und Akku-Groessen
    // (Einstellung) muessen live sein, damit die Planung aktuell bleibt.
    buchungStore.start()
    settings.start()
    mindestbestandStore.start()
    if (subscription) return
    subscription = liveQuery(async () => {
      const [n, p] = await Promise.all([
        getDb().akkuNetzteile.toArray(),
        getDb().akkuProjekte.toArray(),
      ])
      return { n, p }
    }).subscribe({
      next: (rows) => {
        netzteile.value = rows.n
        projekte.value = rows.p
        geladen.value = true
      },
      error: (e) => {
        console.error('akkutausch liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  /** Netzteile ohne Tombstone. */
  const aktiveNetzteile = computed(() => netzteile.value.filter((n) => !n.geloescht))
  /** Projektakkus ohne Tombstone. */
  const aktiveProjekte = computed(() => projekte.value.filter((p) => !p.geloescht))

  /** Bestand je Artikel-ID (Summe ueber alle Standorte). */
  const bestandJeArtikel = computed(() => {
    const map = new Map<string, number>()
    for (const b of buchungStore.alleAktiven) {
      map.set(b.artikelId, (map.get(b.artikelId) ?? 0) + b.menge)
    }
    return map
  })

  /** Reserve je Artikel-ID = Mindestbestand am Hauptlager. */
  const reserveJeArtikel = computed(() => {
    const map = new Map<string, number>()
    const standortId = hauptlagerId.value
    if (!standortId) return map
    for (const typ of typen.value) {
      if (!typ.artikelId) continue
      map.set(typ.artikelId, mindestbestandStore.wertFuer(typ.artikelId, standortId))
    }
    return map
  })

  /** Die Austauschplanung fuer das gewaehlte Quartal. */
  const planung = computed<Planung>(() =>
    berechnePlanung({
      typen: typen.value,
      netzteile: aktiveNetzteile.value,
      projektakkus: aktiveProjekte.value,
      bestand: bestandJeArtikel.value,
      reserve: reserveJeArtikel.value,
      quartal: quartal.value,
      jahr: jahr.value,
    }),
  )

  /** Faelligkeit eines Netzteils (ISO-Datum) oder `null`. */
  function faelligkeitVon(netzteil: Netzteil): string | null {
    return faelligkeit(netzteil.einbaudatum, netzteil.intervallJahre)
  }

  async function netzteilSpeichern(eingabe: NetzteilEingabe): Promise<void> {
    const now = jetztIso()
    const db = getDb()
    if (eingabe.id) {
      const bestehend = await db.akkuNetzteile.get(eingabe.id)
      if (!bestehend) throw new Error(`Netzteil ${eingabe.id} nicht gefunden`)
      const aktualisiert: Netzteil = {
        ...bestehend,
        anlage: eingabe.anlage,
        objekt: eingabe.objekt,
        name: eingabe.name,
        einbaudatum: eingabe.einbaudatum,
        intervallJahre: eingabe.intervallJahre,
        kapazitaetAh: eingabe.kapazitaetAh,
        anzahl: eingabe.anzahl,
        gruppe: eingabe.gruppe,
        plz: eingabe.plz,
        vdsAnerkennung: eingabe.vdsAnerkennung,
        bemerkung: eingabe.bemerkung,
        geaendertAm: now,
      }
      await db.akkuNetzteile.put(aktualisiert)
      await queueOp('akku_netzteil', 'update', aktualisiert)
      return
    }
    const neu: Netzteil = {
      id: neueUuid(),
      anlage: eingabe.anlage,
      objekt: eingabe.objekt,
      name: eingabe.name,
      einbaudatum: eingabe.einbaudatum,
      intervallJahre: eingabe.intervallJahre,
      kapazitaetAh: eingabe.kapazitaetAh,
      anzahl: eingabe.anzahl,
      gruppe: eingabe.gruppe,
      plz: eingabe.plz,
      vdsAnerkennung: eingabe.vdsAnerkennung,
      bemerkung: eingabe.bemerkung,
      geloescht: false,
      erstelltAm: now,
      geaendertAm: now,
    }
    await db.akkuNetzteile.add(neu)
    await queueOp('akku_netzteil', 'create', neu)
  }

  /** Soft-Delete: die Zeile bleibt als Tombstone erhalten. */
  async function netzteilLoeschen(id: string): Promise<void> {
    const db = getDb()
    const netzteil = await db.akkuNetzteile.get(id)
    if (!netzteil) return
    const geloescht: Netzteil = { ...netzteil, geloescht: true, geaendertAm: jetztIso() }
    await db.akkuNetzteile.put(geloescht)
    await queueOp('akku_netzteil', 'update', geloescht)
  }

  async function projektSpeichern(eingabe: ProjektakkuEingabe): Promise<void> {
    const now = jetztIso()
    const db = getDb()
    if (eingabe.id) {
      const bestehend = await db.akkuProjekte.get(eingabe.id)
      if (!bestehend) throw new Error(`Projektakku ${eingabe.id} nicht gefunden`)
      const aktualisiert: Projektakku = {
        ...bestehend,
        projekt: eingabe.projekt,
        menge: eingabe.menge,
        artAh: eingabe.artAh,
        quartal: eingabe.quartal,
        jahr: eingabe.jahr,
        geaendertAm: now,
      }
      await db.akkuProjekte.put(aktualisiert)
      await queueOp('akku_projekt', 'update', aktualisiert)
      return
    }
    const neu: Projektakku = {
      id: neueUuid(),
      projekt: eingabe.projekt,
      menge: eingabe.menge,
      artAh: eingabe.artAh,
      quartal: eingabe.quartal,
      jahr: eingabe.jahr,
      geloescht: false,
      erstelltAm: now,
      geaendertAm: now,
    }
    await db.akkuProjekte.add(neu)
    await queueOp('akku_projekt', 'create', neu)
  }

  async function projektLoeschen(id: string): Promise<void> {
    const db = getDb()
    const projekt = await db.akkuProjekte.get(id)
    if (!projekt) return
    const geloescht: Projektakku = { ...projekt, geloescht: true, geaendertAm: jetztIso() }
    await db.akkuProjekte.put(geloescht)
    await queueOp('akku_projekt', 'update', geloescht)
  }

  return {
    netzteile,
    projekte,
    geladen,
    typen,
    hauptlagerId,
    quartal,
    jahr,
    aktiveNetzteile,
    aktiveProjekte,
    bestandJeArtikel,
    reserveJeArtikel,
    planung,
    start,
    stop,
    faelligkeitVon,
    netzteilSpeichern,
    netzteilLoeschen,
    projektSpeichern,
    projektLoeschen,
  }
})
