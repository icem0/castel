// Pure Slot-Logik fuer den Backup-Cron. Kein DB-, Config- oder
// Modulimport — dadurch in Unit-Tests ohne Test-Setups verwendbar.

const SCHEDULE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Liefert true, wenn `now` (Date) >= dem naechsten Auftreten von HH:MM
 * (heute) ist UND der Cron seit dem letzten Tages-Slot noch nicht
 * gefeuert hat. Wird vom Cron-Tick benutzt, um genau einmal pro Tag
 * zu feuern — wir merken uns das letzte Feuer-Datum pro Server.
 */
export function sollteJetztFeuern(
  now: Date,
  schedule: string,
  lastRun: Date | null,
): boolean {
  if (!SCHEDULE_RE.test(schedule)) return false
  const [hh, mm] = schedule.split(':').map((s) => Number.parseInt(s, 10))
  const today = new Date(now)
  today.setHours(hh ?? 0, mm ?? 0, 0, 0)
  if (now < today) return false
  if (lastRun && lastRun >= today) return false
  return true
}
