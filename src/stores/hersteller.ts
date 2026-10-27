// Hersteller-Store: laedt die `hersteller`-Tabelle reaktiv via Dexie liveQuery.
//
// Hersteller sind Stammdaten (Bestellkontakt: E-Mail oder Webseite) und
// werden wie Artikel per Last-Writer-Wins synchronisiert. Sie ersetzen den
// frueheren Freitext-Lieferanten im Artikelformular, waehrend das Feld
// `artikel.lieferant` fuer DATANORM/CSV-Import erhalten bleibt.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Hersteller } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { sortiereNachName } from '../domain/sortierung'
import { queueOp } from '../services/sync/worker'

export interface HerstellerEingabe {
  name: string
  bestellEmail?: string | null
  bestellWebseite?: string | null
}

export const useHerstellerStore = defineStore('hersteller', () => {
  const hersteller = ref<Hersteller[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() => getDb().hersteller.toArray()).subscribe({
      next: (rows) => {
        hersteller.value = sortiereNachName(rows, (h) => h.name)
        geladen.value = true
      },
      error: (e) => {
        console.error('hersteller liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  function byId(id: string): Hersteller | undefined {
    return hersteller.value.find((h) => h.id === id)
  }

  /** Case-insensitiver Lookup ueber den Namen (Picker-Dedupe). */
  function byName(name: string): Hersteller | undefined {
    const needle = name.trim().toLowerCase()
    if (needle === '') return undefined
    return hersteller.value.find((h) => h.name.trim().toLowerCase() === needle)
  }

  async function anlegen(e: HerstellerEingabe): Promise<Hersteller> {
    const now = jetztIso()
    const h: Hersteller = {
      id: neueUuid(),
      name: e.name.trim(),
      bestellEmail: e.bestellEmail?.trim() || null,
      bestellWebseite: e.bestellWebseite?.trim() || null,
      geaendertAm: now,
      erstelltAm: now,
    }
    await getDb().hersteller.add(h)
    await queueOp('hersteller', 'create', h)
    return h
  }

  async function aktualisieren(id: string, patch: Partial<Hersteller>): Promise<void> {
    const h = await getDb().hersteller.get(id)
    if (!h) throw new Error(`Hersteller ${id} nicht gefunden`)
    const updated: Hersteller = { ...h, ...patch, geaendertAm: jetztIso() }
    await getDb().hersteller.put(updated)
    await queueOp('hersteller', 'update', updated)
  }

  async function loeschen(id: string): Promise<void> {
    const h = await getDb().hersteller.get(id)
    if (!h) return
    await getDb().hersteller.delete(id)
    await queueOp('hersteller', 'delete', h)
  }

  return {
    hersteller,
    geladen,
    start,
    stop,
    byId,
    byName,
    anlegen,
    aktualisieren,
    loeschen,
  }
})
