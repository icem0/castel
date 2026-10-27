// Datenbank-Schema (Drizzle ORM / PostgreSQL).
// Quelle der Wahrheit für Server-Tabellen: PLAN.md §4, erweitert für §9b/§9d.
//
// Konventionen:
//   * Alle PKs sind UUID (TEXT, generiert via gen_random_uuid() aus pgcrypto)
//   * Zeitstempel als TIMESTAMPTZ (UTC)
//   * Soft-Delete: keine Spalte nötig, weil Buchungen append-only sind
//   * `*` in `*-`Indexes = "alle Sekundärindizes unten separat"

import {
  pgTable,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  boolean,
  jsonb,
  index,
  primaryKey,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ---------- User / Auth ----------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // crypto.randomUUID() clientseitig
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rolle: text('rolle', { enum: ['admin', 'user'] }).notNull(),
    aktiv: boolean('aktiv').notNull().default(true),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
    letzterLoginAm: timestamp('letzter_login_am', { withTimezone: true }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    anzeigename: text('anzeigename').notNull().default(''),
  },
  (t) => [uniqueIndex('users_email_lower_idx').on(t.email)],
)

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256-Hash des Tokens (nie Klartext speichern)
    tokenHash: text('token_hash').notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
    ablaufAm: timestamp('ablauf_am', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
  },
  (t) => [index('refresh_tokens_user_idx').on(t.userId), index('refresh_tokens_hash_idx').on(t.tokenHash)],
)

// ---------- API-Keys (Agentenzugriff) ----------

/**
 * API keys for machine/agent access. The plaintext key is shown exactly once
 * on creation; only its SHA-256 hash is stored here. `prefix` is the visible
 * part used to identify a key in the UI (e.g. `castel_ab12cd34`).
 *
 * Scopes are additive and never exceed the owning user's role:
 *   * read  — GET endpoints
 *   * write — mutating endpoints
 *   * admin — admin-only endpoints (only available to admin users)
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
    letzteNutzungAm: timestamp('letzte_nutzung_am', { withTimezone: true }),
    ablaufAm: timestamp('ablauf_am', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_keys_hash_idx').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
    index('api_keys_prefix_idx').on(t.prefix),
  ],
)

// ---------- Domänen-Tabellen (Spiegel der PWA) ----------

export const artikel = pgTable(
  'artikel',
  {
    id: text('id').primaryKey(),
    sharePointId: integer('share_point_id'),
    titel: text('titel').notNull(),
    status: text('status', {
      enum: ['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert'],
    })
      .notNull()
      .default('verfuegbar'),
    typ: text('typ').notNull().default(''),
    lieferant: text('lieferant'),
    verpackungseinheit: integer('verpackungseinheit').notNull().default(1),
    /** @deprecated Globaler Mindestbestand. Wird nicht mehr ausgewertet;
     *  die Schwelle gilt pro (Artikel, Standort) in
     *  `artikel_standort_mindestbestaende`. Bleibt fuer alte Clients und
     *  die Agenten-API v1 erhalten. */
    mindestbestand: integer('mindestbestand'),
    nachbestellHinweis: text('nachbestell_hinweis', {
      enum: ['i.O', 'bald', 'dringend'],
    }),
    bestellnummer: text('bestellnummer'),
    /** Strichcode (EAN/Code128/QR) — semantisch getrennt von `bestellnummer`
     *  (Lieferanten-Bestellnr. vs. Strichcode am Artikel). */
    barcode: text('barcode'),
    /** Marker "neu" fuer den Etiketten-Druck: TRUE = Artikel ist als
     *  neu markiert (Bogen noch zu drucken). Wird per Button gesetzt bzw.
     *  geloescht; neue Artikel starten mit TRUE. */
    etikettenNeu: boolean('etiketten_neu').notNull().default(true),
    listenpreis: integer('listenpreis'), // in Cent, um Floats zu vermeiden
    /** Netto-Einkaufspreis je Verpackungseinheit, in Cent. Nur Admin-sichtbar. */
    einkaufspreis: integer('einkaufspreis'),
    /** Referenz auf die Hersteller-Stammdaten (Bestellkontakt). Der
     *  Freitext `lieferant` bleibt fuer DATANORM/CSV erhalten. */
    herstellerId: text('hersteller_id').references(() => hersteller.id, {
      onDelete: 'set null',
    }),
    /** Bestellzustand des Mindestbestandsalarms: 'offen' | 'bestellt'. */
    bestellstatus: text('bestellstatus', { enum: ['offen', 'bestellt'] })
      .notNull()
      .default('offen'),
    bestelltAm: timestamp('bestellt_am', { withTimezone: true }),
    /** Anzeigename des Users, der die Bestellung ausgeloest hat. */
    bestelltVon: text('bestellt_von'),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('artikel_sharepoint_idx').on(t.sharePointId),
    index('artikel_typ_idx').on(t.typ),
    index('artikel_status_idx').on(t.status),
    index('artikel_barcode_idx').on(t.barcode),
    index('artikel_hersteller_idx').on(t.herstellerId),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('artikel_geaendert_am_idx').on(t.geaendertAm),
  ],
)

/**
 * Hersteller-Stammdaten mit Bestellkontakt.
 *
 * `bestell_email` und `bestell_webseite` beschreiben, WIE bei diesem
 * Hersteller bestellt wird (E-Mail-Adresse fuer eine Bestellmail oder
 * eine Bestell-/Shop-Webseite). Beides ist optional, mindestens eines
 * sollte gepflegt sein, damit der Mindestbestandsalarm einen
 * "Jetzt bestellen"-Button anbieten kann.
 *
 * Bewusst KEIN Unique-Constraint auf `name`: Offline angelegte Hersteller
 * koennen denselben Namen tragen; ein Constraint wuerde den Sync-Push in
 * die Quarantaene schicken. Der Client dedupliziert im Picker.
 */
export const hersteller = pgTable(
  'hersteller',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    bestellEmail: text('bestell_email'),
    bestellWebseite: text('bestell_webseite'),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('hersteller_geaendert_am_idx').on(t.geaendertAm),
    index('hersteller_name_lower_idx').on(sql`LOWER(${t.name})`),
  ],
)

export const standorte = pgTable(
  'standorte',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    typ: text('typ', { enum: ['lager', 'auto', 'baustelle', 'extern'] }).notNull(),
    projekt: text('projekt'),
    kennzeichen: text('kennzeichen'),
    standard: boolean('standard').notNull().default(false),
    archiviert: boolean('archiviert').notNull().default(false),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('standorte_name_idx').on(t.name),
    index('standorte_typ_idx').on(t.typ),
    index('standorte_archiviert_idx').on(t.archiviert),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('standorte_geaendert_am_idx').on(t.geaendertAm),
  ],
)

export const projekte = pgTable(
  'commission',
  {
    id: text('id').primaryKey(),
    nummer: text('nummer').notNull(),
    name: text('name'),
    archiviert: boolean('archiviert').notNull().default(false),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('commission_nummer_idx').on(t.nummer),
    index('commission_archiviert_idx').on(t.archiviert),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('commission_geaendert_am_idx').on(t.geaendertAm),
  ],
)

/**
 * Buchungen — append-only. Das ist die zentrale Tabelle.
 * - `serverId` ist die kanonische ID (UUID). Frontend darf diese IDs in der
 *   Outbox als `id` mitsenden (Idempotenz via PK).
 * - `stornoVon` zeigt (falls typ='storno') auf die Original-Buchung.
 * - `storniertDurch` ist Back-Ref, gesetzt wenn Original storniert wurde.
 */
export const buchungen = pgTable(
  'buchungen',
  {
    id: text('id').primaryKey(),
    artikelId: text('artikel_id')
      .notNull()
      .references(() => artikel.id),
    standortId: text('standort_id')
      .notNull()
      .references(() => standorte.id),
    standortZielId: text('standort_ziel_id').references(() => standorte.id),
    typ: text('typ', {
      enum: ['einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno'],
    }).notNull(),
    menge: integer('menge').notNull(), // signed, Einheit = Stück
    paarId: text('paar_id'),
    projekt: text('projekt'),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
    clientEingabeAm: timestamp('client_eingabe_am', { withTimezone: true }),
    erstelltVon: text('erstellt_von').notNull(), // User-ID
    kommentar: text('kommentar'),
    mitteilungAn: text('mitteilung_an'),
    stornoVon: text('storno_von'),
    storno: boolean('storno').notNull().default(false),
    storniertDurch: text('storniert_durch'),
  },
  (t) => [
    index('buchungen_artikel_idx').on(t.artikelId),
    index('buchungen_standort_idx').on(t.standortId),
    index('buchungen_standort_ziel_idx').on(t.standortZielId),
    index('buchungen_typ_idx').on(t.typ),
    index('buchungen_erstellt_am_idx').on(t.erstelltAm),
    index('buchungen_storno_idx').on(t.storno),
    index('buchungen_paar_idx').on(t.paarId),
    // Zusammengesetzter Index für die Bestandsformel
    index('buchungen_bestand_idx').on(t.artikelId, t.standortId),
  ],
)

/**
 * Mindestbestand je Artikel UND Standort.
 *
 * Frueher war `artikel.mindestbestand` ein globaler Wert fuer alle Lager.
 * Ab Migration 0020 gilt die Schwelle pro Paar; die Tabelle ist sparse
 * (eine Zeile entsteht nur, wenn fuer das Lager tatsaechlich ein Wert
 * konfiguriert wurde). `mindestbestand <= 0` = kein Alarm.
 *
 * Beide FKs sind `ON DELETE CASCADE`: das Loeschen von Artikel/Standort
 * nimmt die Konfiguration mit und wird nicht blockiert (Buchungen und
 * Mindestbestand-Events blockieren weiterhin).
 */
export const artikelStandortMindestbestaende = pgTable(
  'artikel_standort_mindestbestaende',
  {
    artikelId: text('artikel_id')
      .notNull()
      .references(() => artikel.id, { onDelete: 'cascade' }),
    standortId: text('standort_id')
      .notNull()
      .references(() => standorte.id, { onDelete: 'cascade' }),
    mindestbestand: integer('mindestbestand').notNull().default(0),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.artikelId, t.standortId] }),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('artikel_standort_mindestbestaende_geaendert_am_idx').on(t.geaendertAm),
  ],
)

// ---------- Fotos ----------

export const fotos = pgTable(
  'fotos',
  {
    id: text('id').primaryKey(),
    artikelId: text('artikel_id')
      .notNull()
      .references(() => artikel.id, { onDelete: 'cascade' }),
    pfad: text('pfad').notNull(), // relativ zu FOTOS_DIR
    contentType: text('content_type').notNull(),
    groesse: integer('groesse').notNull(), // Bytes
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
    erstelltVon: text('erstellt_von').notNull(),
  },
  (t) => [
    index('fotos_artikel_idx').on(t.artikelId),
    index('fotos_erstellt_am_idx').on(t.erstelltAm),
  ],
)

// ---------- Audit ----------

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    aktion: text('aktion').notNull(),
    entitaet: text('entitaet', {
      enum: [
        'artikel',
        'standort',
        'buchung',
        'kommission',
        'foto',
        'user',
        'einstellung',
        'lieferant',
        'hersteller',
        'hersteller_artikel',
        'datanorm_import',
        'artikel_standort_mindestbestand',
      ],
    }).notNull(),
    entitaetId: text('entitaet_id').notNull(),
    benutzerId: text('benutzer_id'),
    daten: jsonb('daten'),
    zeit: timestamp('zeit', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('audit_aktion_idx').on(t.aktion),
    index('audit_entitaet_idx').on(t.entitaet, t.entitaetId),
    index('audit_zeit_idx').on(t.zeit),
  ],
)

/**
 * Benutzer- und Konfigurations-Einstellungen (Cross-Device-Sync).
 * - user_id IS NULL  → global (z. B. artikelTypen, vom Admin gepflegt)
 * - user_id = <id>   → pro User (z. B. sprache, standardStandortId)
 *
 * user_id ist bewusst kein Primärschlüssel-Bestandteil: PostgreSQL verbietet
 * NULL-Werte in PK-Spalten, globale Einstellungen nutzen aber user_id = NULL.
 * Eindeutigkeit wird stattdessen über Unique-Indizes auf (key, user_id)
 * (plus einen partiellen Unique-Index für globals, user_id IS NULL)
 * sichergestellt — siehe Migration 0005 / 0007.
 */
export const einstellungen = pgTable(
  'einstellungen',
  {
    key: text('key').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('einstellungen_key_userid_idx').on(t.key, t.userId),
    index('einstellungen_user_idx').on(t.userId),
    index('einstellungen_geaendert_am_idx').on(t.geaendertAm),
  ],
)

// ---------- Hilfstabellen für Aggregat ----------

/**
 * Index auf `buchungen (artikel_id, standort_id)` ist in der
 * `buchungen`-Tabellendefinition oben integriert
 * (`buchungen_bestand_idx`).
 */

// ---------- Mindestbestand-Ereignisse (Server-Trigger) ----------
//
// Append-only Tabelle: der Sync-Resolver (`sync/resolver.ts`) inserted hier
// nach jeder akzeptierten Buchung, sobald der neue Bestand am Standort
// unter den `artikel.mindestbestand` fällt. PWA zieht die Tabelle über den
// Snapshot-Endpoint, ein lokaler Mirror (`mindestbestandEreignisse` in
// Dexie) treibt das Glocken-Panel in der AppShell.
//
// Die Felder `zustellung_admin_ids` und `konsumiert_von_mail` sind
// Server-only — sie bereiten den späteren SMTP-Digest-Job vor (tägliche
// Sammel-Mail an Admins) und werden beim Snapshot-Endpoint NICHT
// mit ausgeliefert.
export const mindestbestandEreignisse = pgTable(
  'mindestbestand_ereignisse',
  {
    id: text('id').primaryKey(),
    artikelId: text('artikel_id')
      .notNull()
      .references(() => artikel.id),
    standortId: text('standort_id')
      .notNull()
      .references(() => standorte.id),
    ausloeserBuchungId: text('ausloeser_buchung_id')
      .notNull()
      .references(() => buchungen.id),
    bestandDanach: integer('bestand_danach').notNull(),
    mindestbestand: integer('mindestbestand').notNull(),
    defizit: integer('defizit').notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
    zustellungAdminIds: text('zustellung_admin_ids').array().notNull().default([]),
    konsumiertVonMail: boolean('konsumiert_von_mail').notNull().default(false),
  },
  (t) => [
    // Snapshot-Endpoint filtert auf `erstellt_am > since` — Index Pflicht.
    index('mindestbestand_ereignisse_erstellt_am_idx').on(t.erstelltAm),
    // Panel-Filter: "alle Events für Artikel X".
    index('mindestbestand_ereignisse_artikel_standort_idx').on(
      t.artikelId,
      t.standortId,
      t.erstelltAm,
    ),
  ],
)

// ---------- DATANORM / Hersteller-Kataloge ----------
//
// DATANORM ist ein Legacy-Stammdatenformat des deutschen Fachgrosshandels
// (SATZzeichen je Zeile, Feldlayout variiert je Version, v4 in CP850).
// Die PWA fragt den Katalog on-demand per GET /api/datanorm/artikel ab und
// übernimmt einzelne Felder in die castel-Artikel — es gibt bewusst KEINEN
// Foreign Key zwischen beiden Welten und KEINEN Bestands-Import.
//
// Siehe `server/src/datanorm/` (Parser + Routen) und Migration 0013.

/**
 * Lieferant = ein DATANORM-Katalog. Die Identitaet legt der Admin beim Upload
 * fest (bestehenden Lieferanten waehlen oder neuen anlegen); der V-Satz ist
 * nur eine Anreicherung. `matchcode` (Lieferanten-Kuerzel aus dem Vorsatz)
 * ist case-insensitiv eindeutig, damit "MUELLER"/"Mueller" nicht zwei
 * Lieferanten werden. Auto-angelegte Lieferanten starten `aktiv = false`.
 */
export const lieferanten = pgTable(
  'lieferanten',
  {
    id: text('id').primaryKey(),
    matchcode: text('matchcode'),
    name: text('name').notNull(),
    strasse: text('strasse'),
    plz: text('plz'),
    ort: text('ort'),
    land: text('land').default('DE'),
    telefon: text('telefon'),
    email: text('email'),
    ustIdnr: text('ust_idnr'),
    aktiv: boolean('aktiv').notNull().default(false),
    /**
     * DATANORM-Format des Lieferanten: 'auto' (erkennen), 'v4' oder 'v5'.
     *
     * Das Format ist eine Eigenschaft des Lieferanten-Export und ändert
     * sich nicht von Upload zu Upload — deshalb wird es am Lieferanten
     * gespeichert und beim nächsten Upload vorgeschlagen.
     */
    format: text('format').notNull().default('auto'),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lieferanten_matchcode_lower_idx').on(sql`LOWER(${t.matchcode})`),
    index('lieferanten_aktiv_idx').on(t.aktiv),
    index('lieferanten_geaendert_am_idx').on(t.geaendertAm),
    index('lieferanten_format_idx').on(t.format),
  ],
)

/**
 * Hersteller-Artikel: 1:1-Spiegel eines DATANORM-Katalogs.
 *
 * Identitaet ist `(lieferant_id, matchcode)` — die Matchcode ist die
 * lieferanteneigene Artikelnummer. Preise in Cent (wie `artikel.listenpreis`).
 *
 * Mengen-Felder, bewusst getrennt (haeufig vermischt):
 *   * `mengeneinheit` — Einheit als Text ("Stueck", "m", "kg")
 *   * `preiseinheit`  — Faktor: "Preis gilt fuer N Einheiten" (v4: nur 1/10/100/1000)
 *   * `inhalt`        — Menge je verkaufter Einheit (z. B. 12 Stueck/Packung)
 * castel rechnet NICHT um — der Bestand bleibt in der erfassten Einheit.
 *
 * `deaktiviert` setzt ein v5-B-Saetz (Delete-Marker) des Lieferanten. Der
 * Eintrag bleibt sichtbar ("nicht mehr lieferbar"); castel-Artikel werden
 * bewusst NICHT angefasst.
 */
export const herstellerArtikel = pgTable(
  'hersteller_artikel',
  {
    id: text('id').primaryKey(),
    lieferantId: text('lieferant_id')
      .notNull()
      .references(() => lieferanten.id, { onDelete: 'restrict' }),
    matchcode: text('matchcode').notNull(),
    matchcode2: text('matchcode2'),
    ean: text('ean'),
    titel: text('titel').notNull(),
    beschreibung: text('beschreibung'),
    mengeneinheit: text('mengeneinheit'),
    preiseinheit: integer('preiseinheit'),
    inhalt: numeric('inhalt'),
    warengruppe: text('warengruppe'),
    preisNettoCent: integer('preis_netto_cent'),
    preisBruttoCent: integer('preis_brutto_cent'),
    preisAktionCent: integer('preis_aktion_cent'),
    gueltigAb: timestamp('gueltig_ab', { withTimezone: true }),
    steuersatz: numeric('steuersatz'),
    gewicht: numeric('gewicht'),
    ersatzMatchcode: text('ersatz_matchcode'),
    deaktiviert: boolean('deaktiviert').notNull().default(false),
    deaktiviertAm: timestamp('deaktiviert_am', { withTimezone: true }),
    deaktiviertGrund: text('deaktiviert_grund'),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull().defaultNow(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('hersteller_artikel_lieferant_matchcode_idx').on(t.lieferantId, t.matchcode),
    index('hersteller_artikel_lieferant_idx').on(t.lieferantId),
    index('hersteller_artikel_ean_idx').on(t.ean),
    index('hersteller_artikel_titel_idx').on(sql`LOWER(${t.titel})`),
    index('hersteller_artikel_geaendert_am_idx').on(t.geaendertAm),
  ],
)

/**
 * Hochgeladene DATANORM-Originaldatei. `(lieferant_id, datei_hash)` ist
 * unique — derselbe Upload zweimal wird erkannt und nicht erneut geparst.
 * `pfad` ist relativ zu `DATANORM_DIR`, damit ein Restore in eine andere
 * Installation gueltig bleibt. Der Cleanup-Cron loescht aeltere Eintraege,
 * behaelt aber immer den juengsten pro Lieferant.
 */
export const datanormDateien = pgTable(
  'datanorm_dateien',
  {
    id: text('id').primaryKey(),
    lieferantId: text('lieferant_id')
      .notNull()
      .references(() => lieferanten.id, { onDelete: 'cascade' }),
    pfad: text('pfad').notNull(),
    originalName: text('original_name').notNull(),
    byteGroesse: bigint('byte_groesse', { mode: 'number' }).notNull(),
    dateiHash: text('datei_hash').notNull(),
    encoding: text('encoding'),
    versionErkannt: integer('version_erkannt'),
    /**
     * Version of the parser that produced the imported rows. A file that
     * was imported with an older parser is not a duplicate of the same
     * file today — otherwise a corrected import would be skipped and the
     * broken rows would stay.
     */
    parserVersion: integer('parser_version').notNull().default(1),
    abgelegtAm: timestamp('abgelegt_am', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('datanorm_dateien_lieferant_hash_idx').on(t.lieferantId, t.dateiHash),
    unique('datanorm_dateien_pfad_idx').on(t.pfad),
    index('datanorm_dateien_abgelegt_am_idx').on(t.abgelegtAm),
  ],
)

/**
 * Import-Report: append-only Audit-Spur, ein Eintrag je Upload-Versuch
 * (auch bei Fehlern). Wird NIE aufgeraeumt — im Gegensatz zu den Dateien
 * in `datanorm_dateien`, die der Retention-Cron nach
 * DATANORM_CLEANUP_TAGE entfernt (juengster pro Lieferant bleibt).
 *
 * `fehler_details` (JSONB-Array) ist auf 100 Eintraege gecapped; die
 * Zaehler oben sind vollstaendig.
 */
export const datanormImporte = pgTable(
  'datanorm_importe',
  {
    id: text('id').primaryKey(),
    lieferantId: text('lieferant_id')
      .notNull()
      .references(() => lieferanten.id, { onDelete: 'cascade' }),
    dateiId: text('datei_id').references(() => datanormDateien.id, { onDelete: 'set null' }),
    originalDateiname: text('original_dateiname').notNull(),
    status: text('status', { enum: ['gestartet', 'erfolg', 'teilfehler', 'fehler'] })
      .notNull()
      .default('gestartet'),
    encoding: text('encoding'),
    versionErkannt: integer('version_erkannt'),
    artikelAnzahl: integer('artikel_anzahl').notNull().default(0),
    artikelNeu: integer('artikel_neu').notNull().default(0),
    artikelAktualisiert: integer('artikel_aktualisiert').notNull().default(0),
    artikelDeaktiviert: integer('artikel_deaktiviert').notNull().default(0),
    uebersprungen: integer('uebersprungen').notNull().default(0),
    fehlerAnzahl: integer('fehler_anzahl').notNull().default(0),
    fehlerDetails: jsonb('fehler_details').notNull().default([]),
    metadaten: jsonb('metadaten').notNull().default({}),
    benutzerId: text('benutzer_id').references(() => users.id, { onDelete: 'set null' }),
    gestartetAm: timestamp('gestartet_am', { withTimezone: true }).notNull().defaultNow(),
    beendetAm: timestamp('beendet_am', { withTimezone: true }),
  },
  (t) => [
    index('datanorm_importe_gestartet_am_idx').on(t.gestartetAm),
    index('datanorm_importe_lieferant_idx').on(t.lieferantId),
    index('datanorm_importe_status_idx').on(t.status),
  ],
)