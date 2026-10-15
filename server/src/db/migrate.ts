// Migration-Runner. Wird per `npm run db:migrate` aufgerufen.
// Liest alle .sql-Dateien aus src/db/migrations/ in alphabetischer Reihenfolge
// und führt sie gegen die konfigurierte DATABASE_URL aus.
//
// Pfadauflösung: relativ zur *eigenen Quelldatei* (in dev via tsx) bzw. zum
// *Image-Workspace* (im Container, wo migrations/ neben dist/ liegt). Damit
// funktioniert es sowohl lokal (`npm run db:migrate` aus server/) als auch
// im Docker-Image, egal von wo aus der Befehl gestartet wird.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { getDb, closeDb } from './client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Im Container (dist/db/migrate.js): ../migrations. In dev (src/db/migrate.ts):
// ../src/db/migrations.
const candidates = [
  resolve(__dirname, '..', 'migrations'),
  resolve(__dirname, '..', 'src', 'db', 'migrations'),
]

async function findMigrationsFolder(): Promise<string> {
  const { access } = await import('node:fs/promises')
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // nicht vorhanden, naechster
    }
  }
  throw new Error(
    `Kein migrations/-Ordner gefunden. Erwartet in: ${candidates.join(', ')}`,
  )
}

async function main() {
  const db = getDb()
  const folder = await findMigrationsFolder()
  try {
    // eslint-disable-next-line no-console
    console.log(`Migrationen werden ausgeführt aus ${folder} …`)
    await migrate(db, { migrationsFolder: folder })
    // eslint-disable-next-line no-console
    console.log('Fertig.')
  } finally {
    await closeDb()
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Migration fehlgeschlagen:', err)
  process.exit(1)
})
