// Pure Slot-Logik fuer den Backup-Cron. Kein DB-, Config- oder
// Modulimport — dadurch in Unit-Tests ohne Test-Setups verwendbar.

const SCHEDULE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Liefert das lokale Datum (`YYYY-MM-DD`) des heutigen HH:MM-Slots, sobald
 * `now` den Slot erreicht hat — sonst null (Schedule leer/ungueltig oder der
 * Slot liegt heute noch in der Zukunft).
 *
 * Der zurueckgegebene String ist die ID des Tages-Slots. Diese ID wird vom
 * Cron im DB-Marker `backup.lastSlot` gespeichert (atomarer Claim in
 * `beansprucheTagesSlot`). Dadurch ueberlebt die "genau einmal pro Tag"-
 * Aussage API-Neustarts, Crash-Loops und Mehrinstanzenbetrieb: ein reiner
 * In-Memory-Marker wurde bei jedem Boot verloren gehen und der Cron waere
 * sofort wieder "faellig" (Catch-up, weil `now` den Slot bereits ueber-
 * schritten hat) — das war der Fehler hinter Backups im Minuten-Takt.
 */
export function tagesSlotFuer(now: Date, schedule: string): string | null {
  if (!SCHEDULE_RE.test(schedule)) return null
  const [hh, mm] = schedule.split(':').map((s) => Number.parseInt(s, 10))
  const slot = new Date(now)
  slot.setHours(hh ?? 0, mm ?? 0, 0, 0)
  if (now < slot) return null
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
