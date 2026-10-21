// DATANORM retention cron.
//
// Mirrors the backup cron (backup-cron.ts): a plain setInterval, no
// scheduling dependency. Ticks once a day shortly after midnight — the
// cleanup is cheap (a single indexed SELECT plus a few unlinks) and there is
// no reason to run it more often.
//
// Retention policy lives in cleanup.ts; this file only decides *when*.

import type { FastifyBaseLogger } from 'fastify'
import { raeumeAlteDateien } from './cleanup.js'

let _interval: ReturnType<typeof setInterval> | null = null
let _letzterLauf: Date | null = null

/** How often the tick checks whether it is time to clean up. */
const TICK_MS = 60 * 60 * 1000 // hourly check
/** Only clean within this window after midnight, so a restart loop cannot
 *  trigger repeated cleanups. */
const FENSTER_START = 1 // 01:00
const FENSTER_ENDE = 3 // 03:00

export function datanormCronStatus(): { letzterLauf: string | null } {
  return { letzterLauf: _letzterLauf?.toISOString() ?? null }
}

export function starteDatanormCron(log: FastifyBaseLogger): void {
  if (_interval) return
  log.info('[datanorm-cron] gestartet (Aufraeumen der Katalogdateien)')
  _interval = setInterval(() => {
    void tick(log).catch((e) => log.error({ err: e }, '[datanorm-cron] tick fehlgeschlagen'))
  }, TICK_MS)
  // Don't keep the process alive just for the timer.
  _interval.unref?.()
}

export function stoppeDatanormCron(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  const now = new Date()
  const stunde = now.getHours()
  if (stunde < FENSTER_START || stunde >= FENSTER_ENDE) return
  // Already ran today?
  if (_letzterLauf && _letzterLauf.toDateString() === now.toDateString()) return

  _letzterLauf = now
  const ergebnis = await raeumeAlteDateien(log)
  if (ergebnis.geloescht > 0) {
    log.info(
      { geloescht: ergebnis.geloescht, geprueft: ergebnis.geprueft },
      '[datanorm-cron] alte Katalogdateien entfernt',
    )
  }
}