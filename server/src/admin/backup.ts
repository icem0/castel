// Backup-Service: baut, restored und rotiert Server-Backups.
//
// Strategie (siehe AGENTS.md 'Backup & Restore'):
//   1) Sync-Impuls an alle PWA-Worker (sync.forceAt-Marker).
//   2) Polling auf /api/sync/status bis der buchungen-Count
//      BACKUP_SYNC_QUIET_MS lang stabil ist (max BACKUP_SYNC_TIMEOUT_MS).
//   3) pg_dump -Fc -> dump.pgdump (Custom-Format, komprimiert).
//   4) FOTOS_DIR -> fotos/ und DATANORM_DIR -> datanorm/ (rekursiv).
//      Beides liegt ausserhalb von Postgres — ohne datanorm/ wuerden die
//      restaurierten `datanorm_dateien`-Zeilen ins Leere zeigen (kein
//      Re-Import, kein Original-Download).
//   5) manifest.json + ZIP.
//
// Zwei Verbraucher:
//   * Admin-Download: ZIP wird on-the-fly als Response gestreamt.
//   * Cron-Backup:    ZIP wird in BACKUP_DIR geschrieben + alte Kopien rotiert.

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, statSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import archiver from 'archiver'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getClient, getDb } from '../db/client.js'
import { buchungen, einstellungen } from '../db/schema.js'
import { config } from '../config/config.js'

const FORCE_SYNC_KEY = 'sync.forceAt'

// ---------- Settings (Schedule + Keep-Copies) ----------

const SCHEDULE_KEY = 'backup.schedule'
const KEEP_COPIES_KEY = 'backup.keepCopies'

/**
 * Globaler Marker: der zuletzt beanspruchte Tages-Slot des Cron
 * (`YYYY-MM-DD`). Der Claim ueberlebt API-Neustarts — der In-Memory-Marker
 * des Cron allein verliert seinen Schutz bei jedem Boot und der Cron wuerde
 * im Crash-Loop bei jedem Start ein neues Backup anstossen.
 */
const LAST_SLOT_KEY = 'backup.lastSlot'

/**
 * Globaler Marker: die Epoche des letzten Restaurierens (ISO-Zeit). Der
 * PWA-Sync-Worker vergleicht sie mit seinem lokalen Marker und baut bei
 * Abweichung seine IndexedDB komplett neu auf — pg_restore zieht alte
 * `geaendert_am`-Stempel ein, die der inkrementelle Sync nie wieder aus-
 * liefert; Geisterzeilen und Outbox-Eintraege der Vor-Restore-Welt wuerden
 * sonst in die restaurierte DB zurueckwandern.
 */
const RESTORE_EPOCH_KEY = 'server.restoreEpoch'

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
    ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE
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

/**
 * Beansprucht den Tages-Slot des Backup-Crons atomar in der Datenbank.
 * Nur der Aufrufer, der den Marker von einem anderen Wert auf `slot` dreht,
 * bekommt true — jeder andere Prozess, jedes Multi-Instanz-Double und jeder
 * Neustart am selben Tag bekommt false.
 *
 * Der bedingte UPDATE ... RETURNING sperrt die Zeile; zusammen mit dem
 * vorangehenden INSERT ... DO NOTHING ist der Claim auch gegen parallele
 * Prozesse konkurrenzfrei. Ohne diesen DB-Claim war der "heute schon
 * gefeuert?"-Schutz rein prozesslokal (`_letzterLauf`) und fiel bei jedem
 * API-Neustart aus — ein crashender Backup-Lauf (z. B. pg_dump-OOM) liess
 * den Container neu starten, der Cron feuerte sofort wieder und erzeugte
 * Backups im Minuten-Takt.
 *
 * Auf Fehler wird NICHT zurueckgerollt: ein fehlgeschlagener Backup-Lauf
 * verbraucht den Slot weiterhin (wie bisher — kein Retry am selben Tag).
 */
export async function beansprucheTagesSlot(slot: string): Promise<boolean> {
  const db = getDb()
  await db.execute(sql`
    INSERT INTO einstellungen (key, user_id, value, geaendert_am)
    VALUES (${LAST_SLOT_KEY}, NULL, '', NOW())
    ON CONFLICT (key) WHERE (user_id IS NULL) DO NOTHING
  `)
  const rows = await db
    .update(einstellungen)
    .set({ value: slot, geaendertAm: new Date() })
    .where(
      and(
        eq(einstellungen.key, LAST_SLOT_KEY),
        isNull(einstellungen.userId),
        sql`${einstellungen.value} <> ${slot}`,
      ),
    )
    .returning({ key: einstellungen.key })
  return rows.length > 0
}

/**
 * Setzt die Restore-Epoche auf die aktuelle Server-Zeit und liefert sie.
 * MUSS nach `pg_restore` aufgerufen werden: der Marker liegt selbst in der
 * Datenbank und wuerde vom Restore sonst auf den Wert des Backups zurueck-
 * gesetzt. Der Wert ist nur dann nuetzlich, wenn er nach dem Einspielen
 * neu erzeugt wird.
 */
export async function schreibeRestoreEpoch(): Promise<string> {
  const epoch = new Date().toISOString()
  await schreibeEinstellung(RESTORE_EPOCH_KEY, epoch)
  return epoch
}

/** Liest die aktuelle Restore-Epoche (null, wenn nie restauriert wurde). */
export async function leseRestoreEpoch(): Promise<string | null> {
  const db = getDb()
  const rows = await db
    .select({ value: einstellungen.value })
    .from(einstellungen)
    .where(and(eq(einstellungen.key, RESTORE_EPOCH_KEY), isNull(einstellungen.userId)))
    .limit(1)
  return rows[0]?.value ?? null
}

// ---------- Sync-Trigger + Idle-Wait ----------

export async function triggerSyncForce(): Promise<string> {
  const db = getDb()
  const now = new Date().toISOString()
  await db.execute(sql`
    INSERT INTO einstellungen (key, user_id, value, geaendert_am)
    VALUES (${FORCE_SYNC_KEY}, NULL, ${now}, NOW())
    ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE
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

export interface SyncWaitOpts {
  /** Ruhe-Fenster ohne neue Buchungen, das als "idle" gilt. */
  quietMs?: number
  /** Hartes Zeitlimit fuer die Wartezeit. */
  timeoutMs?: number
}

/**
 * Wartet, bis der buchungen-Count `quietMs` lang stabil bleibt (max.
 * `timeoutMs`). Default sind die Config-Werte BACKUP_SYNC_QUIET_MS /
 * BACKUP_SYNC_TIMEOUT_MS (8 s / 120 s) — passend fuer den Cron, der
 * Zeit hat.
 *
 * Die HTTP-Endpunkte (download/run) rufen diese Funktion mit kurzen
 * Werten auf ({ quietMs: 2000, timeoutMs: 15000 }): Der manuelle Klick
 * darf den Request nicht minutenlang offen halten — nginx im
 * PWA-Container killt Proxy-Requests nach 60 s, und der Sync-Worker
 * der PWA pusht ohnehin alle 30 s von selbst.
 */
export async function warteAufSyncIdle(
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
  opts?: SyncWaitOpts,
): Promise<SyncWaitResult> {
  const start = Date.now()
  const quietMs = opts?.quietMs ?? config.BACKUP_SYNC_QUIET_MS
  const timeoutMs = opts?.timeoutMs ?? config.BACKUP_SYNC_TIMEOUT_MS
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

/** Maximale Laenge des gepufferten pg_dump-stderr (fuer Fehlermeldungen). */
const STDERR_MAX_CHARS = 16_384

/** Maximale Laenge des gepufferten stdout (fuer `unzip -l`). */
const STDOUT_MAX_CHARS = 1_048_576

/** Header-Magic eines pg_dump-Custom-Format-Dumps. */
const PGDMP_MAGIC = 'PGDMP'

/** Zeitlimit, bis pg_dump nach dem Ende des Streams sauber beendet sein muss. */
const PG_DUMP_EXIT_TIMEOUT_MS = 15_000

/**
 * Vollstaendige Versionszeile von pg_dump, z. B. "pg_dump (PostgreSQL) 16.9".
 * null = pg_dump fehlt im PATH (kein 'postgresql-client' im Image).
 */
export function pgDumpVersion(): string | null {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' })
  if (r.status !== 0 || typeof r.stdout !== 'string') return null
  const zeile = r.stdout.trim()
  return zeile.length > 0 ? zeile : null
}

/**
 * Major-Version des installierten pg_dump, z. B. 16.
 * Relevant, weil ein aelterer Client einen neueren Server nicht
 * dumpen kann ("aborting because of server version mismatch") — der
 * Dump waere dann leer und das Backup wertlos.
 */
export function pgDumpMajor(): number | null {
  return majorAusVersion(pgDumpVersion())
}

/** Leitet die Major-Version aus einer Versionszeile ab ("... 16.9" -> 16). */
function majorAusVersion(version: string | null): number | null {
  if (!version) return null
  const m = version.match(/(\d+)\.\d+/)
  if (!m || m[1] === undefined) return null
  return Number.parseInt(m[1], 10)
}

/**
 * Major-Version des laufenden Postgres-Servers (z. B. 16).
 * Wird fuer den Kompatibilitaets-Check gegen pg_dump genutzt: ein
 * aelterer Client kann einen neueren Server nicht dumpen.
 */
export async function serverVersionMajor(): Promise<number | null> {
  try {
    const sqlc = getClient()
    const rows = await sqlc`SHOW server_version_num`
    const roh = rows[0]?.server_version_num
    const num = typeof roh === 'string' ? Number.parseInt(roh, 10) : Number(roh)
    if (!Number.isFinite(num)) return null
    return Math.floor(num / 10_000)
  } catch {
    return null
  }
}

export interface PgDumpResult {
  /** Exit-Code von pg_dump (null bei Signal/Startfehler). */
  code: number | null
  /** Signal, falls der Prozess so beendet wurde. */
  signal: NodeJS.Signals | null
  /** Gesammelte stderr-Ausgabe (gekuerzt). */
  stderr: string
}

export interface PgDumpHandle {
  /** stdout von pg_dump (Custom-Format-Stream) — an archiver weiterreichen. */
  stream: Readable
  /** Resolved, sobald pg_dump beendet ist (Exit-Code + stderr). */
  exit: Promise<PgDumpResult>
  /** Anzahl der gelieferten Dump-Bytes (stdout). */
  bytes(): number
}

/**
 * Startet `pg_dump -Fc` und liefert den Custom-Format-Output als Node-
 * Readable. Wir nutzen spawn (nicht exec), damit der pg_dump-Output
 * gestreamt werden kann — bei grossen Datenbanken waere der
 * Memory-Buffer von exec der falsche Weg.
 *
 * WICHTIG 1: Der 'error'-Event auf dem ChildProcess muss behandelt werden.
 * Ohne Handler stuerzt der komplette API-Prozess ab, wenn das Binary
 * fehlt (ENOENT) — der Event waere sonst "unhandled". Wir leiten den
 * Fehler stattdessen auf den Stream weiter, wo der Backup-Job ihn
 * auffaengt und als 'failed' markiert.
 *
 * WICHTIG 2: Wir liefern Exit-Code und Byte-Count mit zurueck. Ein
 * fehlgeschlagener pg_dump (z. B. Versionskonflikt Client/Server) beendet
 * stdout einfach sauber und leer — ohne diese Info wuerde daraus ein
 * ZIP mit 0-Byte-Dump, der beim Restore als "input file is too short"
 * abbricht.
 */
export function pgDumpStream(databaseUrl: string): PgDumpHandle {
  const args = ['-Fc', '--no-owner', '--no-acl', databaseUrl]
  const child = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  // stderr vom pg_dump in unseren Logger pipen — sonst sehen wir
  // Connection-Errors nicht.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_MAX_CHARS) stderr += chunk
    process.stderr.write(`[pg_dump] ${chunk}`)
  })

  // Zaehler-Transform: haelt den Backpressure der Pipe intakt (ein
  // eigener 'data'-Listener wuerde den Stream dauerhaft fliessen lassen
  // und den Memory-Verbrauch bei grossen Dumps sprengen).
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      cb(null, chunk)
    },
  })
  // No-op-Listener: verhindert, dass ein 'error' auf dem Stream ohne
  // zustaendigen Abnehmer den Prozess beendet.
  counter.on('error', () => {})

  const exit = new Promise<PgDumpResult>((resolve) => {
    let settled = false
    const done = (r: PgDumpResult) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    child.on('close', (code, signal) => done({ code, signal, stderr }))
    child.on('error', (err: NodeJS.ErrnoException) => {
      const meldung =
        err.code === 'ENOENT'
          ? `pg_dump nicht gefunden — ist 'postgresql-client' im Image? (${err.message})`
          : `pg_dump konnte nicht gestartet werden: ${err.message}`
      stderr = `${stderr}${stderr.length > 0 ? '\n' : ''}${meldung}`
      done({ code: null, signal: null, stderr })
    })
  })

  // Fehlerbehandlung: sonst "Unhandled 'error' event" -> Prozess-Crash.
  // Der Fehler geht auf den Stream, damit baueBackupZip ihn auffaengt.
  child.on('error', (err: NodeJS.ErrnoException) => {
    const meldung =
      err.code === 'ENOENT'
        ? `pg_dump nicht gefunden — ist 'postgresql-client' im Image? (${err.message})`
        : `pg_dump konnte nicht gestartet werden: ${err.message}`
    counter.destroy(new Error(meldung))
  })
  // Fehler auf stdout (z. B. EPIPE) an den Stream weiterreichen — pipe
  // allein propagiert Fehler nicht.
  child.stdout.on('error', (err: Error) => counter.destroy(new Error(`pg_dump: ${err.message}`)))
  child.stdout.pipe(counter)

  return { stream: counter, exit, bytes: () => bytes }
}

// ---------- ZIP-Bau ----------


/**
 * Baut ein Backup-ZIP in den beschreibbaren Writable-Stream `out`.
 * `pgDump.stream` wird als dump.pgdump eingebaut, FOTOS_DIR wird
 * (falls vorhanden) als fotos/ eingebettet, plus manifest.json.
 *
 * Rueckgabe: Wird aufgelöst, sobald das ZIP fertig geschrieben ist.
 *   rejected, wenn pg_dump mit Fehler beendet, wenn pg_dump KEINE Daten
 *   geliefert hat (0-Byte-Dump) oder der Archiv-Vorgang scheitert.
 */
export interface BackupResult {
  manifest: BackupManifest
  bytes: number
  /** Groesse des eingebetteten DB-Dumps in Bytes. */
  dumpBytes: number
}

export interface BackupManifest {
  schema: 'castel-backup-1'
  createdAt: string
  forceAt: string
  serverTime: string
  dbCounts: { buchungen: number }
  fotoCount: number
  /** Anzahl der datanorm/-Lieferanten-Unterordner; fehlt bei alten Backups. */
  datanormCount?: number
  tool: string
  /** Version des benutzten pg_dump (z. B. "pg_dump (PostgreSQL) 16.9"). */
  pgDumpVersion?: string | null
  /** Major-Version des benutzten pg_dump (z. B. 16). */
  pgDumpMajor?: number | null
}

export async function baueBackupZip(opts: {
  out: Writable
  pgDump: PgDumpHandle
  forceAt: string
  dbCounts: { buchungen: number }
  tool: string
}): Promise<BackupResult> {
  const { out, pgDump, forceAt, dbCounts, tool } = opts
  const archive = archiver('zip', { zlib: { level: 6 } })
  // Byte-Zaehler: ein Writable emittiert keine 'data'-Events, das
  // Zaehlen muss daher ueber einen Transform zwischen Archiv und
  // Ziel-Stream laufen.
  let bytes = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      cb(null, chunk)
    },
  })
  counter.on('error', () => {})
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve())
    out.on('error', reject)
    archive.on('error', reject)
    // Fehler aus dem pg_dump-Stream (z. B. Binary fehlt -> ENOENT)
    // muessen das Promise ablehnen — sonst entsteht ein stilles,
    // unbrauchbares ZIP ohne Dump.
    pgDump.stream.on('error', reject)
    archive.on('warning', (err: NodeJS.ErrnoException) => {
      // ENOENT auf einzelnen Dateien ist OK (race: User loescht waehrend
      // wir lesen). Andere Warnings promoten wir zu Errors.
      if (err.code === 'ENOENT') return
      reject(err)
    })
  })
  archive.pipe(counter)
  counter.pipe(out)

  // pg_dump
  archive.append(pgDump.stream, { name: 'dump.pgdump' })

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

  // DATANORM-Rohkataloge: liegen ausserhalb von Postgres. Ohne sie zeigen
  // die restaurierten `datanorm_dateien`-Zeilen nach dem Restore ins Leere —
  // weder Re-Import noch Original-Download waeren moeglich.
  // datanormCount = Anzahl der Datums-/Lieferanten-Unterordner.
  let datanormCount = 0
  try {
    const datanormStat = statSync(config.DATANORM_DIR)
    if (datanormStat.isDirectory()) {
      const entries = await readdir(config.DATANORM_DIR, { withFileTypes: true })
      datanormCount = entries.filter((e) => e.isDirectory()).length
      archive.directory(config.DATANORM_DIR, 'datanorm')
    } else {
      archive.append('', { name: 'datanorm/.keep' })
    }
  } catch {
    archive.append('', { name: 'datanorm/.keep' })
  }

  // manifest.json
  const dumpVersion = pgDumpVersion()
  const manifest: BackupManifest = {
    schema: 'castel-backup-1',
    createdAt: new Date().toISOString(),
    forceAt,
    serverTime: new Date().toISOString(),
    dbCounts,
    fotoCount,
    datanormCount,
    tool,
    pgDumpVersion: dumpVersion,
    pgDumpMajor: majorAusVersion(dumpVersion),
  }
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })

  try {
    await archive.finalize()
    await finished
  } catch (e) {
    // Archiv abbrechen und Ziel-Stream schliessen — sonst bleibt der
    // File-Handle offen und die ZIP-Datei liegt unvollstaendig im
    // Backup-Ordner (und wuerde bei der Rotation mitzaehlen).
    archive.abort()
    counter.destroy()
    out.destroy()
    throw e
  }

  // Der Exit-Code von pg_dump ist das entscheidende Signal: ein
  // fehlgeschlagener pg_dump (typisch: Client/Server-Versionskonflikt
  // "server version mismatch") liefert einen 0-Byte-Dump. Ohne diese
  // Pruefung wuerde das Backup als Erfolg gemeldet und erst beim
  // Restore mit "input file is too short" auffallen.
  const dumpResult = await warteAufPgDumpEnde(pgDump.exit)
  if (dumpResult.code !== 0) {
    const details = dumpResult.stderr.trim()
    throw new Error(
      `pg_dump fehlgeschlagen (exit ${dumpResult.code ?? 'null'})${
        details.length > 0 ? `: ${details}` : ''
      }`,
    )
  }
  const dumpBytes = pgDump.bytes()
  if (dumpBytes === 0) {
    throw new Error(
      'pg_dump hat keine Daten geliefert (0 Bytes) — das Backup waere unbrauchbar. ' +
        'Typische Ursache: pg_dump-Version passt nicht zur Postgres-Server-Version.',
    )
  }
  return { manifest, bytes, dumpBytes }
}

/** Wartet auf das Ende von pg_dump (mit Timeout, falls der Prozess haengt). */
async function warteAufPgDumpEnde(exit: Promise<PgDumpResult>): Promise<PgDumpResult> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      exit,
      new Promise<PgDumpResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              code: null,
              signal: null,
              stderr: `pg_dump-Prozess beendete sich nicht innerhalb von ${PG_DUMP_EXIT_TIMEOUT_MS} ms`,
            }),
          PG_DUMP_EXIT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ---------- Restore aus ZIP-File ----------

export interface RestoreErgebnis {
  /** Groesse des eingespielten DB-Dumps in Bytes. */
  dumpBytes: number
  /** Anzahl der wiederhergestellten Foto-Dateien. */
  fotoDateien: number
  /** Anzahl der wiederhergestellten DATANORM-Dateien. */
  datanormDateien: number
}

/**
 * Spielt ein Backup-ZIP ein: entpackt in tmpdir, ruft pg_restore,
 * ersetzt Fotos (FOTOS_DIR) und DATANORM-Kataloge (DATANORM_DIR).
 *
 * Ersetzen statt Mergen: der Restore-Stand ist die Source of Truth. Beim
 * frueheren Merge blieben Fotos/Kataloge erhalten, die im Backup nicht
 * existieren — die Dateien paserten dann nicht mehr zu den restaurierten
 * Tabellenzeilen (`fotos`, `datanorm_dateien`). Fehlende `fotos/`- oder
 * `datanorm/`-Verzeichnisse im ZIP (sehr alte Backups) überspringen das
 * jeweilige Ersetzen — ein alter Dump alone macht die Ablage nicht leer.
 *
 * Wirft, wenn das ZIP kein 'castel-backup-1'-Manifest hat, wenn der
 * enthaltene DB-Dump leer/beschaedigt ist oder wenn `pg_restore`
 * fehlschlaegt. Jeder Exit-Code != 0 von pg_restore ist ein Fehler —
 * ein Restore, der "Erfolg" meldet, obwohl nichts eingespielt wurde,
 * ist schlimmer als ein klarer Fehler.
 *
 * Vorbedingung: API-Server muss gestoppt sein (Admin-Disziplin). Wir
 * pruefen das hier nicht, weil die Bedingung von aussen gilt; ein
 * Stop-Hook waere der falsche Ort.
 */
export async function restoreAusZip(
  zipPath: string,
  databaseUrl: string,
): Promise<RestoreErgebnis> {
  const tmp = await mkdtemp(join(tmpdir(), 'castel-restore-'))
  try {
    await entpackeZip(zipPath, tmp)
    await leseManifest(tmp)
    const dumpPath = join(tmp, 'dump.pgdump')
    const dumpBytes = await pruefeDump(dumpPath)
    await spieleDumpEin(dumpPath, databaseUrl)
    const fotoDateien = await stelleOrdnerInWieder(tmp, 'fotos', config.FOTOS_DIR, 'cp-fotos')
    const datanormDateien = await stelleOrdnerInWieder(
      tmp,
      'datanorm',
      config.DATANORM_DIR,
      'cp-datanorm',
    )
    return { dumpBytes, fotoDateien, datanormDateien }
  } finally {
    // Aufraeumen bei Erfolg UND bei Fehlern — sonst bleiben die
    // entpackten Daten (inkl. Fotos) im Temp-Verzeichnis liegen.
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** Entpackt das ZIP nach `ziel`. Fehler -> Exception mit stderr-Auszug. */
async function entpackeZip(zipPath: string, ziel: string): Promise<void> {
  const r = await fuehreKommando('unzip', ['-o', zipPath, '-d', ziel], 'unzip')
  if (r.code !== 0) {
    throw new Error(
      `Backup-ZIP konnte nicht entpackt werden (unzip exit ${r.code}): ${r.stderr.trim() || 'ohne Ausgabe'}`,
    )
  }
}

/** Liest und prueft das Manifest (Schema muss 'castel-backup-1' sein). */
async function leseManifest(tmp: string): Promise<BackupManifest> {
  let manifestRaw: string
  try {
    manifestRaw = await readFile(join(tmp, 'manifest.json'), 'utf8')
  } catch {
    throw new Error('manifest.json fehlt im Backup')
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(manifestRaw) as BackupManifest
  } catch {
    throw new Error('manifest.json im Backup ist kein gueltiges JSON')
  }
  if (manifest.schema !== 'castel-backup-1') {
    throw new Error(`Unbekanntes Backup-Schema '${manifest.schema}' — erwartet 'castel-backup-1'`)
  }
  return manifest
}

/**
 * Prueft den entpackten DB-Dump, BEVOR pg_restore laeuft: ein leerer
 * Dump (0 Bytes) oder ein fehlender PGDMP-Header bedeutet, dass das
 * Backup keinen verwertbaren Datenbank-Stand enthaelt. pg_restore
 * wuerde das erst mit "input file is too short" melden — nach dem
 * '--clean' hätten wir dann schon angefangen, die DB leerzuräumen.
 */
async function pruefeDump(dumpPath: string): Promise<number> {
  let size: number
  try {
    size = statSync(dumpPath).size
  } catch {
    throw new Error(
      'dump.pgdump fehlt im Backup — das ZIP enthaelt keinen Datenbank-Dump und kann nicht eingespielt werden.',
    )
  }
  if (size === 0) {
    throw new Error(
      'dump.pgdump ist leer (0 Bytes) — das Backup enthaelt keinen Datenbank-Dump. ' +
        'Ursache ist in der Regel ein fehlgeschlagener pg_dump (z. B. passt die Client-Version nicht zur Server-Version). ' +
        'Dieses Backup kann nicht eingespielt werden.',
    )
  }
  const header = await lieseDumpHeader(dumpPath)
  if (header !== PGDMP_MAGIC) {
    throw new Error(
      `dump.pgdump hat keinen gültigen PGDMP-Header ("${header}") — das Backup ist beschaedigt.`,
    )
  }
  return size
}

/** Liest die ersten 5 Bytes eines Dumps (Magic "PGDMP"). */
async function lieseDumpHeader(pfad: string): Promise<string> {
  const handle = await open(pfad, 'r')
  try {
    const buf = Buffer.alloc(5)
    const { bytesRead } = await handle.read(buf, 0, 5, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Spielt den Dump ein. Jeder Exit-Code != 0 ist ein Fehler. */
async function spieleDumpEin(dumpPath: string, databaseUrl: string): Promise<void> {
  const r = await fuehreKommando(
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
    'pg_restore',
  )
  if (r.code !== 0) {
    throw new Error(
      `pg_restore fehlgeschlagen (exit ${r.code}): ${r.stderr.trim() || 'ohne Ausgabe'}`,
    )
  }
}

/**
 * Stellt einen Ordner-Eintrag des Backups (z. B. `fotos` oder `datanorm`)
 * er-setzend wieder her: Zielverzeichnis wird zuerst geleert, dann der
 * Backup-Stand kopiert. Existiert der Ordner im ZIP nicht (uralte Backups),
 * bleibt das Ziel unangetastet und die Zahl ist 0.
 */
async function stelleOrdnerInWieder(
  tmp: string,
  eintrag: string,
  ziel: string,
  logTag: string,
): Promise<number> {
  const quelle = join(tmp, eintrag)
  let s
  try {
    s = statSync(quelle)
  } catch {
    // kein Ordner im Backup, ueberspringen (kein Loeschen des Ziels!)
    return 0
  }
  if (!s.isDirectory()) return 0
  const anzahl = await zaehleDateien(quelle)
  await mkdir(ziel, { recursive: true })
  await leereVerzeichnis(ziel)
  const r = await fuehreKommando('cp', ['-r', `${quelle}/.`, `${ziel}/`], logTag)
  if (r.code !== 0) {
    throw new Error(
      `${eintrag} konnten nicht wiederhergestellt werden (cp exit ${r.code}): ${
        r.stderr.trim() || 'ohne Ausgabe'
      }`,
    )
  }
  return anzahl
}

/** Loescht den Inhalt eines Verzeichnisses (das Verzeichnis selbst bleibt). */
async function leereVerzeichnis(dir: string): Promise<void> {
  const entries = await readdir(dir)
  for (const name of entries) {
    await rm(join(dir, name), { recursive: true, force: true })
  }
}

/** Zaehlt Dateien rekursiv (fuer die Restore-Zusammenfassung). */
async function zaehleDateien(dir: string): Promise<number> {
  let n = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isDirectory()) n += await zaehleDateien(join(dir, e.name))
    else n++
  }
  return n
}

/**
 * Fuehrt ein Kommando aus und liefert Exit-Code, stdout und stderr.
 * stderr wird zusaetzlich in das Server-Log geschrieben (wie vorher
 * `stdio: 'inherit'`), damit z. B. pg_restore-Fehler sichtbar sind.
 */
async function fuehreKommando(
  cmd: string,
  args: string[],
  logTag?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < STDOUT_MAX_CHARS) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < STDERR_MAX_CHARS) stderr += chunk
      if (logTag) process.stderr.write(`[${logTag}] ${chunk}`)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// ---------- Backup-Liste + Rotation ----------

export interface BackupDateiInfo {
  name: string
  size: number
  createdAt: string
  /**
   * Groesse des DB-Dumps (dump.pgdump) im ZIP in Bytes.
   * null = nicht ermittelbar (z. B. unzip nicht verfuegbar).
   */
  dumpBytes: number | null
  /**
   * true = das ZIP enthaelt einen nicht-leeren DB-Dump und ist
   * einspielbar. false = leerer Dump (Backup unbrauchbar).
   * null = unklar (nicht ermittelbar).
   */
  dumpOk: boolean | null
}

/**
 * Listet die Backups im Verzeichnis.
 *
 * `inspect: true` prueft zusaetzlich jede ZIP auf einen nicht-leeren
 * DB-Dump (via `unzip -l`). Das ist wichtig, weil ein Backup mit leerem
 * Dump zwar technisch existiert, aber beim Restore mit "input file is
 * too short" abbricht. Die Rotation ruft die Liste ohne `inspect` auf
 * (dort reicht der Dateiname).
 */
export async function listeBackups(
  dir: string = config.BACKUP_DIR,
  opts: { inspect?: boolean } = {},
): Promise<BackupDateiInfo[]> {
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
    out.push({ name: f.name, size: s.size, createdAt, dumpBytes: null, dumpOk: null })
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (opts.inspect) {
    await inspiziereDumps(out, dir)
  }
  return out
}

/** Prueft die ZIPs auf einen nicht-leeren dump.pgdump-Eintrag. */
async function inspiziereDumps(files: BackupDateiInfo[], dir: string): Promise<void> {
  // Maximal 8 ZIPs parallel entpacken-Vorschauen — bei 365 Kopien bleibt
  // die Liste so schnell.
  const parallel = 8
  let index = 0
  const workers = Array.from({ length: Math.min(parallel, files.length) }, async () => {
    while (index < files.length) {
      const f = files[index]
      index++
      if (!f) continue
      const bytes = await dumpGroesseImZip(join(dir, f.name))
      f.dumpBytes = bytes
      f.dumpOk = bytes === null ? null : bytes > 0
    }
  })
  await Promise.all(workers)
}

/**
 * Ermittelt die Groesse des dump.pgdump-Eintrags in einem ZIP
 * (via `unzip -l`). null, wenn das nicht ermittelbar ist.
 */
export async function dumpGroesseImZip(pfad: string): Promise<number | null> {
  let stdout: string
  try {
    const r = await fuehreKommando('unzip', ['-l', pfad])
    if (r.code !== 0) return null
    stdout = r.stdout
  } catch {
    // unzip fehlt (ENOENT) oder sonst nicht ausfuehrbar
    return null
  }
  for (const zeile of stdout.split('\n')) {
    const teile = zeile.trim().split(/\s+/)
    if (teile.length < 2) continue
    if (teile[teile.length - 1] !== 'dump.pgdump') continue
    const laenge = Number.parseInt(teile[0] ?? '', 10)
    if (Number.isFinite(laenge)) return laenge
  }
  return null
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
