// Server-interne `einstellungen`-Marker.
//
// Diese Keys duerfen den Sync in keine Richtung passieren:
//   * NICHT in den Snapshot (sonst landen sie in der IndexedDB der Clients)
//   * NICHT als Push zurueck (ein veralteter Client wuerde einen alten Wert
//     zurueckschreiben und z. B. einen bereits beanspruchten Backup-Tages-
//     Slot wieder scharf machen — der Cron feuerte erneut, Backups im
//     Minuten-Takt)
//
// Der Resolver ignoriert Pushes dieser Keys; die Sync-Routes filtern sie aus
// dem `einstellungen`-Array des Snapshots. Clientseitig stehen dieselben
// Keys auf der Reseed-Blockliste (src/services/sync/reseed-server.ts).

export const INTERN_EINSTELLUNGS_KEYS: readonly string[] = [
  'sync.forceAt',
  'backup.lastSlot',
  'server.restoreEpoch',
]

export function istInterneEinstellung(key: string): boolean {
  return INTERN_EINSTELLUNGS_KEYS.includes(key)
}
