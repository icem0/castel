// castel server backup: Sync triggern, dann pg_dump + FOTOS_DIR als ZIP.
//
// Reihenfolge (wichtig):
//   1) POST /api/admin/sync/all  -> der Server setzt den sync.forceAt-
//      Marker. Verbundene PWA-Worker pushen beim naechsten Tick ihre
//      Outbox. Wir warten, bis sich der buchungen-Count beruhigt hat
//      (max. SYNC_TIMEOUT_MS).
//   2) pg_dump $DATABASE_URL     -> Voll-Dump in tmpdir/dump.pgdump
//   3) cp -r FOTOS_DIR           -> tmpdir/fotos (auch wenn leer)
//   4) manifest.json             -> Metadaten (serverTime, dbCounts, fotoCount)
//   5) zip                       -> $BACKUP_DIR/castel-backup-<stamp>.zip
//
// Läuft auf dem Host (oder einem beliebigen Rechner, der DATABASE_URL +
// FOTOS_DIR + API_BASE_URL + ADMIN_TOKEN erreicht). Der Client bleibt
// dumm — er pushed nur, wenn der Server es sagt.
//
// ENV:
//   DATABASE_URL       Postgres-URL (Default: aus DB_* gebaut, host=localhost)
//   FOTOS_DIR          Verzeichnis mit den Artikel-Fotos (Default: ./var/fotos)
//   BACKUP_DIR         Zielverzeichnis für die ZIP-Datei (Default: ./var/backups)
//   API_BASE_URL       Basis-URL der castel-API, z. B. http://localhost:4280
//                      (Default: http://localhost:4280)
//   ADMIN_TOKEN        JWT eines Admin-Users (Bearer). Pflicht.
//   SYNC_TIMEOUT_MS    Max. Wartezeit auf Sync-Idle (Default: 120000 = 2 min)
//   SYNC_QUIET_MS      Zeitfenster ohne neue Buchungen, das als "idle" gilt
//                      (Default: 8000). Innerhalb dieses Fensters darf der
//                      buchungen-Count nicht mehr steigen.
//   SYNC_POLL_MS       Polling-Intervall (Default: 3000)

import { execFile, execSync } from 'node:child_process'
import { cp, mkdir, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------- Defaults aus ENV ----------

const DB_USER = process.env.DB_USER ?? 'castel'
const DB_PASSWORD = process.env.DB_PASSWORD ?? ''
const DB_NAME = process.env.DB_NAME ?? 'castel'
const DATABASE_URL =
  process.env.DATABASE_URL ??
  (DB_PASSWORD
    ? `postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}`
    : `postgres://${DB_USER}@localhost:5432/${DB_NAME}`)

const FOTOS_DIR = process.env.FOTOS_DIR ?? './var/fotos'
const BACKUP_DIR = process.env.BACKUP_DIR ?? './var/backups'
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:4280').replace(/\/+$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''

const SYNC_TIMEOUT_MS = Number.parseInt(process.env.SYNC_TIMEOUT_MS ?? '120000', 10)
const SYNC_QUIET_MS = Number.parseInt(process.env.SYNC_QUIET_MS ?? '8000', 10)
const SYNC_POLL_MS = Number.parseInt(process.env.SYNC_POLL_MS ?? '3000', 10)

if (!ADMIN_TOKEN) {
  console.error('FEHLER: ADMIN_TOKEN ist nicht gesetzt (JWT eines Admin-Users).')
  console.error('Tipp: Login via PWA, dann JWT aus dem Cookie oder LocalStorage extrahieren.')
  process.exit(1)
}

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

async function triggerSync() {
  const res = await fetch(`${API_BASE_URL}/api/admin/sync/all`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Sync-Trigger fehlgeschlagen (HTTP ${res.status} ${res.statusText}): ${body || '–'}`,
    )
  }
  const data = await res.json()
  if (!data.forceAt) throw new Error('Sync-Trigger: Server-Antwort ohne forceAt')
  return data.forceAt
}

async function fetchStatus() {
  const res = await fetch(`${API_BASE_URL}/api/sync/status`, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    throw new Error(`Status-Abfrage fehlgeschlagen (HTTP ${res.status})`)
  }
  return await res.json()
}

/**
 * Wartet, bis der Server "sync idle" meldet, d.h. der buchungen-Count
 * sich für SYNC_QUIET_MS nicht mehr erhöht hat. Maximal SYNC_TIMEOUT_MS.
 */
async function waitForSyncIdle() {
  const start = Date.now()
  let lastCounts = null
  let lastChangeAt = Date.now()

  while (Date.now() - start < SYNC_TIMEOUT_MS) {
    let st
    try {
      st = await fetchStatus()
    } catch (e) {
      console.warn(
        `[backup] status-poll fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`,
      )
      await sleep(SYNC_POLL_MS)
      continue
    }
    if (lastCounts === null) {
      lastCounts = st.counts
      lastChangeAt = Date.now()
      console.log(
        `[backup] sync gestartet: aktuell ${st.counts.buchungen} Buchungen, ` +
          `warte max. ${SYNC_TIMEOUT_MS / 1000}s …`,
      )
    } else if (st.counts.buchungen !== lastCounts.buchungen) {
      lastCounts = st.counts
      lastChangeAt = Date.now()
      console.log(`[backup] buchungen-Count geändert: jetzt ${st.counts.buchungen}`)
    } else if (Date.now() - lastChangeAt >= SYNC_QUIET_MS) {
      console.log(
        `[backup] sync idle seit ${SYNC_QUIET_MS / 1000}s (${st.counts.buchungen} Buchungen).`,
      )
      return st
    }
    await sleep(SYNC_POLL_MS)
  }

  console.warn(
    `[backup] SYNC_TIMEOUT_MS=${SYNC_TIMEOUT_MS}ms überschritten — fahre mit Backup fort. ` +
      'Möglicherweise sind nicht alle Client-Outboxen synchronisiert.',
  )
  return await fetchStatus().catch(() => ({
    serverTime: new Date().toISOString(),
    counts: lastCounts ?? { artikel: 0, standorte: 0, commission: 0, buchungen: 0 },
  }))
}

async function copyFotos(targetDir) {
  let count = 0
  try {
    const s = await stat(FOTOS_DIR)
    if (!s.isDirectory()) {
      await mkdir(targetDir, { recursive: true })
      return 0
    }
  } catch {
    await mkdir(targetDir, { recursive: true })
    return 0
  }
  await cp(FOTOS_DIR, targetDir, { recursive: true, dereference: true })
  const entries = await readdir(targetDir, { withFileTypes: true })
  count = entries.filter((e) => e.isDirectory()).length
  return count
}

function runPgDump(sqlPath) {
  // -Fc: custom-Format, kompakter + komprimiert + parallele Restore-fähig.
  // --no-owner / --no-acl: skippt ownership/privileges.
  return new Promise((resolve, reject) => {
    const child = execFile(
      'pg_dump',
      ['-Fc', '--no-owner', '--no-acl', DATABASE_URL, '-f', sqlPath],
      { stdio: 'inherit' },
      (err) => (err ? reject(err) : resolve()),
    )
    child.on('error', reject)
  })
}

// ---------- Main ----------

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupName = `castel-backup-${stamp}`

async function main() {
  // 0) Sync-Trigger
  console.log('[backup] 1/5 Sync-Trigger an Server …')
  const forceAt = await triggerSync()
  console.log(`[backup]    forceAt=${forceAt}`)

  // 1) Auf Sync-Idle warten
  console.log('[backup] 2/5 warte auf Sync-Idle …')
  const finalStatus = await waitForSyncIdle()
  console.log(
    `[backup]    counts=${JSON.stringify(finalStatus.counts)} serverTime=${finalStatus.serverTime}`,
  )

  // 2) tmpdir + Manifest vorbereiten
  const tmp = mkdtempSync(join(tmpdir(), 'castel-backup-'))
  const dumpPath = join(tmp, 'dump.pgdump')
  const fotosDir = join(tmp, 'fotos')
  const manifestPath = join(tmp, 'manifest.json')

  // 3) pg_dump
  console.log('[backup] 3/5 pg_dump …')
  await runPgDump(dumpPath)

  // 4) Fotos kopieren
  console.log('[backup] 4/5 fotos …')
  const fotoCount = await copyFotos(fotosDir)

  // 5) Manifest
  const manifest = {
    schema: 'castel-backup-1',
    createdAt: new Date().toISOString(),
    forceAt,
    serverTime: finalStatus.serverTime,
    dbCounts: finalStatus.counts,
    fotoCount,
    tool: 'scripts/backup.mjs',
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

  // 6) Zielverzeichnis + ZIP
  await mkdir(BACKUP_DIR, { recursive: true })
  const zipPath = join(BACKUP_DIR, `${backupName}.zip`)
  console.log(`[backup] 5/5 zip -> ${zipPath}`)
  execSync(`cd "${tmp}" && zip -r "${zipPath}" dump.pgdump fotos manifest.json`, {
    stdio: 'inherit',
  })

  await rm(tmp, { recursive: true, force: true }).catch(() => {})

  console.log(
    `[backup] fertig: ${zipPath} (${finalStatus.counts.buchungen} Buchungen, ${fotoCount} Foto-Artikel)`,
  )
}

main().catch((e) => {
  console.error('[backup] fehlgeschlagen:', e)
  process.exit(1)
})
