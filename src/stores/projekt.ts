// Projekt-Store: lädt die `projekte`-Tabelle reaktiv via Dexie liveQuery.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Projekt } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'

export interface ProjektEingabe {
  nummer: string
  name?: string | null
}

export const useProjektStore = defineStore('projekt', () => {
  const projekte = ref<Projekt[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() =>
      // Indexierter Zugriff auf `archiviert` (Dexie v1+).
      // IndexedDB speichert booleans als 0/1 — `equals(0)` = `false`.
      getDb().projekte.where('archiviert').equals(0).toArray(),
    ).subscribe({
      next: (rows) => {
        projekte.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('projekt liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  function byNummer(nummer: string): Projekt | undefined {
    return projekte.value.find((p) => p.nummer === nummer)
  }

  async function anlegen(e: ProjektEingabe): Promise<Projekt> {
    const now = jetztIso()
    const p: Projekt = {
      id: neueUuid(),
      nummer: e.nummer,
      name: e.name ?? null,
      archiviert: false,
      geaendertAm: now,
      erstelltAm: now,
    }
    await getDb().projekte.add(p)
    await queueOp('projekt', 'create', p)
    return p
  }

  async function archivieren(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().projekte.update(id, { archiviert: true, geaendertAm: now })
    const updated = await getDb().projekte.get(id)
    if (updated) await queueOp('projekt', 'update', updated)
  }

  return { projekte, geladen, start, stop, byNummer, anlegen, archivieren }
})
