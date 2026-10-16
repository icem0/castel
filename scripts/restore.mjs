// castel server restore: ZIP-Backup entpacken, pg_dump einspielen, Fotos zurück.
// Läuft auf dem Server (nicht im Client).
//
// Usage:
//   node scripts/restore.mjs <pfad-zu-backup.zip>
//
// ENV:
//   DATABASE_URL   – Postgres-Verbindungs-String (erforderlich)
//   FOTOS_DIR      – Zielverzeichnis für Fotos (Default: ./var/fotos)

import { execSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATABASE_URL = process.env.DATABASE_URL
const FOTOS_DIR = process.env.FOTOS_DIR || './var/fotos'
const zipPath = process.argv[2]

if (!DATABASE_URL) {
  console.error('FEHLER: DATABASE_URL ist nicht gesetzt')
  process.exit(1)
}
if (!zipPath) {
  console.error('Usage: node scripts/restore.mjs <pfad-zu-backup.zip>')
  process.exit(1)
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'castel-restore-'))

  console.log('[restore] entpacke …')
  execSync(`unzip -o "${zipPath}" -d "${tmp}"`, { stdio: 'inherit' })

  const sqlPath = join(tmp, 'dump.sql')
  const fotosDir = join(tmp, 'fotos')

  // 1) pg_dump einspielen
  console.log('[restore] pg_dump einspielen …')
  execSync(`psql "${DATABASE_URL}" -f "${sqlPath}"`, { stdio: 'inherit' })

  // 2) Fotos zurückkopieren
  try {
    execSync(`mkdir -p "${FOTOS_DIR}"`, { stdio: 'inherit' })
    execSync(`cp -r "${fotosDir}/." "${FOTOS_DIR}/"`, { stdio: 'inherit' })
    console.log('[restore] Fotos zurückgespielt')
  } catch {
    console.warn('[restore] keine Fotos im Backup gefunden — übersprungen')
  }

  console.log('[restore] fertig')
}

main().catch((e) => {
  console.error('[restore] fehlgeschlagen:', e)
  process.exit(1)
})
