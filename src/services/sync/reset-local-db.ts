// Service: lokale IndexedDB vollständig leeren und mit einem frischen
// Snapshot vom Server wieder befüllen.
//
// Use-Case: lokale DB ist korrupt (z. B. fehlgeschlagene Schema-Migration,
// Geister-Zeilen nach v5→v6, manueller Eingriff) und der inkrementelle
// Sync-Worker reicht nicht, weil er nur Änderungen seit lastPull zieht.
// Dann hilft nur: DB weg, kompletter Snapshot vom Server.
//
// Reihenfolge:
//   1) Sync-Worker stoppen (keine parallelen Schreibvorgänge aus dem
//      Worker, die den Reset blockieren oder in eine geschlossene DB
//      schreiben würden).
//   2) Dexie-Verbindung schließen.
//   3) IndexedDB-Datenbank droppen.
//   4) Frischen Snapshot vom Server holen (ohne `since` → komplett).
//   5) Snapshot in eine neue Dexie-Instanz schreiben.
//   6) Seite neu laden — Stores leben weiterhin in-memory, holen sich
//      die Daten aus der frischen DB aber erst nach dem Reload.
//
// Fehler in Schritt 4 sind fatal (kein Snapshot → leere DB). Wir laden
// die Seite NICHT neu, sondern werfen den Fehler, damit der User es
// nochmal versuchen kann (oder den Server-Check macht).
//
// Hinweis: wir löschen bewusst nur die DB, nicht die Caches. Cache +
// DB-Reset sind getrennte Buttons, weil die Probleme getrennt sind.

import { getDb, resetDbForTests, DB_NAME } from '../../db/database'
import { jetztIso } from '../../domain/ids'
import { fetchSnapshot, stopSyncWorker, type SyncSnapshot } from './worker'

export { DB_NAME }

export interface ResetLocalDbResult {
  deletedDb: string
  pulled: {
    artikel: number
    standorte: number
    commission: number
    buchungen: number
    einstellungen: number
  }
  /**
   * Wurde am Ende `window.location.reload()` ausgelöst? Diese Property
   * wird durch den Aufrufer gesetzt (nicht durch die Service-Funktion
   * selbst) — die Funktion triggert keinen Reload.
   */
  reloaded: boolean
}

interface ApplySnapshotOptions {
  serverTime: string
  db: ReturnType<typeof getDb>
}

async function applyPulledSnapshot(data: SyncSnapshot, opts: ApplySnapshotOptions): Promise<void> {
  const { db } = opts

  await db.transaction(
    'rw',
    [db.artikel, db.standorte, db.commission, db.buchungen, db.einstellungen],
    async () => {
      if (data.artikel.length > 0) await db.artikel.bulkPut(data.artikel)
      if (data.standorte.length > 0) await db.standorte.bulkPut(data.standorte)
      if (data.commission.length > 0) await db.commission.bulkPut(data.commission)
      if (data.buchungen.length > 0) {
        // Buchungen: nur inserten, unbekannte IDs (Append-Only-Semantik).
        const existing = await db.buchungen.bulkGet(data.buchungen.map((b) => b.id))
        const toAdd: typeof data.buchungen = []
        for (let i = 0; i < data.buchungen.length; i++) {
          if (!existing[i]) toAdd.push(data.buchungen[i]!)
        }
        if (toAdd.length > 0) await db.buchungen.bulkAdd(toAdd)
      }
      if (data.einstellungen.length > 0) {
        // Einstellungen kommen mit userId=null; IndexedDB-Konvention
        // ist '' (siehe worker.ts:591–612).
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

  // lastPullAt-Marker schreiben (sonst startet der nächste Sync wieder
  // bei 0 und zieht alles nochmal — kein Fehler, aber unnötig).
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
}

/**
 * Löscht die lokale IndexedDB und zieht einen kompletten Snapshot vom
 * Server. Wirft, wenn der Server nicht erreichbar ist oder die
 * Snapshot-Antwort fehlschlägt — in dem Fall bleibt die DB gelöscht
 * und der User muss es nochmal versuchen (sonst hätten wir eine leere
 * App).
 *
 * Der Reload wird NICHT hier ausgelöst — der Aufrufer entscheidet, ob
 * und wann neu geladen wird. Im Normalfall kommt direkt danach ein
 * window.location.reload().
 */
export async function resetLocalDbAndPull(opts: {
  token: string | null
  apiBase: string
}): Promise<ResetLocalDbResult> {
  // 1) Sync-Worker anhalten. Sonst schreibt er munter weiter in eine
  //    gleich geschlossene DB und wirft.
  stopSyncWorker()

  const oldDb = getDb()

  // 2) Bestehende Dexie-Verbindung sauber schließen. delete() verlangt,
  //    dass keine Connection offen ist.
  oldDb.close()

  // 3) DB droppen.
  await oldDb.delete()

  // 4) Kompletten Snapshot ziehen (kein `since` → alles). Server-
  //    Snapshot.serverTime ist die Cutoff-Zeit für den nächsten
  //    inkrementellen Sync.
  const data = await fetchSnapshot(opts.apiBase, opts.token, '', '1970-01-01T00:00:00.000Z')

  // 5) Neue Dexie-Instanz anlegen. Dexie liest das Schema automatisch
  //    aus den .version()-Blöcken, also kein erneutes .stores() nötig.
  //    Wir setzen das Singleton zurück und holen uns eine frische
  //    Instanz — die alte ist geschlossen, würde jeder Zugriff
  //    fehlschlagen.
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
    },
    reloaded: false,
  }
}

/**
 * Test-Helfer: nur die DB leeren, ohne Snapshot-Pull. Wird in Tests
 * benutzt, um den Anfangszustand zu setzen. Setzt das Singleton zurück,
 * damit nachfolgende `getDb()`-Aufrufe eine frische Instanz erhalten.
 */
export async function clearLocalDbForTests(): Promise<void> {
  const { setDb } = await import('../../db/database')
  const db = getDb()
  db.close()
  await db.delete()
  resetDbForTests()
  setDb(getDb())
}
