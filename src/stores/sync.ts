// Sync-Store: hält den aktuellen Sync-Status aus dem Worker.
// Wird in AppShell als Status-Indikator angezeigt.

import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  getSyncStatus,
  onSyncStatus,
  refreshStatus,
  startSyncWorker,
  stopSyncWorker,
  triggerSyncNow,
  type SyncStatus,
} from '../services/sync/worker'

export const useSyncStore = defineStore('sync', () => {
  const status = ref<SyncStatus>(getSyncStatus())
  const triggering = ref(false)

  function bind(): void {
    onSyncStatus((next) => {
      status.value = next
    })
  }

  function start(opts: {
    apiBase: string
    getToken: () => string | null
    intervalSek?: number
    onAuthRevoked?: () => void
  }): void {
    bind()
    startSyncWorker(opts)
  }

  function stop(): void {
    stopSyncWorker()
  }

  async function syncNow(apiBase: string, getToken: () => string | null): Promise<void> {
    if (triggering.value) return
    triggering.value = true
    try {
      await triggerSyncNow({ apiBase, token: getToken() })
    } finally {
      triggering.value = false
    }
  }

  async function refresh(apiBase: string, getToken: () => string | null): Promise<void> {
    await refreshStatus({ apiBase, token: getToken() })
  }

  return { status, triggering, start, stop, bind, syncNow, refresh }
})
