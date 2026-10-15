#!/usr/bin/env node
// Bootet embedded-postgres, läuft Migrationen, ruft /api/auth/setup-status auf.
// Sinn: lokale Testumgebung ohne Docker.
//
// Aufruf:  node scripts/smoke-db.mjs

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { default: EmbeddedPostgres } = require('embedded-postgres')
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DATA_DIR = './var/pg-data'
const PORT = 5433
const USER = 'castel'
const PASSWORD = 'castel-dev'
const DB = 'castel'

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
  })

  if (!existsSync(resolve(DATA_DIR, 'PG_VERSION'))) {
    console.log('Initialisiere Postgres-Datenverzeichnis …')
    await pg.initialise()
  }
  console.log('Starte Postgres …')
  await pg.start()

  try {
    const created = await pg.createDatabase(DB)
    console.log('Datenbank angelegt:', created ? 'OK' : 'existierte')

    console.log('Migrationen ausführen …')
    const { default: postgres } = await import('postgres')
    const sql = postgres({
      host: 'localhost',
      port: PORT,
      user: USER,
      password: PASSWORD,
      database: DB,
    })
    // Wir fuehren die SQL-Dateien manuell aus (Drizzle-Migrator ist hier
    // umstaendlich, weil embedded-postgres eigene Connect-Lib hat).
    const migrations = ['0001_initial.sql', '0002_add_user_anzeigename.sql']
    for (const m of migrations) {
      console.log('  ->', m)
      await sql.unsafe(readFileSync(`src/db/migrations/${m}`, 'utf-8'))
    }
    console.log('Migrationen angewendet.')
    await sql.end()
  } finally {
    console.log('Stoppe Postgres …')
    await pg.stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
