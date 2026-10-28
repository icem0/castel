// Regressionstests für das Stop-Verhalten des Sync-Workers.
//
// Hintergrund: `stopSyncWorker()` hat früher nur das `setInterval`
// gelöscht, die `online`/`visibilitychange`-Listener aber hängen
// gelassen. Ein Tab-Wechsel oder ein Netzwerk-Flap nach dem Stop hat
// dadurch einen Sync gestartet, der die gerade geleerte IndexedDB
// (Admin-Flow "Lokale DB löschen") sofort wieder geöffnet und
// teilweise befüllt hat. `stopSyncWorker()` muss den Worker jetzt
// vollständig anhalten.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { CastelDb, setDb } from '../../../db/database'
import {
  runSync,
  startSyncWorker,
  stopSyncWorker,
  suspendSyncWorker,
  _resetSyncForTests,
} from '../worker'

let fetchMock: ReturnType<typeof vi.fn>

function sichtbar(setzen: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: setzen ? 'visible' : 'hidden',
    configurable: true,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  _resetSyncForTests()
  setDb(new CastelDb(`castel-stop-test-${Math.random().toString(36).slice(2)}`))
  fetchMock = vi.fn(async () => new Response('{}', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  sichtbar(false)
})

afterEach(() => {
  stopSyncWorker()
  _resetSyncForTests()
  vi.unstubAllGlobals()
})

describe('stopSyncWorker', () => {
  it('startet nach stopSyncWorker() keinen Sync mehr beim visibilitychange', async () => {
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })
    stopSyncWorker()

    sichtbar(true)
    await new Promise((r) => setTimeout(r, 50))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('startet nach stopSyncWorker() keinen Sync mehr beim online-Event', async () => {
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })
    stopSyncWorker()

    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 50))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bricht auch den Boot-Tick (setTimeout nach 2 s) ab', async () => {
    vi.useFakeTimers()
    try {
      startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })
      stopSyncWorker()
      await vi.advanceTimersByTimeAsync(5000)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runSync() ist ein No-Op, solange der Worker gestoppt ist', async () => {
    stopSyncWorker()
    await runSync({ token: null, apiBase: 'http://test.local' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('startSyncWorker() nach stopSyncWorker() funktioniert wieder (Listener einmalig)', async () => {
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })
    stopSyncWorker()
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })

    fetchMock.mockClear()
    sichtbar(true)

    // Genau ein Sync-Lauf, nicht zwei (kein doppelt registrierter Listener).
    // Ein Sync-Lauf holt den Snapshot; der Restore-Epoche-Check davor ist
    // ein eigener, zusaetzlicher Request — deshalb zaehlen wir die
    // Snapshot-Requests und nicht alle Fetches.
    const snapshotRequests = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/sync/snapshot')).length
    await vi.waitFor(() => expect(snapshotRequests()).toBe(1))
    // Kein zweiter Sync-Lauf durch einen doppelt registrierten Listener.
    await new Promise((r) => setTimeout(r, 50))
    expect(snapshotRequests()).toBe(1)
  })

  it('suspendSyncWorker() blocks a restart triggered by the app', async () => {
    suspendSyncWorker()
    // Mimics App.vue's watchEffect calling sync.start() again.
    startSyncWorker({ apiBase: 'http://test.local', getToken: () => null, intervalSek: 3600 })

    sichtbar(true)
    window.dispatchEvent(new Event('online'))
    await new Promise((r) => setTimeout(r, 50))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
