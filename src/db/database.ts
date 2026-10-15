// Dexie-Singleton für castel.
// Schema-Versionierung explizit: jede Schema-Änderung legt eine neue .version() an.
// Die Domänen-Schicht liest und schreibt über dieses Singleton.
//
// Aktuelles Schema: v8 (Barcode-Feld + Index auf `artikel.barcode`).
// Frühere Versionen (v1–v7) sind nur noch für Migration existierender
// Browser-DBs. Wenn du eine frische DB anlegst, wird direkt v8 verwendet.
//
// Hinweis: v5→v6 ist ein PK-Wechsel von `key` auf `[key+userId]` für die
// `einstellungen`-Tabelle. Dexie kann das nicht in-place; siehe Kommentar
// an v5 für den Table-Rename-Trick.

import Dexie, { type Table } from 'dexie'
import type {
  Artikel,
  AuditLogEintrag,
  Buchung,
  Einstellung,
  OutboxEintrag,
  Projekt,
  Standort,
} from './types'

/** Canonical IndexedDB name — single source of truth for default connections and resets. */
export const DB_NAME = 'castel'

export class CastelDb extends Dexie {
  artikel!: Table<Artikel, string>
  standorte!: Table<Standort, string>
  buchungen!: Table<Buchung, string>
  projekte!: Table<Projekt, string>
  einstellungen!: Table<Einstellung, [string, string]>
  auditLog!: Table<AuditLogEintrag, string>
  /** Sync-Que: jede Schreiboperation landet hier, bis sie zum Server gepusht ist. */
  outbox!: Table<OutboxEintrag, string>

  constructor(name = DB_NAME) {
    super(name)

    // v1: Originalschema (vor PWA-Multi-User)
    this.version(1).stores({
      artikel: 'id, sharePointId, typ, status, archiviert, titel',
      standorte: 'id, name, typ, archiviert',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId',
      projekte: 'id, nummer, archiviert',
      einstellungen: 'key',
      auditLog: 'id, aktion, entitaet, entitaetId, zeit',
    })

    // v2: war mal "users"-Tabelle für lokales Auth. Diese Version bleibt leer
    // (Schema unverändert) — die alte users-Tabelle wird in v3 entfernt.
    this.version(2).stores({
      artikel: 'id, sharePointId, typ, status, archiviert, titel',
      standorte: 'id, name, typ, archiviert',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId',
      projekte: 'id, nummer, archiviert',
      einstellungen: 'key',
      auditLog: 'id, aktion, entitaet, entitaetId, zeit',
    })

    // v3: Sync-fähig — Outbox + serverId-Index
    this.version(3).stores({
      artikel: 'id, sharePointId, typ, status, archiviert, titel',
      standorte: 'id, name, typ, archiviert',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
      projekte: 'id, nummer, archiviert',
      einstellungen: 'key',
      auditLog: 'id, aktion, entitaet, entitaetId, zeit',
      outbox: 'id, entity, syncedAt, createdAt',
    })

    // v4: Artikel-Archivierung wandert vom `archiviert`-Flag in den Status.
    //      - `archiviert`-Index auf `artikel` entfällt
    //      - vorhandene `archiviert=true`-Artikel bekommen `status='archiviert'`
    //      - `archiviert`-Feld wird aus dem Datensatz entfernt
    this.version(4)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel',
        standorte: 'id, name, typ, archiviert',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        projekte: 'id, nummer, archiviert',
        einstellungen: 'key',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('artikel')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row['archiviert'] === true) {
              row['status'] = 'archiviert'
            }
            delete row['archiviert']
          })
      })

    // v5: Einstellungen werden Cross-Device synchronisiert — PK wird zum
    //      Compound [key+userId]. Dexie/IndexedDB kann einen PK nicht in-
    //      place wechseln (`UpgradeError: Not yet support for changing
    //      primary key`). Deshalb der Table-Rename-Trick:
    //      - v5 lässt `einstellungen` aus dem .stores()-Schema weg → Dexie
    //        droppt die Tabelle beim Upgrade selbst. Im .upgrade() lesen
    //        wir die alten Zeilen, schreiben sie in die temporäre Tabelle
    //        `einstellungen2` (Compound-PK) und lassen die alte Tabelle
    //        von Dexie droppen.
    //      - v6 deklariert `einstellungen` mit Compound-PK neu. Da die
    //        Tabelle in v5 vollständig verschwunden ist, interpretiert
    //        Dexie v6 als "create table" — kein PK-Wechsel, sondern ein
    //        frischer Create. `einstellungen2` verschwindet in v6.
    //
    //      Inhalt pro Zeile:
    //      - userId (null = global) und geaendertAm werden neu gesetzt
    //      - Alte Zeilen (v1–v4) bekommen userId=null und geaendertAm=now
    //      - Hinweis: Dexie erlaubt kein echtes `null` in Primary-Key-
    //        Komponenten. Wir nutzen die Konvention `userId = ''` (leerer
    //        String) für "global" im Index, behalten aber `null` im
    //        TypeScript-Type. Die Domain-Schicht normalisiert beim Lesen/
    //        Schreiben (siehe src/stores/settings.ts).
    this.version(5)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel',
        standorte: 'id, name, typ, archiviert',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        projekte: 'id, nummer, archiviert',
        // alte `einstellungen`-Tabelle fehlt absichtlich → Dexie droppt sie
        // neue Tabelle mit Compound-PK — temporärer Name, in v6 umbenannt
        einstellungen2: '[key+userId], key, userId',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // Dexie droppt die alte `einstellungen`-Tabelle NACH diesem
        // .upgrade()-Callback automatisch. Innerhalb der Transaktion ist
        // die Tabelle aber noch lesbar — wir retten alle Zeilen.
        const now = new Date().toISOString()
        const alteZeilen = await tx.table('einstellungen').toArray()
        const migrierte: Array<{
          key: string
          userId: string
          value: string
          geaendertAm: string
        }> = []
        for (const row of alteZeilen as Array<Record<string, unknown>>) {
          const key = typeof row['key'] === 'string' ? row['key'] : null
          const value = typeof row['value'] === 'string' ? row['value'] : ''
          const rawUid = row['userId']
          const userId: string = rawUid === undefined || rawUid === null ? '' : String(rawUid)
          const rawTs = row['geaendertAm']
          const geaendertAm: string = typeof rawTs === 'string' && rawTs.length > 0 ? rawTs : now
          if (!key) continue // kaputte Zeile — überspringen
          migrierte.push({ key, userId, value, geaendertAm })
        }
        if (migrierte.length > 0) {
          await tx.table('einstellungen2').bulkPut(migrierte)
        }
      })

    // v6: Compound-PK-Tabelle zurück unter den finalen Namen `einstellungen`.
    //     Dexie droppt `einstellungen2` und erstellt `einstellungen` mit
    //     Compound-PK. Die Daten aus `einstellungen2` werden im Upgrade
    //     nach `einstellungen` übertragen.
    this.version(6)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel',
        standorte: 'id, name, typ, archiviert',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        projekte: 'id, nummer, archiviert',
        einstellungen: '[key+userId], key, userId',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // `einstellungen2` ist im v6-Schema verschwunden — Dexie droppt
        // sie nach diesem Upgrade. Innerhalb der Transaktion lesen wir
        // die Zeilen, schreiben sie in die frisch angelegte
        // `einstellungen`-Tabelle und löschen die Quelle, damit keine
        // Geister-Zeilen zurückbleiben.
        const alteZeilen = await tx.table('einstellungen2').toArray()
        if (alteZeilen.length > 0) {
          await tx.table('einstellungen').bulkPut(alteZeilen)
          await tx.table('einstellungen2').clear()
        }
      })

    // v7: Outbox-Quarantäne. Zwei neue Felder + Index auf `quarantinedAt`,
    // damit die UI quarantinierte Items schnell auflisten kann.
    this.version(7)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel',
        standorte: 'id, name, typ, archiviert',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        projekte: 'id, nummer, archiviert',
        einstellungen: '[key+userId], key, userId',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt, quarantinedAt',
      })
      .upgrade(async (tx) => {
        const alle = await tx.table('outbox').toArray()
        for (const row of alle as Array<Record<string, unknown>>) {
          if (row['quarantinedAt'] === undefined) row['quarantinedAt'] = null
          if (row['quarantineReason'] === undefined) row['quarantineReason'] = null
        }
        if (alle.length > 0) {
          await tx.table('outbox').bulkPut(alle)
        }
      })

    // v8: Barcode-Feld auf `artikel` — semantisch getrennt von
    // `bestellnummer` (Lieferanten-Bestellnr. vs. Strichcode am Artikel).
    // Neuer Index auf `barcode` fuer den schnellen Scanner-Lookup.
    // Bestehende Datensaetze bekommen `barcode = null` (default).
    this.version(8)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel, barcode',
        standorte: 'id, name, typ, archiviert',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        projekte: 'id, nummer, archiviert',
        einstellungen: '[key+userId], key, userId',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt, quarantinedAt',
      })
      .upgrade(async (tx) => {
        const alle = await tx.table('artikel').toArray()
        for (const row of alle as Array<Record<string, unknown>>) {
          if (row['barcode'] === undefined) row['barcode'] = null
        }
        if (alle.length > 0) {
          await tx.table('artikel').bulkPut(alle)
        }
      })
  }
}

// Singleton, ersetzbar in Tests (z. B. in-memory pro Test).
let _db: CastelDb | null = null

export function getDb(): CastelDb {
  if (_db) return _db
  _db = new CastelDb()
  return _db
}

export function setDb(db: CastelDb): void {
  _db = db
}

export function resetDbForTests(): void {
  _db = null
}
