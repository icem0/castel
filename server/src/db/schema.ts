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
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'

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
    mindestbestand: integer('mindestbestand'),
    nachbestellHinweis: text('nachbestell_hinweis', {
      enum: ['i.O', 'bald', 'dringend'],
    }),
    bestellnummer: text('bestellnummer'),
    /** Strichcode (EAN/Code128/QR) — semantisch getrennt von `bestellnummer`
     *  (Lieferanten-Bestellnr. vs. Strichcode am Artikel). */
    barcode: text('barcode'),
    listenpreis: integer('listenpreis'), // in Cent, um Floats zu vermeiden
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('artikel_sharepoint_idx').on(t.sharePointId),
    index('artikel_typ_idx').on(t.typ),
    index('artikel_status_idx').on(t.status),
    index('artikel_barcode_idx').on(t.barcode),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('artikel_geaendert_am_idx').on(t.geaendertAm),
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
  'projekte',
  {
    id: text('id').primaryKey(),
    nummer: text('nummer').notNull(),
    name: text('name'),
    archiviert: boolean('archiviert').notNull().default(false),
    geaendertAm: timestamp('geaendert_am', { withTimezone: true }).notNull(),
    erstelltAm: timestamp('erstellt_am', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('projekte_nummer_idx').on(t.nummer),
    index('projekte_archiviert_idx').on(t.archiviert),
    // Sync-Snapshot filtert auf `geaendert_am > since` — Index ist Pflicht.
    index('projekte_geaendert_am_idx').on(t.geaendertAm),
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
      enum: ['artikel', 'standort', 'buchung', 'projekt', 'foto', 'user', 'einstellung'],
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
 * Primary Key (key, user_id) — jede Variante ist eindeutig.
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
    primaryKey({ columns: [t.key, t.userId] }),
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