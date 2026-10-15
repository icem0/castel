// Service-Worker-Helfer: leert alle Caches, triggert skipWaiting und
// uncontrolled reloads den Client, sobald der neue SW übernimmt.
// IndexedDB und das `castel.auth.jwt` in localStorage bleiben unangetastet.

export interface ClearCacheResult {
  cacheNames: string[]
  reloaded: boolean
}

/**
 * Löscht alle Browser-Caches (Workbox-Caches, app-shell, bilder, etc.) und
 * fordert den Service Worker auf, sich sofort zu aktivieren. Liefert true,
 * wenn ein Reload ausgelöst wurde.
 */
export async function clearAppCacheAndReload(): Promise<ClearCacheResult> {
  const cacheNames = typeof caches !== 'undefined' ? await caches.keys() : []
  await Promise.all(cacheNames.map((name) => caches.delete(name)))

  let reloaded = false
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations()
    for (const reg of regs) {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' })
      } else {
        await reg.update().catch(() => undefined)
      }
    }

    if (navigator.serviceWorker.controller) {
      reloaded = true
      window.location.reload()
    } else {
      // Kein aktiver Controller — Reload erzwingt Übernahme des neuen SW.
      reloaded = true
      window.location.reload()
    }
  }

  return { cacheNames, reloaded }
}
