// Backup-Cron: tickt jede Minute, feuert genau einmal pro Tag zur
// eingestellten HH:MM (lokale Server-Zeit). Wird beim Server-Start
// einmal initialisiert, dann unaufgeregt im Hintergrund mit.
//
// Designprinzip: kein node-cron, kein node-schedule, keine zusaetzliche
// Dependency. Ein setInterval(60_000) reicht, weil die Schedule-Granularitaet
// Minuten ist. Der Drift wird beim naechsten Tick automatisch korrigiert.
//
// Der "heute schon gefeuert?"-Schutz liegt in der DB (backup.lastSlot,
// atomarer Claim in beansprucheTagesSlot), NICHT im Prozess: ein In-Memory-
// Marker faellt bei jedem API-Neustart aus und der Cron wuerde nach einem
// Crash (z. B. pg_dump-OOM) oder Re-Deploy bei jedem Boot sofort erneut
// feuern — Backups im Minuten-Takt.

import { createWriteStream } from 'node:fs'
import type { FastifyBaseLogger } from 'fastify'
import {
  baueBackupZip,
  backupDateiPfad,
  beansprucheTagesSlot,
  ensureBackupDir,
  leseBackupSettings,
  listeBackups,
  pgDumpStream,
  rotiereAlteBackups,
  triggerSyncForce,
  warteAufSyncIdle,
} from './backup.js'
import { tagesSlotFuer } from './backup-cron-slot.js'
import { config } from '../config/config.js'

let _interval: ReturnType<typeof setInterval> | null = null
let _letzterLauf: Date | null = null
let _letzterSlot: string | null = null
let _letzterVersuch: { ok: boolean; filename?: string; fehler?: string } | null = null

export function backupCronStatus(): {
  letzterLauf: string | null
  /** Der zuletzt geclaimte Tages-Slot (`YYYY-MM-DD`), oder null. */
  letzterSlot: string | null
  letzterVersuch: typeof _letzterVersuch
} {
  return {
    letzterLauf: _letzterLauf?.toISOString() ?? null,
    letzterSlot: _letzterSlot,
    letzterVersuch: _letzterVersuch,
  }
}

export function starteBackupCron(log: FastifyBaseLogger): void {
  if (_interval) return
  log.info('[backup-cron] gestartet (tick jede Minute)')
  _interval = setInterval(() => {
    void tick(log).catch((e) => log.error({ err: e }, '[backup-cron] tick fehlgeschlagen'))
  }, 60_000)
}

export function stoppeBackupCron(): void {
  if (_interval) {
    clearInterval(_interval)
    _interval = null
  }
}

async function tick(log: FastifyBaseLogger): Promise<void> {
  const settings = await leseBackupSettings()
  const slot = tagesSlotFuer(new Date(), settings.schedule)
  if (slot === null) return
  // Billiger In-Memory-Vorfilter: dieser Prozess hat den Slot bereits
  // behandelt (geclaimt oder fremd geclaimt). Der eigentliche Schutz ist
  // der DB-Claim — er haelt auch gegen Neustarts und zweite Instanzen.
  if (slot === _letzterSlot) return
  if (!(await beansprucheTagesSlot(slot))) {
    // Slot bereits besetzt (anderer Prozess oder fruherer Lauf vor dem
    // Neustart). Merken, damit wir nicht bei jedem Tick erneut claimen.
    _letzterSlot = slot
    return
  }
  _letzterSlot = slot
  log.info({ schedule: settings.schedule, slot }, '[backup-cron] feuere Backup')
  await runOnce(log, settings.keepCopies)
}

export async function runOnce(log: FastifyBaseLogger, keepCopies: number): Promise<void> {
  const start = Date.now()
  _letzterLauf = new Date()
  let pfad: string | null = null
  try {
    await ensureBackupDir()
    const forceAt = await triggerSyncForce()
    const wait = await warteAufSyncIdle(log)
    const pgDump = pgDumpStream(config.DATABASE_URL)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `castel-backup-${stamp}.zip`
    pfad = backupDateiPfad(filename)
    const fileStream = createWriteStream(pfad)
    const result = await baueBackupZip({
      out: fileStream,
      pgDump,
      forceAt,
      dbCounts: { buchungen: wait.lastCount },
      tool: 'api/admin/backup.cron',
    })
    const geloescht = await rotiereAlteBackups(keepCopies)
    const files = await listeBackups()
    log.info(
      {
        filename,
        bytes: result.bytes,
        dumpBytes: result.dumpBytes,
        geloescht,
        total: files.length,
        dauerMs: Date.now() - start,
      },
      '[backup-cron] fertig',
    )
    _letzterVersuch = { ok: true, filename }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Unvollstaendige ZIP loeschen — sie wuerde sonst in der Liste
    // erscheinen und bei der Rotation mitzaehlen.
    if (pfad !== null) {
      try {
        const { unlink } = await import('node:fs/promises')
        await unlink(pfad)
      } catch {
        /* Datei schon weg — egal */
      }
    }
    log.error({ err: e }, '[backup-cron] fehlgeschlagen')
    _letzterVersuch = { ok: false, fehler: msg }
  }
}
