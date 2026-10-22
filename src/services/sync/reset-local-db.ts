// Service: wipe the local IndexedDB and refill it with a fresh server
// snapshot.
//
// Use case: the local DB is corrupt (failed schema migration, ghost rows
// after v5→v6, manual interference) and the incremental sync worker is not
// enough because it only pulls changes since `lastPullAt`. Then the only
// way out is: drop the data, pull a complete server snapshot.
//
// Order of operations (snapshot is fetched FIRST, deliberately):
//   1) Fully stop and suspend the sync worker (interval, boot timer,
//      `online`/`visibilitychange` listeners). A running — or freshly
//      restarted — sync would immediately reopen and partly refill the
//      database we are about to wipe.
//   2) Fetch the complete snapshot from the server (no `since`). Local
//      data is still untouched at this point, so a server/network failure
//      is harmless — the app stays usable. With the old order (wipe first,
//      pull later) any network error left an empty app behind.
//   3) The worker stays suspended until the caller reloads the page.
//   4) Wipe every table inside ONE rw transaction. No `deleteDatabase()`:
//      that request is blocked by IndexedDB as long as a second tab of the
//      same origin holds the DB open (it then fires `blocked` and Dexie
//      waits forever — the button stayed stuck). A `clear()` needs no other
//      connection to be closed and is therefore robust. Only if the
//      transaction itself fails (broken schema, DB no longer openable) do
//      we escalate to `db.delete()`, guarded by a timeout.
//   5) Write the snapshot and set the `lastPullAt` markers.
//   6) Reload the page — stores stay in memory and only pick up the fresh
//      data after the reload.
//
// Note: we deliberately wipe data only, never caches. Cache wipe and DB
// reset are separate buttons because the underlying problems are separate.

import { getDb, resetDbForTests, DB_NAME } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { fetchSnapshot, suspendSyncWorker, type SyncSnapshot } from './worker'

export { DB_NAME }

/** Epoch marker for the mindestbestand snapshot (see worker.ts). */
const MINDEST_SINCE_EPOCHE = '1970-01-01T00:00:00.000Z'

export interface ResetLocalDbResult {
  deletedDb: string
  pulled: {
    artikel: number
    standorte: number
    commission: number
    buchungen: number
    einstellungen: number
    mindestbestandEreignisse: number
  }
  /**
   * Was `window.location.reload()` triggered at the end? Set by the caller
   * (not by this service function) — the service never reloads.
   */
  reloaded: boolean
}

interface ApplySnapshotOptions {
  serverTime: string
  db: ReturnType<typeof getDb>
}

/**
 * Wipes ALL tables in a single transaction. Deliberately `clear()` instead
 * of `db.delete()`: `deleteDatabase()` is blocked while another connection
 * (e.g. a second browser tab) has the DB open — Dexie then waits forever
 * and the admin button hangs.
 */
async function clearAllTables(db: ReturnType<typeof getDb>): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear()
    }
  })
}

async function applyPulledSnapshot(data: SyncSnapshot, opts: ApplySnapshotOptions): Promise<void> {
  const { db } = opts

  await db.transaction(
    'rw',
    [
      db.artikel,
      db.standorte,
      db.commission,
      db.buchungen,
      db.einstellungen,
      db.mindestbestandEreignisse,
    ],
    async () => {
      if (data.artikel.length > 0) await db.artikel.bulkPut(data.artikel)
      if (data.standorte.length > 0) await db.standorte.bulkPut(data.standorte)
      if (data.commission.length > 0) await db.commission.bulkPut(data.commission)
      if (data.buchungen.length > 0) {
        // Bookings: insert only, unknown ids (append-only semantics).
        const existing = await db.buchungen.bulkGet(data.buchungen.map((b) => b.id))
        const toAdd: typeof data.buchungen = []
        for (let i = 0; i < data.buchungen.length; i++) {
          if (!existing[i]) toAdd.push(data.buchungen[i]!)
        }
        if (toAdd.length > 0) await db.buchungen.bulkAdd(toAdd)
      }
      // Mindestbestand events: append-only, id-keyed. The table is empty
      // after the reset, so a plain bulkPut is enough.
      if (data.mindestbestandEreignisse?.length > 0) {
        await db.mindestbestandEreignisse.bulkPut(data.mindestbestandEreignisse)
      }
      if (data.einstellungen.length > 0) {
        // Settings arrive with userId=null; the IndexedDB convention is ''
        // (see worker.ts).
        const keys = data.einstellungen.map(
          (e) => [e.key, e.userId === null ? '' : e.userId] as [string, string],
        )
        const existing = await db.einstellungen.bulkGet(keys)
        const toPut: typeof data.einstellungen = []
        const toAdd: typeof data.einstellungen = []
        for (let i = 0; i < data.einstellungen.length; i++) {
          const incoming = data.einstellungen[i]!
          const indexedUserId = incoming.userId === null ? '' : incoming.userId
          const local = existing[i]
          if (!local) {
            toAdd.push({ ...incoming, userId: indexedUserId })
          } else if (incoming.geaendertAm > local.geaendertAm) {
            toPut.push({ ...incoming, userId: indexedUserId })
          }
        }
        if (toAdd.length > 0) await db.einstellungen.bulkAdd(toAdd)
        if (toPut.length > 0) await db.einstellungen.bulkPut(toPut)
      }
    },
  )

  // Write the lastPullAt marker (otherwise the next sync starts at 0 and
  // pulls everything again — not an error, just wasteful).
  const now = jetztIso()
  await db.einstellungen.bulkPut([
    {
      key: 'sync.lastPullAt',
      userId: '',
      value: opts.serverTime,
      geaendertAm: now,
    },
    {
      key: 'sync.lastPushAt',
      userId: '',
      value: opts.serverTime,
      geaendertAm: now,
    },
  ])
  // Only set the mindestbestand marker if the snapshot actually carried
  // events (same logic as the regular sync path).
  if ((data.mindestbestandEreignisse?.length ?? 0) > 0) {
    await db.einstellungen.put({
      key: 'mindestbestand.lastPullAt',
      userId: '',
      value: data.mindestSince ?? opts.serverTime,
      geaendertAm: now,
    })
  }
}

/**
 * Wipes the local data and pulls a complete snapshot from the server.
 * Throws when the server is unreachable or the snapshot request fails —
 * local data is then left untouched and the user can simply retry.
 *
 * The reload is NOT triggered here — the caller decides whether and when
 * to reload. In the normal flow a `window.location.reload()` follows
 * immediately.
 */
export async function resetLocalDbAndPull(opts: {
  token: string | null
  apiBase: string
}): Promise<ResetLocalDbResult> {
  // 1) Fully stop and suspend the sync worker (including the
  //    `online`/`visibilitychange` listeners) so the app cannot revive it
  //    mid-reset. Stays suspended until the caller reloads.
  suspendSyncWorker()

  // 2) Fetch the snapshot FIRST — local data is still intact here, so a
  //    server/network error leaves the app usable instead of empty.
  const data = await fetchSnapshot(opts.apiBase, opts.token, '', MINDEST_SINCE_EPOCHE)

  const db = getDb()

  // 3) Wipe the data. A `clear()` runs on the still-open connection and
  //    is — unlike `deleteDatabase()` — never blocked by other tabs.
  try {
    await clearAllTables(db)
  } catch (e) {
    // Broken schema / DB no longer openable: escalate to a real drop.
    // Guarded by a timeout so a blocked deleteDatabase request (e.g. a
    // second tab) cannot hang forever.
    console.warn('[reset-local-db] clear() failed, escalating to db.delete()', e)
    db.close()
    await dropDatabase(db)
  }

  // 4) Create a fresh Dexie instance. Dexie reads the schema straight
  //    from the .version() blocks, so no re-declaration of .stores() is
  //    needed. The singleton is reset so callers get a new instance —
  //    required after the drop fallback, where the old one was closed and
  //    every access to it would fail.
  resetDbForTests()
  const newDb = getDb()

  await applyPulledSnapshot(data, {
    serverTime: data.serverTime,
    db: newDb,
  })

  return {
    deletedDb: DB_NAME,
    pulled: {
      artikel: data.artikel.length,
      standorte: data.standorte.length,
      commission: data.commission.length,
      buchungen: data.buchungen.length,
      einstellungen: data.einstellungen.length,
      mindestbestandEreignisse: data.mindestbestandEreignisse?.length ?? 0,
    },
    reloaded: false,
  }
}

/**
 * Last resort: drop the whole IndexedDB. `indexedDB.deleteDatabase()`
 * blocks while another connection is open and Dexie then waits without a
 * timeout. We abort after 10 s and throw a message that names the most
 * likely cause (a second open tab).
 */
async function dropDatabase(db: ReturnType<typeof getDb>): Promise<void> {
  let blockedByOtherTab = false
  db.on('blocked', () => {
    blockedByOtherTab = true
  })

  const timeoutMs = 10_000
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            blockedByOtherTab
              ? 'Lokale Datenbank wird blockiert — bitte alle weiteren castel-Tabs schließen und erneut versuchen.'
              : 'Lokale Datenbank konnte nicht gelöscht werden (Timeout).',
          ),
        ),
      timeoutMs,
    )
  })

  try {
    await Promise.race([db.delete(), timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * Test helper: wipe the DB without pulling a snapshot. Used to set up the
 * initial state in tests. Resets the singleton so subsequent `getDb()`
 * calls get a fresh instance.
 */
export async function clearLocalDbForTests(): Promise<void> {
  const { setDb } = await import('../../db/database')
  const db = getDb()
  db.close()
  await db.delete()
  resetDbForTests()
  setDb(getDb())
}
