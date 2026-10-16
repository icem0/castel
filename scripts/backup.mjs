// castel server backup: pg_dump + FOTOS_DIR als ZIP.
// Läuft auf dem Server (nicht im Client). Der Client bleibt "dumm".
//
// ENV:
//   DATABASE_URL   – Postgres-Verbindungs-String (erforderlich)
//   FOTOS_DIR      – Verzeichnis mit den Artikel-Fotos (Default: ./var/fotos)
//   BACKUP_DIR     – Zielverzeichnis für Backups (Default: ./var/backups)

import { execSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL
const FOTOS_DIR = process.env.FOTOS_DIR || './var/fotos'
const BACKUP_DIR = process.env.BACKUP_DIR || './var/backups'

if (!DATABASE_URL) {
  console.error('FEHLER: DATABASE_URL ist nicht gesetzt')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupName = `castel-backup-${stamp}`

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'castel-backup-'))
  const sqlPath = join(tmp, 'dump.sql')
  const fotosDir = join(tmp, 'fotos')

  // 1) PostgreSQL-Dump
  console.log('[backup] pg_dump …')
  execSync(`pg_dump "${DATABASE_URL}" > "${sqlPath}"`, { stdio: 'inherit' })

  // 2) Fotos kopieren (falls Verzeichnis existiert)
  try {
    execSync(`cp -r "${FOTOS_DIR}" "${fotosDir}"`, { stdio: 'inherit' })
  } catch {
    await import('node:fs/promises').then((fs) => fs.writeFile(join(fotosDir, '.keep'), ''))
  }

  // 3) Zielverzeichnis sicherstellen
  execSync(`mkdir -p "${BACKUP_DIR}"`, { stdio: 'inherit' })

  // 4) ZIP archivieren
  const zipPath = join(BACKUP_DIR, `${backupName}.zip`)
  console.log('[backup] zip erstellen …')
  execSync(`cd "${tmp}" && zip -r "${zipPath}" dump.sql fotos`, {
    stdio: 'inherit',
  })

  console.log(`[backup] fertig: ${zipPath}`)
}

main().catch((e) => {
  console.error('[backup] fehlgeschlagen:', e)
  process.exit(1)
})
