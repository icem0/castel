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
//   - Bestand = Summe der aktiven Buchungen ueber alle Standorte
//   - Puffer  = Mindestbestand des Akku-Artikels am Hauptlager
//                (Konfiguration aus `artikel_standort_mindestbestaende`)
//
// Markiert ein Admin das Quartal als "bestellt", wird der Mindestbestand der
// Akku-Artikel am Hauptlager auf `Bedarf - Bestand` gesetzt (0 entfernt die
// sparse Konfiguration). Das Archiv behaelt den bisherigen Puffer.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, onScopeDispose, ref } from 'vue'
import { getDb } from '../db/database'
import type { AkkuBestellung, Netzteil, Projektakku } from '../db/types'
import { jetztIso, neueUuid } from '../domain/ids'
import { queueOp } from '../services/sync/worker'
import { berechnePlanung, faelligkeit, neuerMindestbestand } from '../domain/akkutausch/berechnung'
import { ermittleInventurStatus } from '../domain/akkutausch/inventur'
import { kuerzelAusName } from '../domain/kuerzel'
import type { AkkuTyp, InventurStatus, Planzeile, Planung } from '../domain/akkutausch/types'
import { useArtikelStandortMindestbestandStore } from './artikelStandortMindestbestand'
import { useAuthStore } from './auth'
import { useBuchungStore } from './buchung'
import { useSettingsStore } from './settings'
import { useStandortStore } from './standort'

/** Eingabewerte fuer ein Netzteil (Anlegen und Bearbeiten). */
export interface NetzteilEingabe {
  id?: string
  anlage: string
  objekt: string
  name: string
  /** Einbaudatum als `YYYY-MM-DD` — `null`, solange noch nicht bekannt. */
  einbaudatum: string | null
  /** Wechselintervall in Jahren — `null`, solange noch nicht bekannt. */
  intervallJahre: number | null
  /** Akku-Kapazitaet in Ah — `null`, solange noch nicht bekannt. */
  kapazitaetAh: number | null
  /** Anzahl Akkus pro Geraet — `null`, solange noch nicht bekannt. */
  anzahl: number | null
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

/**
 * Result of {@link bestellungMarkieren}: the archived order (`null` when the
 * quarter was already ordered or the inventory is not valid) plus the number
 * of battery articles whose minimum stock was rewritten.
 */
export interface BestellungMarkierenErgebnis {
  bestellung: AkkuBestellung | null
  aktualisierteMindestbestaende: number
}

export const useAkkutauschStore = defineStore('akkutausch', () => {
  const netzteile = ref<Netzteil[]>([])
  const projekte = ref<Projektakku[]>([])
  const bestellungen = ref<AkkuBestellung[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  const settings = useSettingsStore()
  const buchungStore = useBuchungStore()
  const standortStore = useStandortStore()
  const mindestbestandStore = useArtikelStandortMindestbestandStore()
  const auth = useAuthStore()

  /** Konfigurierte Akku-Groessen (globale Einstellung `akkuTypen`). */
  const typen = computed<AkkuTyp[]>(() => settings.settings.akkuTypen)
  /** Das Hauptlager — dort wirkt der Mindestbestand als Reserve. */
  const hauptlagerId = computed<string | null>(() => standortStore.standardlager?.id ?? null)

  /** Quartal und Jahr der Planung. */
  const quartal = ref(aktuellesQuartal())
  const jahr = ref(new Date().getFullYear())

  function start() {
    // Bestand (Buchungen), Puffer (Konfiguration), Hauptlager (Standorte) und
    // Akku-Groessen (Einstellung) muessen live sein, damit die Planung
    // aktuell bleibt.
    buchungStore.start()
    settings.start()
    standortStore.start()
    mindestbestandStore.start()
    if (subscription) return
    subscription = liveQuery(async () => {
      const [n, p, b] = await Promise.all([
        getDb().akkuNetzteile.toArray(),
        getDb().akkuProjekte.toArray(),
        getDb().akkuBestellungen.toArray(),
      ])
      return { n, p, b }
    }).subscribe({
      next: (rows) => {
        netzteile.value = rows.n
        projekte.value = rows.p
        bestellungen.value = rows.b
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

  /** Puffer je Artikel-ID = Mindestbestand am Hauptlager. */
  const pufferJeArtikel = computed(() => {
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
      puffer: pufferJeArtikel.value,
      quartal: quartal.value,
      jahr: jahr.value,
    }),
  )

  /** Article IDs that belong to a configured battery size. */
  const akkuArtikelIds = computed<string[]>(() =>
    typen.value.map((typ) => typ.artikelId).filter((id): id is string => id !== null && id !== ''),
  )

  /**
   * Inventory cut-off of the battery articles (last four weeks). An empty or
   * stale inventory makes the planned stock undated and blocks ordering.
   */
  const inventurStatus = computed<InventurStatus>(() =>
    ermittleInventurStatus(buchungStore.buchungen, akkuArtikelIds.value),
  )

  /** Archived order of the selected quarter, if any. */
  const bestellungFuerQuartal = computed<AkkuBestellung | null>(() => {
    const treffer = bestellungen.value
      .filter((b) => b.jahr === jahr.value && b.quartal === quartal.value)
      .sort((a, b) => (a.bestelltAm < b.bestelltAm ? 1 : a.bestelltAm > b.bestelltAm ? -1 : 0))
    return treffer[0] ?? null
  })

  /**
   * Rewrites the minimum stock (buffer "zur freien Verfuegung") of every
   * battery article at the main warehouse after an order was confirmed:
   * `mindestbestand neu = bedarf - bestand`.
   *
   * Rows without demand (or with enough stock) end up at 0, which removes the
   * sparse configuration — the tool re-plans the buffer from quarter to
   * quarter. Rows without a linked article or without a main warehouse are
   * skipped, unchanged values do not create an outbox entry.
   */
  async function aktualisiereMindestbestaende(zeilen: readonly Planzeile[]): Promise<number> {
    const standortId = hauptlagerId.value
    if (!standortId) return 0

    let anzahl = 0
    for (const zeile of zeilen) {
      const artikelId = zeile.typ.artikelId
      if (!artikelId) continue
      const wert = neuerMindestbestand(zeile.bedarf, zeile.bestand)
      if (wert === mindestbestandStore.wertFuer(artikelId, standortId)) continue
      await mindestbestandStore.setzen(artikelId, standortId, wert)
      anzahl++
    }
    return anzahl
  }

  /**
   * Archives the current planning table as "ordered" for the selected
   * quarter. Afterwards the minimum stock of the battery articles is set to
   * `bedarf - bestand` (the snapshot keeps the previous buffer). Returns
   * `bestellung = null` when an order already exists or no valid inventory is
   * present.
   */
  async function bestellungMarkieren(): Promise<BestellungMarkierenErgebnis> {
    if (bestellungFuerQuartal.value) {
      return { bestellung: null, aktualisierteMindestbestaende: 0 }
    }
    const inventur = inventurStatus.value
    if (!inventur.gueltig) return { bestellung: null, aktualisierteMindestbestaende: 0 }

    const zeilen = planung.value.zeilen
    const bestellung: AkkuBestellung = {
      id: neueUuid(),
      quartal: quartal.value,
      jahr: jahr.value,
      bestelltAm: jetztIso(),
      bestelltVon: auth.erstelltVon,
      bestelltVonKuerzel: kuerzelAusName(auth.erstelltVon),
      inventurDatum: inventur.datum,
      inventurVonKuerzel: inventur.kuerzel,
      zeilen: zeilen.map((zeile) => ({
        typId: zeile.typ.id,
        kapazitaetAh: zeile.typ.kapazitaetAh,
        von: zeile.typ.von,
        bis: zeile.typ.bis,
        soll: zeile.bedarf,
        bestand: zeile.bestand,
        reserve: zeile.puffer,
        verfuegbar: zeile.verfuegbar,
        bedarf: zeile.bestellmenge,
      })),
    }
    await getDb().akkuBestellungen.add(bestellung)
    await queueOp('akku_bestellung', 'create', bestellung)

    const aktualisierteMindestbestaende = await aktualisiereMindestbestaende(zeilen)
    return { bestellung, aktualisierteMindestbestaende }
  }

  /**
   * Speichert den Puffer ("zur freien Verfuegung") eines Akku-Typs.
   *
   * Der Puffer wird als Mindestbestand des Akku-Artikels am Hauptlager
   * gefuehrt — dort greift er zugleich als Mindestbestand-Warnung. Ein Wert
   * von 0 entfernt die Konfiguration (Mindestbestand-Tabelle ist sparse).
   */
  async function pufferSpeichern(artikelId: string, wert: number): Promise<void> {
    const standortId = hauptlagerId.value
    if (!standortId || !artikelId) return
    await mindestbestandStore.setzen(artikelId, standortId, wert)
  }

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
    bestellungen,
    geladen,
    typen,
    hauptlagerId,
    quartal,
    jahr,
    aktiveNetzteile,
    aktiveProjekte,
    bestandJeArtikel,
    pufferJeArtikel,
    planung,
    akkuArtikelIds,
    inventurStatus,
    bestellungFuerQuartal,
    start,
    stop,
    bestellungMarkieren,
    pufferSpeichern,
    faelligkeitVon,
    netzteilSpeichern,
    netzteilLoeschen,
    projektSpeichern,
    projektLoeschen,
  }
})
