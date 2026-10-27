// Migration-Runner. Wird per `npm run db:migrate` aufgerufen und beim
// Start des API-Containers (siehe server/Dockerfile).
// Liest alle .sql-Dateien aus src/db/migrations/ in alphabetischer Reihenfolge
// und führt sie gegen die konfigurierte DATABASE_URL aus.
//
// Pfadauflösung: relativ zur *eigenen Quelldatei* (in dev via tsx) bzw. zum
// *Image-Workspace* (im Container, wo migrations/ neben dist/ liegt). Damit
// funktioniert es sowohl lokal (`npm run db:migrate` aus server/) als auch
// im Docker-Image, egal von wo aus der Befehl gestartet wird.
//
// ---------- Warum ein eigener Runner statt drizzle-orms `migrate()` ----------
//
// Drizzle vergleicht ausschliesslich Zeitstempel: eine Migration laeuft nur,
// wenn `created_at` der zuletzt angewandten Migration kleiner ist als der
// `when`-Wert des Journals. Das Journal hier nutzt historische Pseudo-
// Zeitstempel (1700000000000 + Index * 1000). Sobald eine Installation ihre
// Buchfuehrung mit echten Zeitstempeln schreibt (z. B. weil eine Migration
// manuell angewandt wurde), sind die Pseudo-Zeitstempel des Journals alle
// "aelter" — und die noch fehlenden Migrationen werden NIE angewandt.
//
// Deshalb entscheidet dieser Runner ueber den Hash der Migrationsdatei:
//   * angewandt  = der SHA-256 der Datei steht in `drizzle.__drizzle_migrations`
//   * fehlend    = alle Migrationen NACH der zuletzt angewandten (Index im Journal)
// Beides ist unabhaengig davon, wie die Buchfuehrung geschrieben wurde, und
// ein nachtraeglich editierter Alt-Migrationsdatei wird nicht erneut laufen.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { getDb, closeDb } from './client.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Im Container (dist/db/migrate.js): ../migrations. In dev (src/db/migrate.ts):
// ./migrations (das Verzeichnis liegt direkt neben der Datei).
const candidates = [
  resolve(__dirname, '..', 'migrations'),
  resolve(__dirname, 'migrations'),
  resolve(__dirname, '..', 'src', 'db', 'migrations'),
]

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

interface Migration {
  idx: number
  tag: string
  /** SQL-Datei, an `--> statement-breakpoint` getrennt. */
  statements: string[]
  /** SHA-256 der Datei — der Fingerprint in der Buchfuehrung. */
  hash: string
}

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

async function readMigrations(folder: string): Promise<Migration[]> {
  const journalRaw = await readFile(join(folder, 'meta', '_journal.json'), 'utf8')
  const journal = JSON.parse(journalRaw) as { entries: JournalEntry[] }
  const migrations: Migration[] = []
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const query = await readFile(join(folder, `${entry.tag}.sql`), 'utf8')
    migrations.push({
      idx: entry.idx,
      tag: entry.tag,
      statements: query.split('--> statement-breakpoint'),
      hash: createHash('sha256').update(query).digest('hex'),
    })
  }
  return migrations
}

/**
 * Legt die Buchfuehrungs-Tabelle an (wie der Drizzle-Migrator) und liefert
 * die Hashes der bereits angewandten Migrationen.
 */
async function readAppliedHashes(
  db: ReturnType<typeof getDb>,
): Promise<Set<string>> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`)
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`,
  )
  const rows = await db.execute<{ hash: string }>(
    sql`select hash from drizzle.__drizzle_migrations`,
  )
  return new Set(rows.map((r) => r.hash))
}

/**
 * Index der zuletzt angewandten Migration im Journal. Alles dahinter ist
 * pending. `-1`, wenn noch nichts angewandt wurde (frische DB).
 *
 * Der Vergleich laeuft ueber die Hashes, nicht ueber Zeitstempel — siehe die
 * Kopfzeile dieser Datei.
 */
function letzterAngewandterIndex(
  migrations: Migration[],
  applied: Set<string>,
): number {
  let letzter = -1
  for (const m of migrations) {
    if (applied.has(m.hash) && m.idx > letzter) letzter = m.idx
  }
  return letzter
}

async function main() {
  const db = getDb()
  const folder = await findMigrationsFolder()
  try {
    const migrations = await readMigrations(folder)
    const applied = await readAppliedHashes(db)
    const letzterIdx = letzterAngewandterIndex(migrations, applied)
    const pending = migrations.filter((m) => m.idx > letzterIdx)

    if (pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`Keine offenen Migrationen (Stand: ${migrations.length}).`)
      return
    }

    // eslint-disable-next-line no-console
    console.log(
      `Migrationen werden ausgeführt aus ${folder} ` +
        `(${pending.length} offen: ${pending.map((m) => m.tag).join(', ')}) …`,
    )

    for (const migration of pending) {
      await db.transaction(async (tx) => {
        for (const stmt of migration.statements) {
          await tx.execute(sql.raw(stmt))
        }
        await tx.execute(
          sql`insert into drizzle.__drizzle_migrations ("hash", "created_at") values (${migration.hash}, ${Date.now()})`,
        )
      })
      // eslint-disable-next-line no-console
      console.log(`  ${migration.tag} angewandt.`)
    }
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
