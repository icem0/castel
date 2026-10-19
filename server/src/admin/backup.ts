// Backup-Service: baut, restored und rotiert Server-Backups.
//
// Strategie (siehe AGENTS.md 'Backup & Restore'):
//   1) Sync-Impuls an alle PWA-Worker (sync.forceAt-Marker).
//   2) Polling auf /api/sync/status bis der buchungen-Count
//      BACKUP_SYNC_QUIET_MS lang stabil ist (max BACKUP_SYNC_TIMEOUT_MS).
//   3) pg_dump -Fc -> dump.pgdump (Custom-Format, komprimiert).
//   4) FOTOS_DIR -> fotos/ (rekursiv).
//   5) manifest.json + ZIP.
//
// Zwei Verbraucher:
//   * Admin-Download: ZIP wird on-the-fly als Response gestreamt.
//   * Cron-Backup:    ZIP wird in BACKUP_DIR geschrieben + alte Kopien rotiert.

import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import archiver from 'archiver'
import { and, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { buchungen, einstellungen } from '../db/schema.js'
import { config } from '../config/config.js'

const FORCE_SYNC_KEY = 'sync.forceAt'

// ---------- Settings (Schedule + Keep-Copies) ----------

const SCHEDULE_KEY = 'backup.schedule'
const KEEP_COPIES_KEY = 'backup.keepCopies'

export interface BackupSettings {
  /** "HH:MM" in der lokalen Server-Zeit, oder '' fuer 'aus'. */
  schedule: string
  /** Wie viele alte Backups aufgehoben werden, bevor das aelteste geloescht wird. */
  keepCopies: number
}

const SCHEDULE_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const KEEP_RE = /^\d+$/

export function validiereSchedule(s: string): string | null {
  if (s === '') return null
  return SCHEDULE_RE.test(s) ? null : 'Format muss HH:MM sein (z. B. 02:00) oder leer fuer aus.'
}

export function validiereKeepCopies(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 365) return 'Anzahl Kopien muss zwischen 1 und 365 liegen.'
  return null
}

export async function leseBackupSettings(): Promise<BackupSettings> {
  const db = getDb()
  const rows = await db
    .select({ key: einstellungen.key, value: einstellungen.value })
    .from(einstellungen)
    .where(
      and(
        sql`${einstellungen.key} IN (${SCHEDULE_KEY}, ${KEEP_COPIES_KEY})`,
        isNull(einstellungen.userId),
      ),
    )
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const scheduleRaw = m.get(SCHEDULE_KEY) ?? ''
  const keepRaw = m.get(KEEP_COPIES_KEY) ?? '7'
  return {
    schedule: SCHEDULE_RE.test(scheduleRaw) ? scheduleRaw : '',
    keepCopies: KEEP_RE.test(keepRaw) ? Math.max(1, Math.min(365, Number.parseInt(keepRaw, 10))) : 7,
  }
}

async function schreibeEinstellung(key: string, value: string): Promise<void> {
  const db = getDb()
  await db.execute(sql`
    INSERT INTO einstellungen (key, user_id, value, geaendert_am)
    VALUES (${key}, NULL, ${value}, NOW())
    ON CONFLICT (key, user_id) DO UPDATE
      SET value = EXCLUDED.value,
          geaendert_am = EXCLUDED.geaendert_am
  `)
}

export async function schreibeBackupSettings(s: BackupSettings): Promise<void> {
  const scheduleFehler = validiereSchedule(s.schedule)
  if (scheduleFehler) throw new Error(scheduleFehler)
  const keepFehler = validiereKeepCopies(s.keepCopies)
  if (keepFehler) throw new Error(keepFehler)
  await schreibeEinstellung(SCHEDULE_KEY, s.schedule)
  await schreibeEinstellung(KEEP_COPIES_KEY, String(s.keepCopies))
}

// ---------- Sync-Trigger + Idle-Wait ----------

export async function triggerSyncForce(): Promise<string> {
  const db = getDb()
  const now = new Date().toISOString()
  await db.execute(sql`
    INSERT INTO einstellungen (key, user_id, value, geaendert_am)
    VALUES (${FORCE_SYNC_KEY}, NULL, ${now}, NOW())
    ON CONFLICT (key, user_id) DO UPDATE
      SET value = EXCLUDED.value,
          geaendert_am = EXCLUDED.geaendert_am
  `)
  return now
}

export async function leseBuchungenCount(): Promise<number> {
  const db = getDb()
  const rows = await db.select({ c: sql<number>`count(*)::int` }).from(buchungen)
  return rows[0]?.c ?? 0
}

export interface SyncWaitResult {
  lastCount: number
  waitedMs: number
  idle: boolean
}

export async function warteAufSyncIdle(
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
): Promise<SyncWaitResult> {
  const start = Date.now()
  const quietMs = config.BACKUP_SYNC_QUIET_MS
  const timeoutMs = config.BACKUP_SYNC_TIMEOUT_MS
  let last = await leseBuchungenCount()
  let lastChange = Date.now()
  log.info({ buchungen: last }, '[backup] warte auf sync idle …')
  while (Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, Math.min(quietMs / 4, 3000)))
    const c = await leseBuchungenCount()
    if (c !== last) {
      last = c
      lastChange = Date.now()
      log.info({ buchungen: c }, '[backup] buchungen-count geaendert')
      continue
    }
    if (Date.now() - lastChange >= quietMs) {
      const waited = Date.now() - start
      log.info({ buchungen: last, waitedMs: waited }, '[backup] sync idle')
      return { lastCount: last, waitedMs: waited, idle: true }
    }
  }
  const waited = Date.now() - start
  log.warn({ buchungen: last, waitedMs: waited }, '[backup] sync-timeout, fahre fort')
  return { lastCount: last, waitedMs: waited, idle: false }
}

// ---------- pg_dump als Stream ----------

/**
 * Startet `pg_dump -Fc` und liefert den Custom-Format-Output als Node-
 * Readable. Wir nutzen spawn (nicht exec), damit der pg_dump-Output
 * gestreamt werden kann — bei grossen Datenbanken waere der
 * Memory-Buffer von exec der falsche Weg.
 */
export function pgDumpStream(databaseUrl: string): Readable {
  const args = ['-Fc', '--no-owner', '--no-acl', databaseUrl]
  const child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  // stderr vom pg_dump in unseren Logger pipen — sonst sehen wir
  // Connection-Errors nicht.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[pg_dump] ${chunk}`)
  })
  // Wir geben stdout zurueck. Wenn der Prozess vor stream-end stirbt,
  // wird der Stream automatisch mit einem Error beendet (Node-Default).
  return child.stdout
}

// ---------- ZIP-Bau ----------

/**
 * Baut ein Backup-ZIP in den beschreibbaren Writable-Stream `out`.
 * `pgDumpReadable` wird als dump.pgdump eingebaut, FOTOS_DIR wird
 * (falls vorhanden) als fotos/ eingebettet, plus manifest.json.
 *
 * Rueckgabe: Wird aufgelöst, sobald das ZIP fertig geschrieben ist.
 *   rejected, wenn pg_dump mit Fehler beendet oder der Archiv-Vorgang
 *   scheitert.
 */
export interface BackupResult {
  manifest: BackupManifest
  bytes: number
}

export interface BackupManifest {
  schema: 'castel-backup-1'
  createdAt: string
  forceAt: string
  serverTime: string
  dbCounts: { buchungen: number }
  fotoCount: number
  tool: string
}

export async function baueBackupZip(opts: {
  out: Writable
  pgDumpReadable: Readable
  forceAt: string
  dbCounts: { buchungen: number }
  tool: string
}): Promise<BackupResult> {
  const { out, pgDumpReadable, forceAt, dbCounts, tool } = opts
  const archive = archiver('zip', { zlib: { level: 6 } })
  let bytes = 0
  out.on('data', (chunk: Buffer) => {
    bytes += chunk.length
  })
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve())
    out.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', (err: NodeJS.ErrnoException) => {
      // ENOENT auf einzelnen Dateien ist OK (race: User loescht waehrend
      // wir lesen). Andere Warnings promoten wir zu Errors.
      if (err.code === 'ENOENT') return
      reject(err)
    })
  })
  archive.pipe(out)

  // pg_dump
  archive.append(pgDumpReadable, { name: 'dump.pgdump' })

  // Fotos: nur hinzufuegen, wenn FOTOS_DIR existiert; sonst leerer Ordner.
  // fotoCount = Anzahl der Artikel-Unterordner (= IDs).
  let fotoCount = 0
  try {
    const fotosStat = statSync(config.FOTOS_DIR)
    if (fotosStat.isDirectory()) {
      const entries = await readdir(config.FOTOS_DIR, { withFileTypes: true })
      fotoCount = entries.filter((e) => e.isDirectory()).length
      archive.directory(config.FOTOS_DIR, 'fotos')
    } else {
      archive.append('', { name: 'fotos/.keep' })
    }
  } catch {
    archive.append('', { name: 'fotos/.keep' })
  }

  // manifest.json
  const manifest: BackupManifest = {
    schema: 'castel-backup-1',
    createdAt: new Date().toISOString(),
    forceAt,
    serverTime: new Date().toISOString(),
    dbCounts,
    fotoCount,
    tool,
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })

  await archive.finalize()
  await finished
  return { manifest, bytes }
}

// ---------- Restore aus ZIP-File ----------

/**
 * Spielt ein Backup-ZIP ein: entpackt in tmpdir, ruft pg_restore,
 * kopiert Fotos nach FOTOS_DIR.
 * Wirft, wenn das ZIP kein 'castel-backup-1'-Manifest hat oder die
 * `pg_restore`-Pipe fehlschlaegt.
 *
 * Vorbedingung: API-Server muss gestoppt sein (Admin-Disziplin). Wir
 * pruefen das hier nicht, weil die Bedingung von aussen gilt; ein
 * Stop-Hook waere der falsche Ort.
 */
export async function restoreAusZip(zipPath: string, databaseUrl: string): Promise<void> {
  const { tmpdir } = await import('node:os')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const tmp = await mkdtemp(join(tmpdir(), 'castel-restore-'))

  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', tmp], {
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exit ${code}`))))
  })

  let manifestRaw: string
  try {
    manifestRaw = await readFile(join(tmp, 'manifest.json'), 'utf8')
  } catch {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new Error('manifest.json fehlt im Backup')
  }
  const manifest = JSON.parse(manifestRaw) as BackupManifest
  if (manifest.schema !== 'castel-backup-1') {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw new Error(`Unbekanntes Backup-Schema '${manifest.schema}' — erwartet 'castel-backup-1'`)
  }

  const dumpPath = join(tmp, 'dump.pgdump')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'pg_restore',
      [
        '-d',
        databaseUrl,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        dumpPath,
      ],
      { stdio: 'inherit' },
    )
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve()
      else reject(new Error(`pg_restore exit ${code}`))
    })
  })

  await mkdir(config.FOTOS_DIR, { recursive: true })
  const fotosDir = join(tmp, 'fotos')
  try {
    const s = statSync(fotosDir)
    if (s.isDirectory()) {
      const cp = spawn('cp', ['-r', `${fotosDir}/.`, `${config.FOTOS_DIR}/`], { stdio: 'inherit' })
      await new Promise<void>((resolve, reject) => {
        cp.on('error', reject)
        cp.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`cp exit ${code}`))))
      })
    }
  } catch {
    // kein fotos/-Verzeichnis im Backup, ueberspringen
  }

  await rm(tmp, { recursive: true, force: true }).catch(() => {})
}

// ---------- Backup-Liste + Rotation ----------

export interface BackupDateiInfo {
  name: string
  size: number
  createdAt: string
}

export async function listeBackups(dir: string = config.BACKUP_DIR): Promise<BackupDateiInfo[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files = entries.filter(
    (e) => e.isFile() && e.name.startsWith('castel-backup-') && e.name.endsWith('.zip'),
  )
  const out: BackupDateiInfo[] = []
  for (const f of files) {
    const full = join(dir, f.name)
    const s = statSync(full)
    const m = f.name.match(/castel-backup-(.+)\.zip$/)
    let createdAt = s.mtime.toISOString()
    if (m && m[1]) {
      const stamp = m[1]
      // Format: 2026-10-19T11-25-13-123Z → 2026-10-19T11:25:13.123Z
      const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
      const parsed = new Date(iso)
      if (!Number.isNaN(parsed.getTime())) createdAt = parsed.toISOString()
    }
    out.push({ name: f.name, size: s.size, createdAt })
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

export async function rotiereAlteBackups(
  keep: number,
  dir: string = config.BACKUP_DIR,
): Promise<number> {
  if (keep < 1) return 0
  const files = await listeBackups(dir)
  if (files.length <= keep) return 0
  const zuLoeschen = files.slice(keep)
  let geloescht = 0
  for (const f of zuLoeschen) {
    await rm(join(dir, f.name), { force: true })
    geloescht++
  }
  return geloescht
}

// ---------- Hilfsfunktionen ----------

export function backupDateiStream(name: string, dir: string = config.BACKUP_DIR): Readable {
  return createReadStream(join(dir, name))
}

export function backupDateiGroesse(name: string, dir: string = config.BACKUP_DIR): number {
  return statSync(join(dir, name)).size
}

export async function ensureBackupDir(): Promise<void> {
  await mkdir(config.BACKUP_DIR, { recursive: true })
}

export function backupDateiPfad(name: string, dir: string = config.BACKUP_DIR): string {
  return join(dir, name)
}

export function neuerWriteStream(pfad: string): Writable {
  return createWriteStream(pfad)
}
