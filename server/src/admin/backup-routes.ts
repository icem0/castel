// Admin-Routes: Backup & Restore + Settings.
//
//   GET  /api/admin/backup/settings   -> { schedule, keepCopies }
//   PUT  /api/admin/backup/settings   -> setzt { schedule, keepCopies }
//   GET  /api/admin/backup/list       -> Liste der vorhandenen ZIPs
//   DELETE /api/admin/backup/:name    -> loescht ein einzelnes ZIP
//   POST /api/admin/backup/run        -> fuehrt ein Backup im Hintergrund aus,
//                                        antwortet sofort mit Job-ID
//   GET  /api/admin/backup/status/:jobId -> { status, kind?, filename?, error?, result? }
//   POST /api/admin/backup/restore    -> spielt ein ZIP aus BACKUP_DIR ein
//   POST /api/admin/backup/restore/upload -> spielt ein hochgeladenes ZIP ein
//   GET  /api/admin/backup/file/:name -> Stream einer existierenden Datei
//
// Alle Endpoints sind admin-only (requireAdmin).
//
// BEIDE Restore-Wege sind asynchron: der Restore dauert Minuten (pg_restore
// + Foto-/DATANORM-Kopieren). Ein offener HTTP-Request wuerde im
// PWA-nginx nach 60 s gekillt, waehrend der Server weiter restored — der
// Admin saehe einen Timeout und wuesste nicht, was passiert. Deshalb
// antworten die Restore-Endpoints sofort mit einer Job-ID; der Status
// laeuft ueber GET /api/admin/backup/status/:jobId.

import type { FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import { unlink as fsUnlink } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import {
  baueBackupZip,
  backupDateiGroesse,
  backupDateiPfad,
  backupDateiStream,
  backupStamp,
  ensureBackupDir,
  leseBackupSettings,
  leseManifestAusZip,
  leseUserZeile,
  listeBackups,
  pgDumpStream,
  pruefeZipSignatur,
  rotiereAlteBackups,
  restoreAusZip,
  schreibeBackupSettings,
  schreibeRestoreEpoch,
  serverVersionMajor,
  triggerSyncForce,
  warteAufSyncIdle,
  type RestoreErgebnis,
  type SyncWaitOpts,
} from './backup.js'
import { mitRestoreSperre } from './restore-lock.js'
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
  /** 'backup' = ZIP wird erzeugt, 'restore' = ZIP wird eingespielt. */
  kind: 'backup' | 'restore'
  filename?: string
  error?: string
  createdAt: string
  /** Ergebnis eines abgeschlossenen Restores. */
  result?: RestoreErgebnis & { restoreEpoch: string | null }
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

/**
 * Spielt ein Backup-ZIP im Hintergrund ein.
 *
 * Waehrend des Restores sind die Sync-Endpunkte gesperrt (restore-lock.ts):
 * die DB wird unter laufender API ersetzt, ein gleichzeitiger Push wuerde
 * den Vor-Restore-Stand in die frischen Tabellen zurueckschreiben.
 *
 * Die Restore-Epoche wird ueber `onDumpEingespielt` geschrieben — also
 * genau dann, wenn pg_restore erfolgreich war. Bricht danach der
 * Dateikopier-Schritt fehl, ist die DB trotzdem ersetzt, und die Clients
 * MUESSEN die Ersetzung bemerken (sonst dauerhafte Divergenz).
 *
 * Das User-Konto des handelnden Admins wird gesichert und nach dem Restore
 * wiederhergestellt, falls es im Backup fehlt — sonst waere er sofort
 * ausgesperrt (die users-Tabelle liegt im Dump).
 */
async function fuehreRestoreDurch(
  jobId: string,
  zipPfad: string,
  userId: string,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): Promise<void> {
  const job = backupJobs.get(jobId)
  if (!job) return
  try {
    const bewahrterUser = await leseUserZeile(userId)
    const serverMajor = await serverVersionMajor()
    let restoreEpoch: string | null = null
    const result = await mitRestoreSperre('backup-restore', async () =>
      await restoreAusZip(zipPfad, config.DATABASE_URL, {
        serverMajor,
        bewahrterUser,
        onDumpEingespielt: async () => {
          restoreEpoch = await schreibeRestoreEpoch()
        },
      }),
    )
    job.status = 'done'
    job.result = { ...result, restoreEpoch }
    log.info({ jobId, restoreEpoch, ...result }, '[backup] restore fertig')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    job.status = 'failed'
    job.error = msg
    log.error({ err: e, jobId }, '[backup] restore fehlgeschlagen (asynchron)')
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

/** Existiert die Backup-Datei im Backup-Ordner? */
function backupDateiExistiert(pfad: string): boolean {
  return existsSync(pfad)
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  // Multipart nur fuer den Upload-Restore. Das Limit ist bewusst deutlich
  // groesser als der globale bodyLimit (4 MB fuer Push-Payloads) — ein
  // Backup-ZIP enthaelt DB-Dump, Fotos und DATANORM-Kataloge und ist
  // entsprechend gross. Der nginx im PWA-Container begrenzt auf 512m.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.BACKUP_MAX_FILE_BYTES,
      files: 1,
      fields: 5,
    },
  })

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
        kind: 'backup',
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
        kind: job.kind,
        filename: job.filename ?? null,
        error: job.error ?? null,
        result: job.result ?? null,
      })
    },
  )

  // ---------- Restore (aus dem Backup-Ordner) ----------

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
      if (!backupDateiExistiert(pfad)) {
        return reply.code(404).send({ code: 'NOT_FOUND', message: `Backup ${name} nicht gefunden` })
      }
      const jobId = neuerJobId()
      backupJobs.set(jobId, {
        status: 'running',
        kind: 'restore',
        filename: name,
        createdAt: new Date().toISOString(),
      })
      // Fire-and-forget: der Restore dauert Minuten. Ein offener Request
      // wuerde im nginx nach 60 s gekillt, waehrend der Server weiter
      // restauriert — der Admin wuesste nicht, was passiert.
      void fuehreRestoreDurch(jobId, pfad, req.authUser?.sub ?? '', app.log)
      return reply.send({ jobId, status: 'running', name })
    },
  )

  // ---------- Restore aus einem hochgeladenen ZIP ----------

  app.post<{ Querystring: { confirm?: string } }>(
    '/api/admin/backup/restore/upload',
    {
      preHandler: app.requireAdmin,
      // Das multipart-Limit (limits.fileSize) greift fuer die Datei; das
      // bodyLimit des Routen-Objekts deckt den Rest des Requests ab.
      bodyLimit: config.BACKUP_MAX_FILE_BYTES,
    },
    async (req, reply) => {
      // Die Bestaetigung laeuft als Query-Parameter, nicht als
      // multipart-Feld: die Reihenfolge von Feldern und Datei im
      // multipart-Body ist nicht garantiert — ein Feld NACH der Datei
      // waere beim Parsen noch nicht gelesen.
      if (req.query.confirm !== 'yes') {
        return reply.code(400).send({
          code: 'VALIDATION',
          message: 'Bestaetigung fehlt (confirm=yes als Query-Parameter)',
        })
      }

      let file: Awaited<ReturnType<typeof req.file>>
      try {
        file = await req.file()
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (message.includes('too large') || message.includes('limit')) {
          return reply.code(413).send({
            code: 'PAYLOAD_TOO_LARGE',
            message: `Backup zu gross (maximal ${config.BACKUP_MAX_FILE_BYTES} Bytes)`,
          })
        }
        return reply.code(400).send({ code: 'NO_FILE', message })
      }
      if (!file) {
        return reply.code(400).send({ code: 'NO_FILE', message: 'kein Backup-ZIP hochgeladen' })
      }

      const tmpDir = await mkdtemp(join(tmpdir(), 'castel-upload-'))
      const tmpPfad = join(tmpDir, 'upload.zip')
      try {
        // Gestreamt auf die Platte — ein Backup kann Hunderte MB gross
        // sein und darf nicht komplett im RAM gepuffert werden.
        await pipeline(file.file, createWriteStream(tmpPfad))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        if (message.includes('too large') || message.includes('limit')) {
          return reply.code(413).send({
            code: 'PAYLOAD_TOO_LARGE',
            message: `Backup zu gross (maximal ${config.BACKUP_MAX_FILE_BYTES} Bytes)`,
          })
        }
        app.log.error({ err: e }, '[backup] upload fehlgeschlagen')
        return reply.code(500).send({ code: 'UPLOAD_FAILED', message })
      }
      try {
        // Bei Ueberschreitung des Limits kappt der multipart-Stream die
        // Datei — ein still abgeschnittenes Backup waere unbrauchbar.
        if (file.file.truncated) {
          return reply.code(413).send({
            code: 'PAYLOAD_TOO_LARGE',
            message: `Backup zu gross (maximal ${config.BACKUP_MAX_FILE_BYTES} Bytes)`,
          })
        }
        try {
          await pruefeZipSignatur(tmpPfad)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          return reply.code(400).send({ code: 'INVALID_BACKUP', message })
        }

        // Das hochgeladene ZIP bleibt im Backup-Ordner erhalten: es steht
        // dann in der Liste, kann erneut eingespielt oder heruntergeladen
        // werden. Der Dateiname traegt den Zeitstempel aus dem Manifest —
        // ein altes Backup soll in der Liste auch als alt erscheinen.
        await ensureBackupDir()
        const manifest = await leseManifestAusZip(tmpPfad)
        const stamp = backupStamp(manifest?.createdAt ?? null)
        const filename = `castel-backup-${stamp}.zip`
        const ziel = backupDateiPfad(filename)
        await rename(tmpPfad, ziel)

        const jobId = neuerJobId()
        backupJobs.set(jobId, {
          status: 'running',
          kind: 'restore',
          filename,
          createdAt: new Date().toISOString(),
        })
        void fuehreRestoreDurch(jobId, ziel, req.authUser?.sub ?? '', app.log)
        return reply.send({ jobId, status: 'running', name: filename })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        app.log.error({ err: e }, '[backup] upload-Ablage fehlgeschlagen')
        return reply.code(500).send({ code: 'UPLOAD_FAILED', message })
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
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
