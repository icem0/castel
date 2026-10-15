// Postgres-Client + Drizzle-Wrapper (Singleton).
//
// Wir nutzen `postgres` (postgres-js) statt `pg`, weil es Promise-natives
// Pipelining, prepared statements und einen schlanken API hat.
//
// In Tests wird dieser Client durch `setTestClient()` mit einer Test-DB
// ersetzt (siehe __tests__/test-helpers.ts).

import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { config } from '../config/config.js'
import * as schema from './schema.js'

let _client: ReturnType<typeof postgres> | null = null
let _db: PostgresJsDatabase<typeof schema> | null = null

export function getClient() {
  if (!_client) {
    _client = postgres(config.DATABASE_URL, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false, // wegen pgbouncer-Kompatibilität
    })
  }
  return _client
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    _db = drizzle(getClient(), { schema })
  }
  return _db
}

/** Für Tests: setzt einen eigenen Client. */
export function setTestClient(testDb: PostgresJsDatabase<typeof schema>) {
  _db = testDb
}

/** Schließt den Client. Wichtig in Tests, sonst hängt der Runner. */
export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.end({ timeout: 5 })
    _client = null
    _db = null
  }
}

export { schema }