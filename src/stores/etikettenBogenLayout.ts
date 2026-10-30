// Etiketten-Bogen-Layout-Store: speichert das benutzerdefinierte
// Bogen-Layout (Preset "Benutzerdefiniert") serverseitig pro User.
//
// Das Layout ersetzt die bisher nur clientseitig (Vue-Ref, ohne Persistenz)
// gehaltenen Werte. Es wird über die Dexie-Tabelle `etikettenBogenLayout`
// reaktiv gelesen und per Outbox zum Server gepusht (LWW auf geaendertAm).
// Pro User existiert maximal ein Layout (unique auf user_id).

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import { sessionLesen } from '../auth/session'
import { jetztIso } from '../domain/ids'
import { queueOp } from '../services/sync/worker'
import type { EtikettenBogenLayout } from '../db/types'

const DEFAULTS: EtikettenBogenLayout['layout'] = {
  id: 'benutzerdefiniert',
  layout: 'raster',
  cols: 3,
  rows: 7,
  labelW: 63.5,
  labelH: 38.1,
  gapX: 2.5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

/** Aktueller User aus der Session (null = nicht angemeldet). */
function currentUserId(): string | null {
  return sessionLesen()?.userId ?? null
}

export const useEtikettenBogenLayoutStore = defineStore('etikettenBogenLayout', () => {
  const layout = ref<EtikettenBogenLayout['layout'] | null>(null)
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() => getDb().etikettenBogenLayout.toArray()).subscribe({
      next: (rows) => {
        const userId = currentUserId()
        const row = userId !== null ? rows.find((r) => r.userId === userId) : null
        layout.value = row?.layout ?? null
        geladen.value = true
      },
      error: (e) => {
        console.error('[etikettenBogenLayout] liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  /**
   * Speichert das benutzerdefinierte Bogen-Layout.
   * Schreibt lokal in IndexedDB und erzeugt einen Outbox-Eintrag für den
   * Server-Sync. `id` ist fest `benutzerdefiniert` (ein Layout pro User).
   */
  async function setLayout(wert: EtikettenBogenLayout['layout']): Promise<void> {
    const userId = currentUserId()
    if (userId === null) {
      console.warn('[etikettenBogenLayout] Layout ohne angemeldeten User nicht gespeichert')
      return
    }

    const geaendertAm = jetztIso()
    const row: EtikettenBogenLayout = {
      id: 'benutzerdefiniert',
      userId,
      layout: wert,
      geaendertAm,
      erstelltAm: geaendertAm,
    }
    await getDb().etikettenBogenLayout.put(row)
    layout.value = wert

    const outboxRow: EtikettenBogenLayout = {
      id: 'benutzerdefiniert',
      userId,
      layout: wert,
      geaendertAm,
      erstelltAm: geaendertAm,
    }
    await queueOp('etiketten_bogen_layout', 'upsert', outboxRow)
  }

  /**
   * Löscht das benutzerdefinierte Layout (Reset auf Defaults).
   */
  async function deleteLayout(): Promise<void> {
    const userId = currentUserId()
    if (userId === null) return

    await getDb().etikettenBogenLayout.delete('benutzerdefiniert')
    layout.value = null

    await queueOp('etiketten_bogen_layout', 'delete', {
      id: 'benutzerdefiniert',
      userId,
    })
  }

  return {
    layout,
    geladen,
    start,
    stop,
    setLayout,
    deleteLayout,
    DEFAULTS,
  }
})
