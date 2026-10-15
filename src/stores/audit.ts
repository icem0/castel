// Audit-Store: liest den `auditLog` reaktiv via Dexie liveQuery.
// Schreibend: ausschließlich die Domain-Schicht (PLAN §4.6).

import { defineStore } from 'pinia'
import { liveQuery, type Subscription } from 'dexie'
import { ref, onScopeDispose } from 'vue'
import { getDb } from '../db/database'
import type { AuditLogEintrag } from '../db/types'

export const useAuditStore = defineStore('audit', () => {
  const eintraege = ref<AuditLogEintrag[]>([])
  const geladen = ref(false)
  let subscription: Subscription | null = null

  function start() {
    if (subscription) return
    subscription = liveQuery(() =>
      getDb().auditLog.orderBy('zeit').reverse().limit(500).toArray(),
    ).subscribe({
      next: (rows) => {
        eintraege.value = rows
        geladen.value = true
      },
      error: (e) => {
        console.error('audit liveQuery error:', e)
      },
    })
  }

  function stop() {
    subscription?.unsubscribe()
    subscription = null
  }

  onScopeDispose(stop)

  return { eintraege, geladen, start, stop }
})
