// Wipes the E2E database so every Playwright run (see ../../e2e) starts from
// an empty schema; the migration runner rebuilds it afterwards.
//
// Destructive by design, so it refuses to touch any database whose name does
// not end in "_e2e". Never point DATABASE_URL at a real instance here.

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('e2e-reset-db: DATABASE_URL is not set')
  process.exit(1)
}
const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
if (!/_e2e$/.test(dbName)) {
  console.error(`e2e-reset-db: refusing to wipe "${dbName}" (name must end in "_e2e")`)
  process.exit(1)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
  `)
  console.log(`e2e-reset-db: "${dbName}" wiped`)
} finally {
  await sql.end()
}
