// Admin-Routes: Backup & Restore + Settings.
//
//   POST /api/admin/backup/download   -> Stream eines Backup-ZIPs als Response
//   GET  /api/admin/backup/list       -> Liste der vorhandenen ZIPs
//   DELETE /api/admin/backup/:name    -> loescht ein einzelnes ZIP
//   GET  /api/admin/backup/settings   -> { schedule, keepCopies }
//   PUT  /api/admin/backup/settings   -> setzt { schedule, keepCopies }
//   POST /api/admin/backup/run        -> fuehrt ein Backup in BACKUP_DIR aus
//   POST /api/admin/backup/restore    -> laedt ein ZIP hoch, ruft pg_restore
//   GET  /api/admin/backup/file/:name -> Stream einer existierenden Datei
//
// Alle Endpoints sind admin-only (requireAdmin).

import type { FastifyInstance } from 'fastify'
import { unlink as fsUnlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { z } from 'zod'
import { PassThrough } from 'node:stream'
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
      const files = await listeBackups()
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

  // ---------- Download (on-the-fly ZIP) ----------

  app.post(
    '/api/admin/backup/download',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      const forceAt = await triggerSyncForce()
      const wait = await warteAufSyncIdle(app.log, SYNC_WAIT_HTTP)
      const pgDump = pgDumpStream(config.DATABASE_URL)
      const zip = new PassThrough()
      const filename = `castel-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
      reply.header('Content-Type', 'application/zip')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      reply.header('Cache-Control', 'no-store')
      reply.send(zip)
      try {
        const { manifest } = await baueBackupZip({
          out: zip,
          pgDumpReadable: pgDump,
          forceAt,
          dbCounts: { buchungen: wait.lastCount },
          tool: 'api/admin/backup.download',
        })
        app.log.info({ manifest }, '[backup] download fertig')
      } catch (e) {
        app.log.error({ err: e }, '[backup] download fehlgeschlagen')
        zip.destroy(e instanceof Error ? e : new Error(String(e)))
      }
    },
  )

  // ---------- Run (in BACKUP_DIR schreiben, alte rotieren) ----------

  app.post(
    '/api/admin/backup/run',
    { preHandler: app.requireAdmin },
    async (_req, reply) => {
      await ensureBackupDir()
      const forceAt = await triggerSyncForce()
      const wait = await warteAufSyncIdle(app.log, SYNC_WAIT_HTTP)
      const pgDump = pgDumpStream(config.DATABASE_URL)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `castel-backup-${stamp}.zip`
      const pfad = backupDateiPfad(filename)
      const fileStream = createWriteStream(pfad)
      const settings = await leseBackupSettings()
      let result
      try {
        result = await baueBackupZip({
          out: fileStream,
          pgDumpReadable: pgDump,
          forceAt,
          dbCounts: { buchungen: wait.lastCount },
          tool: 'api/admin/backup.run',
        })
      } catch (e) {
        try {
          await fsUnlink(pfad)
        } catch {
          /* ignore */
        }
        return reply
          .code(500)
          .send({ code: 'BACKUP_FAILED', message: e instanceof Error ? e.message : String(e) })
      }
      const geloescht = await rotiereAlteBackups(settings.keepCopies)
      const files = await listeBackups()
      app.log.info(
        { filename, bytes: result.bytes, geloescht },
        '[backup] run fertig, rotation durchgefuehrt',
      )
      return reply.send({
        filename,
        bytes: result.bytes,
        size: backupDateiGroesse(filename),
        geloescht,
        total: files.length,
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
        await restoreAusZip(pfad, config.DATABASE_URL)
      } catch (e) {
        return reply
          .code(500)
          .send({ code: 'RESTORE_FAILED', message: e instanceof Error ? e.message : String(e) })
      }
      app.log.info({ name }, '[backup] restore fertig')
      return reply.send({ ok: true, name })
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
