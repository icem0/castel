// castel server restore: ZIP-Backup entpacken, pg_restore einspielen,
// Fotos zurück. Läuft auf dem Host, gegen den Postgres-Container.
//
// Voraussetzungen (Admin-Disziplin, das Skript macht keinen Docker-Stop):
//   * Der castel-api-Service MUSS gestoppt sein, sonst überschreiben
//     sich der laufende Sync-Worker / Resolver und der Restore gegen-
//     seitig. Standard: `docker compose stop api`. Wer das Skript
//     dennoch gegen einen laufenden Server fährt, muss explizit
//     RESTORE_FORCE=1 setzen — das Skript warnt laut, bricht aber
//     nicht ab.
//   * pg_restore muss lokal installiert sein (Postgres-Client-Tools).
//   * Das Zielverzeichnis FOTOS_DIR muss beschreibbar sein.
//
// Usage:
//   node scripts/restore.mjs <pfad-zu-backup.zip>
//
// ENV:
//   DATABASE_URL      Postgres-URL (Default: aus DB_* gebaut, host=localhost)
//   FOTOS_DIR         Zielverzeichnis für Fotos (Default: ./var/fotos)
//   RESTORE_FORCE     1 = Skip der "API läuft"-Prüfung
//   API_HEALTH_URL    Override für die Health-URL (Default-Probes: 3000 + 4280)

import { execFile, execSync } from 'node:child_process'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

const DB_USER = process.env.DB_USER ?? 'castel'
const DB_PASSWORD = process.env.DB_PASSWORD ?? ''
const DB_NAME = process.env.DB_NAME ?? 'castel'
const DATABASE_URL =
  process.env.DATABASE_URL ??
  (DB_PASSWORD
    ? `postgres://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}`
    : `postgres://${DB_USER}@localhost:5432/${DB_NAME}`)

const FOTOS_DIR = process.env.FOTOS_DIR ?? './var/fotos'
const RESTORE_FORCE = process.env.RESTORE_FORCE === '1'

const zipPath = process.argv[2]
if (!zipPath) {
  console.error('Usage: node scripts/restore.mjs <pfad-zu-backup.zip>')
  process.exit(1)
}
const zipAbs = resolvePath(zipPath)

async function checkApiRunning() {
  const candidates = [
    process.env.API_HEALTH_URL ?? 'http://localhost:3000/api/healthz',
    'http://localhost:4280/api/healthz',
  ]
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch {
      // n/a
    }
  }
  return false
}

function runPgRestore(dumpPath) {
  // -Fc -> --format=custom (siehe backup.mjs).
  // --clean --if-exists: löscht vorhandene Objekte vor dem Restore.
  // --no-owner --no-acl: passt zum Backup.
  // --single-transaction: macht den Restore zu einer Transaktion, scheitert
  //   sauber bei Fehlern.
  return new Promise((resolve, reject) => {
    const child = execFile(
      'pg_restore',
      [
        '-d',
        DATABASE_URL,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        dumpPath,
      ],
      { stdio: 'inherit' },
      (err) => {
        if (err && err.message && !/exit code 1/i.test(err.message)) {
          reject(err)
        } else {
          resolve()
        }
      },
    )
    child.on('error', reject)
  })
}

async function main() {
  // 0) Warnung, wenn API noch antwortet
  const running = await checkApiRunning()
  if (running && !RESTORE_FORCE) {
    console.error(
      '[restore] ABBRUCH: Die API antwortet noch auf /api/healthz. Vor dem Restore ' +
        'muss der api-Service gestoppt sein (z. B. `docker compose stop api`), sonst ' +
        'überschreiben sich der Resolver und der Restore gegenseitig.',
    )
    console.error(
      '[restore] Wenn du das wirklich willst (z. B. Test-Szenario), setze RESTORE_FORCE=1.',
    )
    process.exit(2)
  }
  if (running && RESTORE_FORCE) {
    console.warn(
      '[restore] WARNUNG: API läuft noch, RESTORE_FORCE=1 gesetzt — fahre trotzdem fort.',
    )
  }

  const tmp = await mkdtemp(join(tmpdir(), 'castel-restore-'))

  console.log('[restore] entpacke …')
  execSync(`unzip -o "${zipAbs}" -d "${tmp}"`, { stdio: 'inherit' })

  const manifestPath = join(tmp, 'manifest.json')
  const dumpPath = join(tmp, 'dump.pgdump')
  const fotosDir = join(tmp, 'fotos')

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    console.log('[restore] manifest:')
    console.log(`  schema:     ${manifest.schema}`)
    console.log(`  createdAt:  ${manifest.createdAt}`)
    console.log(`  serverTime: ${manifest.serverTime}`)
    console.log(`  dbCounts:   ${JSON.stringify(manifest.dbCounts)}`)
    console.log(`  fotoCount:  ${manifest.fotoCount}`)
    if (manifest.schema !== 'castel-backup-1') {
      throw new Error(`Unbekanntes Backup-Schema '${manifest.schema}' — erwartet 'castel-backup-1'`)
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Unbekanntes Backup-Schema')) {
      console.error(`[restore] ${e.message}`)
      process.exit(1)
    }
    console.warn('[restore] keine manifest.json im Backup — fahre trotzdem fort')
  }

  // 1) pg_restore
  console.log('[restore] pg_restore …')
  await runPgRestore(dumpPath)

  // 2) Fotos zurück
  await mkdir(FOTOS_DIR, { recursive: true })
  try {
    execSync(`cp -r "${fotosDir}/." "${FOTOS_DIR}/"`, { stdio: 'inherit' })
    console.log('[restore] Fotos zurückgespielt')
  } catch {
    console.warn('[restore] keine Fotos im Backup gefunden — übersprungen')
  }

  await rm(tmp, { recursive: true, force: true }).catch(() => {})

  console.log('[restore] fertig. API kann jetzt wieder gestartet werden.')
}

main().catch((e) => {
  console.error('[restore] fehlgeschlagen:', e)
  process.exit(1)
})
