// Dexie-Singleton für castel.
// Schema-Versionierung explizit: jede Schema-Änderung legt eine neue .version() an.
// Die Domänen-Schicht liest und schreibt über dieses Singleton.
//
// Aktuelles Schema: v17 (Rabattsatz je Lieferant + Listenpreis in Cent,
// siehe Kommentar bei v17). Frühere Versionen (v1–v16) sind nur noch für
// Migration existierender Browser-DBs. Wenn du eine frische DB anlegst,
// wird direkt v17 verwendet.
//
// Hinweis: v5→v6 ist ein PK-Wechsel von `key` auf `[key+userId]` für die
// `einstellungen`-Tabelle. Dexie kann das nicht in-place; siehe Kommentar
// an v5 für den Table-Rename-Trick.

import Dexie, { type Table } from 'dexie'
import type {
  Artikel,
  ArtikelStandortMindestbestand,
  AuditLogEintrag,
  Buchung,
  Einstellung,
  Hersteller,
  MindestbestandEreignis,
  Netzteil,
  OutboxEintrag,
  Projekt,
  Projektakku,
  Standort,
} from './types'

/** Canonical IndexedDB name — single source of truth for default connections and resets. */
export const DB_NAME = 'castel'

export class CastelDb extends Dexie {
  artikel!: Table<Artikel, string>
  /** Hersteller-Stammdaten (Bestellkontakt) — LWW-synchron wie Artikel. */
  hersteller!: Table<Hersteller, string>
  /**
   * Mindestbestand je (Artikel, Standort), sparse. Identitaet ist das Paar
   * `[artikelId+standortId]`; eine Zeile existiert nur bei konfiguriertem
   * Wert. `mindestbestand <= 0` = kein Alarm.
   */
  artikelStandortMindestbestaende!: Table<ArtikelStandortMindestbestand, [string, string]>
  standorte!: Table<Standort, string>
  buchungen!: Table<Buchung, string>
  commission!: Table<Projekt, string>
  einstellungen!: Table<Einstellung, [string, string]>
  auditLog!: Table<AuditLogEintrag, string>
  /** Sync-Que: jede Schreiboperation landet hier, bis sie zum Server gepusht ist. */
  outbox!: Table<OutboxEintrag, string>
  /**
   * Mindestbestand-Ereignisse, vom Server-Resolver ausgelöst. Append-only
   * (kein Client-Insert). Wird vom Snapshot-Endpoint über `mindestSince`
   * inkrementell gezogen. Treibt das Glocken-Panel in der AppShell und
   * den Admin-View `/einstellungen/mindestbestand`.
   */
  mindestbestandEreignisse!: Table<MindestbestandEreignis, string>
  /** Akkutausch: eingebaute Netzteile (Akku-Tausch in festem Intervall). */
  akkuNetzteile!: Table<Netzteil, string>
  /** Akkutausch: Projektbatterien je Quartal. */
  akkuProjekte!: Table<Projektakku, string>

  constructor(name = DB_NAME) {
    super(name)

    // v1: Originalschema (vor PWA-Multi-User)
    this.version(1).stores({
      artikel: 'id, sharePointId, typ, status, archiviert, titel',
      standorte: 'id, name, typ, archiviert',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId',
      commission: 'id, nummer, archiviert',
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
      commission: 'id, nummer, archiviert',
      einstellungen: 'key',
      auditLog: 'id, aktion, entitaet, entitaetId, zeit',
    })

    // v3: Sync-fähig — Outbox + serverId-Index
    this.version(3).stores({
      artikel: 'id, sharePointId, typ, status, archiviert, titel',
      standorte: 'id, name, typ, archiviert',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
      commission: 'id, nummer, archiviert',
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
        commission: 'id, nummer, archiviert',
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
        commission: 'id, nummer, archiviert',
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
        commission: 'id, nummer, archiviert',
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
        commission: 'id, nummer, archiviert',
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
        commission: 'id, nummer, archiviert',
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

    // v9: Index auf `standorte.standard` ergaenzen. Wird vom Store in
    //     `setStandard` und `anlegen({standard:true})` per
    //     `where('standard').equals(1)` abgefragt — der Index fehlte
    //     in v1–v8, weshalb der "Standard"-Switch im UI still scheiterte
    //     und `standardlager` dauerhaft `null` blieb (Folge: Bestand-
    //     Spalte in der Artikel-Liste wurde ausgeblendet).
    //     Daten-Migration ist nicht noetig — das Feld existiert seit v1,
    //     es fehlte nur der Index-Eintrag.
    this.version(9)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel, barcode',
        standorte: 'id, name, typ, archiviert, standard',
        buchungen:
          'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
        commission: 'id, nummer, archiviert',
        einstellungen: '[key+userId], key, userId',
        auditLog: 'id, aktion, entitaet, entitaetId, zeit',
        outbox: 'id, entity, syncedAt, createdAt, quarantinedAt',
      })
      .upgrade(async (_tx) => {
        /* Index wird beim Upgrade automatisch aufgebaut. */
      })

    // v10: Tabelle `mindestbestandEreignisse` (Spiegel der Server-
    //      Tabelle). Wird vom Snapshot-Endpoint inkrementell über
    //      `?mindestSince=<iso>` gefüllt — kein Daten-Migration nötig,
    //      da der Client die Tabelle noch nicht kannte.
    this.version(10).stores({
      artikel: 'id, sharePointId, typ, status, titel, barcode',
      standorte: 'id, name, typ, archiviert, standard',
      buchungen:
        'id, artikelId, standortId, standortZielId, typ, erstelltAm, storno, stornoVon, paarId, serverId',
      commission: 'id, nummer, archiviert',
      einstellungen: '[key+userId], key, userId',
      auditLog: 'id, aktion, entitaet, entitaetId, zeit',
      outbox: 'id, entity, syncedAt, createdAt, quarantinedAt',
      mindestbestandEreignisse: 'id, artikelId, standortId, erstelltAm',
    })

    // v11: Clear the `mindestbestandEreignisse` mirror.
    //      The server computed `bestandDanach` with a stale aggregate (it read
    //      the sum through the connection pool instead of the still-open
    //      transaction), so the mirrored snapshot values were wrong — usually
    //      0 instead of the real bestand. Server migration 0014 truncates the
    //      source table; the local table is append-only and the snapshot
    //      endpoint only adds rows, so the bogus entries have to be dropped
    //      client-side as well.
    this.version(11)
      .stores({
        mindestbestandEreignisse: 'id, artikelId, standortId, erstelltAm',
      })
      .upgrade(async (tx) => {
        await tx.table('mindestbestandEreignisse').clear()
      })

    // v12: Flag `etikettenNeu` auf `artikel` (Etiketten-Druck, DIN A4).
    //      Kein Index — IndexedDB kennt keine Boolean-Keys, und der Filter
    //      "nur neue Artikel" laeuft ohnehin clientseitig ueber die
    //      Artikelliste. Bestehende Zeilen bekommen `true` (Default wie
    //      auf dem Server): sie sind damit "neu" und stehen in der
    //      Etikettenliste, bis der Marker per Button geloescht wird.
    this.version(12)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel, barcode',
      })
      .upgrade(async (tx) => {
        const alle = await tx.table('artikel').toArray()
        for (const row of alle as Array<Record<string, unknown>>) {
          if (row['etikettenNeu'] === undefined) row['etikettenNeu'] = true
        }
        if (alle.length > 0) {
          await tx.table('artikel').bulkPut(alle)
        }
      })

    // v13: Vertraulicher Netto-Einkaufspreis. Kein Index — die Dashboard-
    //      Auswertung laeuft ohnehin ueber alle Artikel. Bestehende Zeilen
    //      starten mit `null`; Nicht-Admins bekommen den Wert nie vom
    //      Server (Snapshot strippt ihn) und der Sync bereinigt ihn lokal.
    this.version(13)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel, barcode',
      })
      .upgrade(async (tx) => {
        const alle = await tx.table('artikel').toArray()
        for (const row of alle as Array<Record<string, unknown>>) {
          if (row['einkaufspreis'] === undefined) row['einkaufspreis'] = null
        }
        if (alle.length > 0) {
          await tx.table('artikel').bulkPut(alle)
        }
      })

    // v14: Hersteller-Stammdaten (Bestellkontakt) als eigene, LWW-synchrone
    //      Tabelle + Bestellstatus auf `artikel`. `herstellerId` verweist auf
    //      einen Hersteller (oder null). `bestellstatus` startet mit 'offen';
    //      `bestelltAm`/`bestelltVon` werden erst beim Markieren gesetzt.
    //      Kein Index auf die neuen Artikel-Felder — die Alarm-Auswertung
    //      laeuft ohnehin ueber die geladenen Zeilen.
    this.version(14)
      .stores({
        artikel: 'id, sharePointId, typ, status, titel, barcode',
        hersteller: 'id, name, geaendertAm',
      })
      .upgrade(async (tx) => {
        const alle = await tx.table('artikel').toArray()
        for (const row of alle as Array<Record<string, unknown>>) {
          if (row['herstellerId'] === undefined) row['herstellerId'] = null
          if (row['bestellstatus'] === undefined) row['bestellstatus'] = 'offen'
          if (row['bestelltAm'] === undefined) row['bestelltAm'] = null
          if (row['bestelltVon'] === undefined) row['bestelltVon'] = null
        }
        if (alle.length > 0) {
          await tx.table('artikel').bulkPut(alle)
        }
      })

    // v15: Mindestbestand je (Artikel, Standort). Sparse: eine Zeile
    //      entsteht nur bei einem positiven Wert. Der bisherige globale
    //      Wert (`artikel.mindestbestand`) wandert lokal in das Hauptlager
    //      (aktiver Standard-Standort) — identisch zum Server-Backfill in
    //      Migration 0020. Die Spalte bleibt als deprecated erhalten.
    this.version(15)
      .stores({
        artikelStandortMindestbestaende:
          '[artikelId+standortId], artikelId, standortId, geaendertAm',
      })
      .upgrade(async (tx) => {
        const standorte = (await tx.table('standorte').toArray()) as Array<Record<string, unknown>>
        const standard = standorte.find((s) => s['standard'] === true && s['archiviert'] !== true)
        if (!standard) return
        const standortId = String(standard['id'])
        const artikel = (await tx.table('artikel').toArray()) as Array<Record<string, unknown>>
        const now = new Date().toISOString()
        const rows = artikel
          .filter(
            (a) => typeof a['mindestbestand'] === 'number' && (a['mindestbestand'] as number) > 0,
          )
          .map((a) => ({
            artikelId: String(a['id']),
            standortId,
            mindestbestand: a['mindestbestand'] as number,
            geaendertAm: now,
            erstelltAm: now,
          }))
        if (rows.length > 0) {
          await tx.table('artikelStandortMindestbestaende').bulkPut(rows)
        }
      })

    // v16: Akkutausch — Netzteile und Projektakkus. Zwei neue Tabellen,
    //      die 1:1 die Server-Tabellen `akku_netzteile` / `akku_projekte`
    //      spiegeln (LWW ueber `geaendertAm`). Geloeschte Zeilen bleiben als
    //      Tombstone in der DB (`geloescht`), die Anzeige filtert sie heraus.
    this.version(16).stores({
      akkuNetzteile: 'id, anlage, geaendertAm',
      akkuProjekte: 'id, [jahr+quartal], geaendertAm',
    })

    // v17: Rabattsatz je Lieferant + einheitliche Preiseinheit.
    //      * `hersteller.rabattsatz` — Ø-Rabatt in Prozent (0 = kein Rabatt
    //        bekannt). Bestehende Zeilen starten bei 0.
    //      * `artikel.listenpreis` — bislang stand im lokalen Spiegel ein
    //        Euro-Wert (aus dem Artikelformular), waehrend der Server
    //        (und der CSV-Import) Cent erwarten. Die Einheit wird jetzt
    //        durchgaengig auf Cent vereinheitlicht: Werte mit Nachkomma
    //        stammen sicher aus dem Formular (Euro) und werden x100
    //        gerundet; ganzzahlige Werte (Import/Katalog/Server) sind
    //        bereits Cent und bleiben unveraendert.
    this.version(17)
      .stores({
        akkuNetzteile: 'id, anlage, geaendertAm',
        akkuProjekte: 'id, [jahr+quartal], geaendertAm',
      })
      .upgrade(async (tx) => {
        const hersteller = (await tx.table('hersteller').toArray()) as Array<
          Record<string, unknown>
        >
        for (const row of hersteller) {
          if (row['rabattsatz'] === undefined) row['rabattsatz'] = 0
        }
        if (hersteller.length > 0) {
          await tx.table('hersteller').bulkPut(hersteller)
        }

        const artikel = (await tx.table('artikel').toArray()) as Array<Record<string, unknown>>
        for (const row of artikel) {
          const listenpreis = row['listenpreis']
          if (
            typeof listenpreis === 'number' &&
            Number.isFinite(listenpreis) &&
            !Number.isInteger(listenpreis)
          ) {
            row['listenpreis'] = Math.round(listenpreis * 100)
          }
        }
        if (artikel.length > 0) {
          await tx.table('artikel').bulkPut(artikel)
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
