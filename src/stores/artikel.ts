// Artikel-Store: lädt die `artikel`-Tabelle reaktiv via Dexie liveQuery.
// Stellt Suche/Filter bereit; Mutationen (anlegen/ändern/archivieren) hier,
// weil Artikel kein Buchungs-Fachobjekt sind und keine Domain-Schicht haben.
// Schreiboperationen befüllen die Outbox für den Server-Sync.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Artikel, ArtikelStatus, NachbestellHinweis } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'

export interface ArtikelEingabe {
  titel: string
  typ: string
  status?: ArtikelStatus
  sharePointId?: number | null
  foto?: string | null
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

export interface ArtikelFilter {
  suche?: string
  typ?: string
  status?: ArtikelStatus | 'alle'
}

export const useArtikelStore = defineStore('artikel', () => {
  const artikel = ref<Artikel[]>([])
  const geladen = ref(false)
  const filter = ref<ArtikelFilter>({ status: 'verfuegbar' })
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

  const gefiltert = computed<Artikel[]>(() => {
    const f = filter.value
    const suche = (f.suche ?? '').trim().toLowerCase()
    return artikel.value.filter((a) => {
      if (f.status && f.status !== 'alle' && a.status !== f.status) return false
      if (f.typ && a.typ !== f.typ) return false
      if (suche) {
        const haystack =
          `${a.titel} ${a.typ} ${a.lieferant ?? ''} ${a.bestellnummer ?? ''}`.toLowerCase()
        if (!haystack.includes(suche)) return false
      }
      return true
    })
  })

  function setFilter(next: ArtikelFilter): void {
    filter.value = next
  }

  async function anlegen(e: ArtikelEingabe): Promise<Artikel> {
    const now = jetztIso()
    const a: Artikel = {
      id: neueUuid(),
      sharePointId: e.sharePointId ?? null,
      foto: e.foto ?? null,
      fotoUrls: e.foto ? [e.foto] : [],
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

  /** Hängt eine Foto-URL an einen Artikel an (z. B. nach Server-Upload). */
  async function fotoHinzufuegen(artikelId: string, url: string): Promise<void> {
    const a = await getDb().artikel.get(artikelId)
    if (!a) throw new Error(`Artikel ${artikelId} nicht gefunden`)
    const urls = a.fotoUrls ?? []
    if (urls.includes(url)) return
    const updated: Artikel = {
      ...a,
      fotoUrls: [...urls, url],
      geaendertAm: jetztIso(),
    }
    await getDb().artikel.put(updated)
    await queueOp('artikel', 'update', updated)
  }

  /** Entfernt eine Foto-URL. */
  async function fotoEntfernen(artikelId: string, url: string): Promise<void> {
    const a = await getDb().artikel.get(artikelId)
    if (!a) return
    const updated: Artikel = {
      ...a,
      fotoUrls: (a.fotoUrls ?? []).filter((u) => u !== url),
      geaendertAm: jetztIso(),
    }
    await getDb().artikel.put(updated)
    await queueOp('artikel', 'update', updated)
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

  return {
    artikel,
    gefiltert,
    filter,
    geladen,
    start,
    stop,
    byId,
    setFilter,
    anlegen,
    aktualisieren,
    archivieren,
    fotoHinzufuegen,
    fotoEntfernen,
  }
})
