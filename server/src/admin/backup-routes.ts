// Admin-Routes: Backup & Restore + Settings.
//
//   GET  /api/admin/backup/settings   -> { schedule, keepCopies }
//   PUT  /api/admin/backup/settings   -> setzt { schedule, keepCopies }
//   GET  /api/admin/backup/list       -> Liste der vorhandenen ZIPs
//   DELETE /api/admin/backup/:name    -> loescht ein einzelnes ZIP
//   POST /api/admin/backup/run        -> fuehrt ein Backup im Hintergrund aus,
//                                        antwortet sofort mit Job-ID
//   GET  /api/admin/backup/status/:jobId -> { status, filename?, error? }
//   POST /api/admin/backup/restore    -> laedt ein ZIP hoch, ruft pg_restore
//   GET  /api/admin/backup/file/:name -> Stream einer existierenden Datei
//
// Alle Endpoints sind admin-only (requireAdmin).

import type { FastifyInstance } from 'fastify'
import { unlink as fsUnlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { z } from 'zod'
import {
  baueBackupZip,
  backupDateiGroesse,
  backupDateiPfad,
  backupDateiStream,
  ensureBackupDir,
  leseBackupSettings,
  listeBackups,
  pgDumpStream,
  rotiereAlteBackups,
  restoreAusZip,
  schreibeBackupSettings,
  triggerSyncForce,
  warteAufSyncIdle,
  type SyncWaitOpts,
} from './backup.js'
import { config } from '../config/config.js'

// Kurzes Sync-Wait fuer die interaktiven HTTP-Endpunkte: Der manuelle
// Klick darf den Request nicht minutenlang offen halten — nginx im
// PWA-Container killt Proxy-Requests nach 60 s Default-Timeout, und
// der Sync-Worker der PWA pusht ohnehin alle 30 s von selbst. Der
// Cron (backup-cron.ts) nutzt die langen Config-Defaults.
const SYNC_WAIT_HTTP: SyncWaitOpts = { quietMs: 2000, timeoutMs: 15000 }

// ---------- In-Memory-Jobs fuer asynchrone Backups ----------
//
// Wird beim Server-Neustart verworfen — akzeptabel, da der Cron-Job
// ohnehin die Quelle fuer wiederkehrende Backups ist und manuelle
// Backups sofort im Volume sichtbar sind, sobald sie fertig sind.

interface BackupJob {
  status: 'running' | 'done' | 'failed'
  filename?: string
  error?: string
  createdAt: string
}

const backupJobs = new Map<string, BackupJob>

function neuerJobId(): string {
  return `backup-${Date.now().toString(36)}`
}

/**
 * Fuehrt ein Backup im Hintergrund durch: Sync-Trigger, pg_dump,
 * ZIP schreiben, Rotation. Schreibt das Ergebnis in den Job-Eintrag.
 */
async function fuehreBackupDurch(jobId: string, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void }): Promise<void> {
  const job = backupJobs.get(jobId)
  if (!job) return
  let pfad: string | null = null
  try {
    await ensureBackupDir()
    const forceAt = await triggerSyncForce()
    const wait = await warteAufSyncIdle(log, SYNC_WAIT_HTTP)
    const pgDump = pgDumpStream(config.DATABASE_URL)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `castel-backup-${stamp}.zip`
    pfad = backupDateiPfad(filename)
    const fileStream = createWriteStream(pfad)
    const settings = await leseBackupSettings()
    const result = await baueBackupZip({
      out: fileStream,
      pgDump,
      forceAt,
      dbCounts: { buchungen: wait.lastCount },
      tool: 'api/admin/backup.run',
    })
    const geloescht = await rotiereAlteBackups(settings.keepCopies)
    job.status = 'done'
    job.filename = filename
    log.info(
      { filename, bytes: result.bytes, dumpBytes: result.dumpBytes, geloescht },
      '[backup] run fertig (asynchron)',
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    job.status = 'failed'
    job.error = msg
    // Unvollstaendige ZIP loeschen — sie wuerde sonst in der Liste
    // erscheinen und bei der Rotation mitzaehlen.
    if (pfad !== null) {
      try {
        await fsUnlink(pfad)
      } catch {
        /* Datei schon weg — egal */
      }
    }
    log.error({ err: e, jobId }, '[backup] run fehlgeschlagen (asynchron)')
  }
}

const settingsSchema = z.object({
  schedule: z.string(),
  keepCopies: z.number().int().min(1).max(365),
})

const restoreQuerySchema = z.object({
  /** Name der Backup-Datei in BACKUP_DIR, OHNE Pfad. Pflicht. */
  name: z.string().min(1),
  confirm: z.literal('yes'),
})

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // ---------- Settings ----------

  app.get(
    '/api/admin/backup/settings',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const s = await leseBackupSettings()
      return reply.send(s)
    },
  )

  app.put(
    '/api/admin/backup/settings',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = settingsSchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      await schreibeBackupSettings(parsed.data)
      const s = await leseBackupSettings()
      return reply.send(s)
    },
  )

  // ---------- Liste + Loeschen ----------

  app.get(
    '/api/admin/backup/list',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      await ensureBackupDir()
      // inspect: true prueft jede ZIP auf einen nicht-leeren DB-Dump —
      // ein Backup mit leerem Dump ist unbrauchbar und soll im UI
      // sichtbar sein.
      const files = await listeBackups(config.BACKUP_DIR, { inspect: true })
      return reply.send({ files, dir: config.BACKUP_DIR })
    },
  )

  app.delete<{ Params: { name: string } }>(
    '/api/admin/backup/:name',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const name = req.params.name
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return reply.code(400).send({ code: 'INVALID_NAME' })
      }
      if (!name.startsWith('castel-backup-') || !name.endsWith('.zip')) {
        return reply.code(400).send({ code: 'INVALID_NAME' })
      }
      const pfad = backupDateiPfad(name)
      try {
        await fsUnlink(pfad)
      } catch (e) {
        return reply
          .code(404)
          .send({ code: 'NOT_FOUND', message: e instanceof Error ? e.message : String(e) })
      }
      return reply.code(204).send()
    },
  )

  // ---------- Run (asynchron, im Hintergrund) ----------

  app.post(
    '/api/admin/backup/run',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      await ensureBackupDir()
      const jobId = neuerJobId()
      backupJobs.set(jobId, {
        status: 'running',
        createdAt: new Date().toISOString(),
      })
      // Fire-and-forget: Antwort geht sofort raus, der Job laeuft
      // im Hintergrund. Fehler landen im Server-Log.
      void fuehreBackupDurch(jobId, app.log)
      return reply.send({ jobId, status: 'running' })
    },
  )

  // ---------- Job-Status ----------

  app.get<{ Params: { jobId: string } }>(
    '/api/admin/backup/status/:jobId',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const job = backupJobs.get(req.params.jobId)
      if (!job) {
        return reply.code(404).send({ code: 'JOB_NOT_FOUND' })
      }
      return reply.send({
        status: job.status,
        filename: job.filename ?? null,
        error: job.error ?? null,
      })
    },
  )

  // ---------- Restore ----------

  app.post<{ Body: { name: string; confirm: 'yes' } }>(
    '/api/admin/backup/restore',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = restoreQuerySchema.safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({ code: 'VALIDATION', issues: parsed.error.issues })
      }
      const { name } = parsed.data
      if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        return reply.code(400).send({ code: 'INVALID_NAME' })
      }
      if (!name.startsWith('castel-backup-') || !name.endsWith('.zip')) {
        return reply.code(400).send({ code: 'INVALID_NAME' })
      }
      const pfad = backupDateiPfad(name)
      try {
        const result = await restoreAusZip(pfad, config.DATABASE_URL)
        app.log.info({ name, ...result }, '[backup] restore fertig')
        return reply.send({ ok: true, name, ...result })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        app.log.error({ name, err: message }, '[backup] restore fehlgeschlagen')
        return reply.code(500).send({ code: 'RESTORE_FAILED', message })
      }
    },
  )

  // ---------- Download einer existierenden Backup-Datei ----------

  app.get<{ Params: { name: string } }>(
    '/api/admin/backup/file/:name',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const name = req.params.name
      if (
        name.includes('/') ||
        name.includes('\\') ||
        name.includes('..') ||
        !name.startsWith('castel-backup-') ||
        !name.endsWith('.zip')
      ) {
        return reply.code(400).send({ code: 'INVALID_NAME' })
      }
      let size: number
      try {
        size = backupDateiGroesse(name)
      } catch {
        return reply.code(404).send({ code: 'NOT_FOUND' })
      }
      reply.header('Content-Type', 'application/zip')
      reply.header('Content-Disposition', `attachment; filename="${name}"`)
      reply.header('Content-Length', String(size))
      return reply.send(backupDateiStream(name))
    },
  )
}
