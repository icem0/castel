// Modul: Identitaet eines Endgeraets.
//
// Jede PWA-Instanz erzeugt sich einmalig eine eigene Geraete-UUID und
// speichert sie im localStorage. Damit ueberlebt sie ein hartes Loeschen
// der IndexedDB (das beim Geräte-Reset passiert) und kann dem Server
// zugewiesen werden (/api/sync/device-heartbeat).
//
// Der Server setzt pro Geraet ein Reset-Flag (`reset_am`). Prueft das
// Geraet beim Heartbeat, dass sein Flag neuer ist als der letzte vom
// Geraet selbst angewendete Reset, loescht es die lokale IndexedDB und
// baut sie vom Server neu auf.

const LS_DEVICE_ID = 'castel.device.id'
const LS_DEVICE_LAST_RESET = 'castel.device.lastAppliedResetAt'

let deviceIdCache: string | null = null

/** Geraete-UUID dieser PWA-Instanz (wird einmalig erzeugt, nie geloescht). */
export function leseGerateId(): string {
  if (deviceIdCache !== null) return deviceIdCache
  let id = localStorage.getItem(LS_DEVICE_ID)
  if (!id || id.length === 0) {
    id = crypto.randomUUID()
    localStorage.setItem(LS_DEVICE_ID, id)
  }
  deviceIdCache = id
  return id
}

/** Zeitstempel des zuletzt vom Geraet selbst angewendeten Resets. */
export function leseZuletztAngewendeterReset(): string | null {
  return localStorage.getItem(LS_DEVICE_LAST_RESET)
}

/** Merkt sich, dass der Geraete-Reset mit dem gegebenen Zeitstempel angewendet wurde. */
export function schreibeZuletztAngewendeterReset(zeitstempel: string | null): void {
  if (zeitstempel === null) {
    localStorage.removeItem(LS_DEVICE_LAST_RESET)
  } else {
    localStorage.setItem(LS_DEVICE_LAST_RESET, zeitstempel)
  }
}
