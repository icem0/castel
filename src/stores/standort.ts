// Standort-Store: lädt die `standorte`-Tabelle reaktiv via Dexie liveQuery.
// Stellt außerdem Helfer für Standard-Standort und Filter bereit.

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { computed, ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { Standort, StandortTyp } from '../db/types'
import { neueUuid, jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'

export interface StandortEingabe {
  name: string
  typ: StandortTyp
  projekt?: string | null
  kennzeichen?: string | null
  standard?: boolean
}

export const useStandortStore = defineStore('standort', () => {
  const standorte = ref<Standort[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() => getDb().standorte.toArray()).subscribe({
      next: (rows) => {
        standorte.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('standort liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  const aktive = computed(() => standorte.value.filter((s) => !s.archiviert))
  const archivierte = computed(() => standorte.value.filter((s) => s.archiviert))
  const standardlager = computed(() => aktive.value.find((s) => s.standard) ?? null)
  const nachTyp = computed(() => {
    const m = new Map<StandortTyp, Standort[]>()
    for (const s of aktive.value) {
      const list = m.get(s.typ) ?? []
      list.push(s)
      m.set(s.typ, list)
    }
    return m
  })

  function byId(id: string): Standort | undefined {
    return standorte.value.find((s) => s.id === id)
  }

  async function anlegen(e: StandortEingabe): Promise<Standort> {
    const s: Standort = {
      id: neueUuid(),
      name: e.name,
      typ: e.typ,
      projekt: e.projekt ?? null,
      kennzeichen: e.kennzeichen ?? null,
      standard: e.standard ?? false,
      archiviert: false,
      geaendertAm: jetztIso(),
      erstelltAm: jetztIso(),
    }
    await getDb().transaction('rw', getDb().standorte, async () => {
      if (s.standard) {
        // Indexierter Zugriff auf `standard` (Dexie v5+).
        // IndexedDB speichert booleans als 0/1 — `equals(1)` = `true`.
        await getDb().standorte.where('standard').equals(1).modify({ standard: false })
      }
      await getDb().standorte.add(s)
    })
    await queueOp('standort', 'create', s)
    return s
  }

  async function setStandard(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().transaction('rw', getDb().standorte, async () => {
      await getDb()
        .standorte.where('standard')
        .equals(1)
        .modify({ standard: false, geaendertAm: now })
      await getDb().standorte.update(id, { standard: true, geaendertAm: now })
    })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  async function archivieren(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().standorte.update(id, { archiviert: true, standard: false, geaendertAm: now })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  async function wiederherstellen(id: string): Promise<void> {
    const now = jetztIso()
    await getDb().standorte.update(id, { archiviert: false, geaendertAm: now })
    const updated = await getDb().standorte.get(id)
    if (updated) await queueOp('standort', 'update', updated)
  }

  return {
    standorte,
    aktive,
    archivierte,
    standardlager,
    nachTyp,
    geladen,
    start,
    stop,
    byId,
    anlegen,
    setStandard,
    archivieren,
    wiederherstellen,
  }
})
