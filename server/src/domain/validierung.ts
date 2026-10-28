// Gemeinsame Validierungs- und Transformations-Helfer für eingehende
// API-Payloads. Wir nutzen zod-Schemas, damit Frontend (PWA) und Backend
// sich an dieselben Verträge halten können.

import { z } from 'zod'

// ---------- ISO-Datumsformat ----------
// Server akzeptiert ISO-8601 UTC, normalisiert aber beim Schreiben in TIMESTAMPTZ.

const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'muss ISO-8601-Datum sein',
})

// ---------- Zukunfts-Daten (Client/Server-Clock-Drift-tolerant) ----------
// Buchungen mit Zukunfts-Datum sind ein klassischer Eingabefehler — wir
// lehnen sie ab, sobald der Wert > jetzt + 1 Minute ist.

const isoKeineZukunft = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'muss ISO-8601-Datum sein' })
  .refine((s) => Date.parse(s) - 60_000 <= Date.now(), {
    message: 'Datum liegt in der Zukunft',
  })

// ---------- IDs ----------

const id = z.string().min(1, 'ID erforderlich')

// ---------- Stammdaten ----------

export const artikelSchema = z.object({
  id,
  sharePointId: z.number().int().nullable().optional(),
  titel: z.string().min(1),
  status: z.enum(['verfuegbar', 'reserviert', 'gesperrt', 'ausgesondert', 'archiviert']),
  typ: z.string(),
  lieferant: z.string().nullable().optional(),
  verpackungseinheit: z.number().int().positive(),
  mindestbestand: z.number().int().nullable().optional(),
  nachbestellHinweis: z.enum(['i.O', 'bald', 'dringend']).nullable().optional(),
  bestellnummer: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  etikettenNeu: z.boolean().optional(),
  listenpreis: z.number().int().nullable().optional(),
  /** Netto-Einkaufspreis je Verpackungseinheit, in Cent. */
  einkaufspreis: z.number().int().nullable().optional(),
  /** Referenz auf die Hersteller-Stammdaten (Bestellkontakt). */
  herstellerId: z.string().nullable().optional(),
  /** Bestellzustand des Mindestbestandsalarms. */
  bestellstatus: z.enum(['offen', 'bestellt']).optional(),
  bestelltAm: iso.nullable().optional(),
  bestelltVon: z.string().nullable().optional(),
  geaendertAm: iso,
  erstelltAm: iso,
})

export const herstellerSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  bestellEmail: z.string().nullable().optional(),
  bestellWebseite: z.string().nullable().optional(),
  /**
   * Durchschnittsrabatt des Lieferanten in Prozent (0 = kein Rabatt
   * bekannt). Nur Admins duerfen ihn schreiben (siehe sync/resolver.ts).
   */
  rabattsatz: z.number().min(0).max(100).optional(),
  geaendertAm: iso,
  erstelltAm: iso,
})

/**
 * Mindestbestand je (Artikel, Standort). Identitaet ist das Paar — es gibt
 * keine eigene UUID. `mindestbestand <= 0` bedeutet "kein Alarm".
 */
export const artikelStandortMindestbestandSchema = z.object({
  artikelId: id,
  standortId: id,
  mindestbestand: z.number().int(),
  geaendertAm: iso,
  erstelltAm: iso,
})

export const standortSchema = z.object({
  id,
  name: z.string().min(1),
  typ: z.enum(['lager', 'auto', 'baustelle', 'extern']),
  projekt: z.string().nullable().optional(),
  kennzeichen: z.string().nullable().optional(),
  standard: z.boolean(),
  archiviert: z.boolean(),
  geaendertAm: iso,
  erstelltAm: iso,
})

export const projektSchema = z.object({
  id,
  nummer: z.string().min(1),
  name: z.string().nullable().optional(),
  archiviert: z.boolean(),
  geaendertAm: iso,
  erstelltAm: iso,
})

export const buchungSchema = z.object({
  id,
  artikelId: id,
  standortId: id,
  standortZielId: id.nullable().optional(),
  typ: z.enum(['einlagerung', 'entnahme', 'umlagerung', 'inventur', 'kommission', 'storno']),
  menge: z.number().int(),
  paarId: z.string().nullable().optional(),
  projekt: z.string().nullable().optional(),
  erstelltAm: isoKeineZukunft,
  clientEingabeAm: iso.nullable().optional(),
  erstelltVon: id,
  kommentar: z.string().nullable().optional(),
  mitteilungAn: z.string().nullable().optional(),
  stornoVon: z.string().nullable().optional(),
  storno: z.boolean(),
  storniertDurch: z.string().nullable().optional(),
})

// ---------- Akkutausch ----------

/** Kalenderdatum `YYYY-MM-DD` (ohne Zeit und Zeitzone). */
const isoDatum = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'muss YYYY-MM-DD sein')

/**
 * Eingebautes Geraet, dessen Akku in einem festen Intervall getauscht wird.
 *
 * Die Akku-Daten (Einbaudatum, Intervall, Kapazitaet, Anzahl) duerfen `null`
 * sein: Geraete aus CSV-Importen sind oft noch unvollstaendig und werden
 * spaeter in der PWA ergaenzt (Migration 0023).
 */
export const akkuNetzteilSchema = z.object({
  id,
  anlage: z.string().min(1),
  objekt: z.string().min(1),
  name: z.string().min(1),
  einbaudatum: isoDatum.nullable(),
  intervallJahre: z.number().int().positive().nullable(),
  kapazitaetAh: z.number().positive().nullable(),
  anzahl: z.number().int().positive().nullable(),
  gruppe: z.string().nullable().optional(),
  plz: z.string().nullable().optional(),
  vdsAnerkennung: z.string().nullable().optional(),
  bemerkung: z.string().nullable().optional(),
  /** Soft-Delete: die Zeile bleibt als Tombstone erhalten. */
  geloescht: z.boolean(),
  geaendertAm: iso,
  erstelltAm: iso,
})

/** Projektbatterie fuer ein Quartal. */
export const akkuProjektSchema = z.object({
  id,
  projekt: z.string().min(1),
  menge: z.number().int().positive(),
  artAh: z.number().positive(),
  quartal: z.number().int().min(1).max(4),
  jahr: z.number().int().min(2000).max(2100),
  /** Soft-Delete: die Zeile bleibt als Tombstone erhalten. */
  geloescht: z.boolean(),
  geaendertAm: iso,
  erstelltAm: iso,
})

// ---------- Einstellungen ----------
// Cross-Device-Sync: PWA-Einstellungen (sprache, standardStandortId,
// artikelTypen) werden in der DB gespiegelt. Whitelist der erlaubten
// Keys — alles andere wird vom Server abgelehnt.

export const EINSTELLUNG_KEYS = [
  'sprache',
  'theme',
  'standardStandortId',
  'artikelTypen',
  'akkuTypen',
  'akkutauschAktiv',
  'kommissionen',
  'companyName',
  'barcodeTyp',
  'onboardingSeen',
  'firstLoginDone',
  'mindestbestandSoundAn',
  'mindestbestandLautstaerke',
  'mindestbestandWiederholen',
] as const
export type EinstellungKey = (typeof EINSTELLUNG_KEYS)[number]

export const einstellungSchema = z.object({
  key: z.enum(EINSTELLUNG_KEYS),
  /** null = global (z. B. artikelTypen), sonst User-spezifisch. */
  userId: z.string().nullable(),
  value: z.string(),
  geaendertAm: iso,
})

// ---------- Sync-Push ----------

export const pushPayloadSchema = z.object({
  // Liste der Outbox-Items, die der Client hochlädt.
  // Wir nutzen ein diskriminiertes Union pro Entity-Typ.
  ops: z
    .array(
      z.discriminatedUnion('entity', [
        z.object({
          op: z.enum(['create', 'update', 'delete']),
          entity: z.literal('artikel'),
          payload: artikelSchema,
        }),
        z.object({
          op: z.enum(['create', 'update', 'delete']),
          entity: z.literal('hersteller'),
          payload: herstellerSchema,
        }),
        z.object({
          op: z.enum(['create', 'update', 'delete']),
          entity: z.literal('standort'),
          payload: standortSchema,
        }),
        z.object({
          op: z.enum(['create', 'update', 'delete']),
          entity: z.literal('artikel_standort_mindestbestand'),
          payload: artikelStandortMindestbestandSchema,
        }),
        z.object({
          op: z.enum(['create', 'update', 'delete']),
          entity: z.literal('kommission'),
          payload: projektSchema,
        }),
        z.object({
          op: z.enum(['create', 'update']),
          entity: z.literal('akku_netzteil'),
          payload: akkuNetzteilSchema,
        }),
        z.object({
          op: z.enum(['create', 'update']),
          entity: z.literal('akku_projekt'),
          payload: akkuProjektSchema,
        }),
        z.object({
          op: z.literal('create'), // Buchungen sind append-only: nur create
          entity: z.literal('buchung'),
          payload: buchungSchema,
        }),
        z.object({
          // Einstellungen: nur upsert. key+userId ist die Identität.
          op: z.literal('upsert'),
          entity: z.literal('einstellung'),
          payload: einstellungSchema,
        }),
      ]),
    )
    .max(500, 'maximal 500 ops pro Push'),
})

/** IDs lokaler Buchungen, deren Existenz der Client gegen den Server prüft. */
export const reconcileSchema = z.object({
  ids: z.array(id).min(1, 'mindestens eine ID').max(500, 'maximal 500 IDs pro Request'),
})

// ---------- Auth ----------

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben'),
  rolle: z.enum(['admin', 'user']).default('user'),
  // Optional: ohne Anzeigename wird der lokale Teil der E-Mail verwendet,
  // damit Buchungen dieses Users nie als "unbekannt" erscheinen.
  anzeigename: z.string().trim().max(120).optional(),
})

export const patchUserSchema = z.object({
  rolle: z.enum(['admin', 'user']).optional(),
  aktiv: z.boolean().optional(),
  password: z.string().min(8).optional(),
  anzeigename: z.string().trim().min(1, 'Anzeigename darf nicht leer sein').max(120).optional(),
})

/**
 * Initial-Setup: legt den allerersten User an. Darf nur aufgerufen werden,
 * solange noch kein User in der DB existiert — der Server prüft das.
 *
 * Nach erfolgreichem Anlegen wird im selben Request zusätzlich das
 * Hauptlager (Standard-Standort) und 5 Test-Artikel angelegt — siehe
 * `bootstrapHauptlager` in `auth/setup-routes.ts`.
 */
export const setupSchema = z.object({
  anzeigename: z.string().min(1, 'Anzeigename ist erforderlich').max(120),
  email: z.string().email(),
  passwort: z.string().min(8, 'Passwort muss mindestens 8 Zeichen haben'),
  sprache: z.enum(['de-DE', 'en-US']).default('de-DE'),
})

/**
 * Lokalisierter Bootstrap-Inhalt. Wird beim allerersten Setup angelegt und
 * anhand der im Setup gewählten Sprache aufgelöst.
 */
export interface BootstrapInhalt {
  hauptlagerName: string
  testArtikel: Array<{
    titel: string
    typ: string
    verpackungseinheit: number
    mindestbestand: number | null
  }>
}

export function bootstrapInhalt(locale: 'de-DE' | 'en-US'): BootstrapInhalt {
  if (locale === 'en-US') {
    return {
      hauptlagerName: 'Main Warehouse',
      testArtikel: [
        { titel: 'Sample Article 1', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
        { titel: 'Sample Article 2', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
        { titel: 'Sample Article 3', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
        { titel: 'Sample Article 4', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
        { titel: 'Sample Article 5', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
      ],
    }
  }
  return {
    hauptlagerName: 'Hauptlager',
    testArtikel: [
      { titel: 'Beispielartikel 1', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
      { titel: 'Beispielartikel 2', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
      { titel: 'Beispielartikel 3', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
      { titel: 'Beispielartikel 4', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
      { titel: 'Beispielartikel 5', typ: 'Demo', verpackungseinheit: 1, mindestbestand: 0 },
    ],
  }
}

// ---------- Snapshot-Query ----------

export const snapshotQuerySchema = z.object({
  since: iso.optional(),
  /**
   * Optionaler ISO-Timestamp: wenn gesetzt, liefert der Snapshot
   * zusätzlich alle Mindestbestand-Ereignisse mit
   * `erstellt_am > mindestSince`. Wird vom Client genutzt, um den
   * inkrementellen Stand seiner Mindestbestand-Glocke synchron zu
   * halten. Default = "seit Anbeginn der Zeit" (= alles).
   */
  mindestSince: iso.optional(),
})
