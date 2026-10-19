// Artikel-Store: lädt die `artikel`-Tabelle reaktiv via Dexie liveQuery.
// Mutationen (anlegen/ändern/archivieren/löschen) hier, weil Artikel kein
// Buchungs-Fachobjekt sind und keine Domain-Schicht haben. Schreiboperationen
// befüllen die Outbox für den Server-Sync.
// Filter (Suche/Typ/Status/Standort) liegen absichtlich NICHT hier — siehe
// den Hinweis weiter unten.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Artikel, ArtikelStatus, NachbestellHinweis } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'

export interface ArtikelEingabe {
  titel: string
  typ: string
  status?: ArtikelStatus
  sharePointId?: number | null
  lieferant?: string | null
  verpackungseinheit?: number
  mindestbestand?: number | null
  nachbestellHinweis?: NachbestellHinweis
  bestellnummer?: string | null
  /** Strichcode (EAN/Code128/QR). Semantisch getrennt von
   *  `bestellnummer` (Lieferanten-Bestellnr. vs. Strichcode am Artikel). */
  barcode?: string | null
  listenpreis?: number | null
}

// Hinweis: Filter (Suche/Typ/Status/Standort) leben absichtlich NICHT im
// Store, sondern nur lokal in der ArtikelListView. Grund war ein Bug, bei
// dem eine in /artikel gesetzte Filterauswahl die Dashboard-Zählung
// (`artikelStore.gefiltert.length`) überschrieben hat. Wenn weitere Views
// dieselbe Filter-Logik brauchen, sollte sie in einen eigenen
// `useArtikelFilter`-Composable wandern, statt hier wieder global zu werden.

export const useArtikelStore = defineStore('artikel', () => {
  const artikel = ref<Artikel[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() => getDb().artikel.toArray()).subscribe({
      next: (rows) => {
        artikel.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('artikel liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  function byId(id: string): Artikel | undefined {
    return artikel.value.find((a) => a.id === id)
  }

  async function anlegen(e: ArtikelEingabe): Promise<Artikel> {
    const now = jetztIso()
    const a: Artikel = {
      id: neueUuid(),
      sharePointId: e.sharePointId ?? null,
      titel: e.titel,
      status: e.status ?? 'verfuegbar',
      typ: e.typ,
      lieferant: e.lieferant ?? null,
      verpackungseinheit: e.verpackungseinheit ?? 1,
      mindestbestand: e.mindestbestand ?? null,
      nachbestellHinweis: e.nachbestellHinweis ?? null,
      bestellnummer: e.bestellnummer ?? null,
      barcode: e.barcode ?? null,
      listenpreis: e.listenpreis ?? null,
      geaendertAm: now,
      erstelltAm: now,
    }
    await getDb().artikel.add(a)
    await queueOp('artikel', 'create', a)
    return a
  }

  async function aktualisieren(id: string, patch: Partial<Artikel>): Promise<void> {
    const a = await getDb().artikel.get(id)
    if (!a) throw new Error(`Artikel ${id} nicht gefunden`)
    const updated: Artikel = { ...a, ...patch, geaendertAm: jetztIso() }
    await getDb().artikel.put(updated)
    await queueOp('artikel', 'update', updated)
  }

  async function archivieren(id: string): Promise<void> {
    const a = await getDb().artikel.get(id)
    if (!a) return
    const updated: Artikel = { ...a, status: 'archiviert', geaendertAm: jetztIso() }
    await getDb().artikel.put(updated)
    await queueOp('artikel', 'update', updated)
  }

  /**
   * Löscht einen Artikel unwiderruflich. Voraussetzung: keine Buchungen
   * und keine Mindestbestand-Ereignisse verweisen auf ihn. Die Prüfung
   * übernimmt der Server (`HAS_DEPENDENCIES`); die UI deaktiviert den
   * Button vorsorglich, sobald `byArtikel(id).length > 0` ist. Der
   * Outbox-Op wird ohne Payload gespeichert — die Identität ist die
   * `artikel.id` (siehe `payloadIdFor`). Falls der Server das Löschen
   * ablehnt, landet das Item in der Quarantäne.
   */
  async function loeschen(id: string): Promise<void> {
    const a = await getDb().artikel.get(id)
    if (!a) return
    await getDb().artikel.delete(id)
    // Foto-Mirror brauchen wir nicht — Fotos leben nur auf dem Server
    // (siehe Fotos-Upload-Kommentar im FotoUpload.vue). Audit-Log
    // ebenfalls nur lokal; für Diagnose reichen die Server-Logs.
    await queueOp('artikel', 'delete', a)
  }

  return {
    artikel,
    geladen,
    start,
    stop,
    byId,
    anlegen,
    aktualisieren,
    archivieren,
    loeschen,
  }
})
