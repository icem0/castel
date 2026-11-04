// Rollen und Berechtigungen — Datenbank-basiert.
//
// Rollen und ihre Berechtigungen liegen in den Tabellen `rollen` und
// `rollen_berechtigungen` (Migration 0030). Dieses Modul lädt die Matrix
// aus der DB und stellt Prüf-Hilfen bereit.
//
// `admin` ist exklusiv und hat immer alle Berechtigungen (Short-Circuit).
// Die Rolle-IDs sind freie Strings (Slug, z. B. 'lagerist'); `user` ist die
// implizite Basis und wird beim Normalisieren ergänzt.

import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { rollen, rollenBerechtigungen } from '../db/schema.js'
import { ValidationError } from '../domain/errors.js'
export type Rolle = string
export type Permission = string

export interface RolleMitBerechtigungen {
  id: Rolle
  name: string
  beschreibung: string
  aktiv: boolean
  erstelltAm: Date
  berechtigungen: Permission[]
}

// ---------- Bekannte Rollen / Berechtigungen (Seed-Standard, Migration 0030) ----------
//
// Diese Konstanten spiegeln den initialen Seed wider und dienen als
// Referenz (z. B. für Drift-Tests). Zusätzliche, über das UI angelegte
// Rollen leben nur in der DB und sind hier nicht aufgeführt.

export const KNOWN_ROLLEN: readonly Rolle[] = ['user', 'lagerist', 'admin']

export const KNOWN_PERMISSIONS: readonly Permission[] = [
  'artikel.lesen',
  'artikel.schreiben',
  'artikel.loeschen',
  'standort.lesen',
  'standort.schreiben',
  'standort.loeschen',
  'mindestbestand.lesen',
  'mindestbestand.schreiben',
  'buchung.erstellen',
  'buchung.storno',
  'kommission.beitragen',
  'etikett.drucken',
  'geraet.lokal',
  'katalog.lesen',
  'einkaufspreis',
  'stammdaten.verwalten',
  'akkutausch.verwalten',
  'globalEinstellung',
  'benutzer.verwalten',
  'backup.verwalten',
  'import.fuehren',
  'apiKey.verwalten',
  'entwicklung',
  'inventur.stichtag',
  'inventur.lesen',
  'inventur.erstellen',
  'inventur.abschliessen',
  'inventur.export',
]

/**
 * Standard-Rollen-Matrix als Fallback, wenn die DB nicht verfugbar ist
 * (z. B. in Tests mit Mock-DBs). Entspricht dem Seed in Migration 0030.
 */
export const DEFAULT_ROLLEN_MATRIX: Record<Rolle, RolleMitBerechtigungen> = {
  user: {
    id: 'user',
    name: 'User',
    beschreibung: 'Basiszugriff: lesen, buchen, stornieren.',
    aktiv: true,
    erstelltAm: new Date('2026-01-01T00:00:00Z'),
    berechtigungen: [
      'artikel.lesen', 'standort.lesen', 'mindestbestand.lesen', 'katalog.lesen',
      'buchung.erstellen', 'buchung.storno', 'kommission.beitragen',
      'etikett.drucken', 'geraet.lokal',
    ],
  },
  lagerist: {
    id: 'lagerist',
    name: 'Lagerist',
    beschreibung: 'Zusatzlich zu User: Artikel und Standorte pflegen, Mindestbestand setzen.',
    aktiv: true,
    erstelltAm: new Date('2026-01-01T00:00:00Z'),
    berechtigungen: [
      'artikel.lesen', 'standort.lesen', 'mindestbestand.lesen', 'katalog.lesen',
      'buchung.erstellen', 'buchung.storno', 'kommission.beitragen',
      'etikett.drucken', 'geraet.lokal',
      'artikel.schreiben', 'artikel.loeschen', 'standort.schreiben', 'mindestbestand.schreiben',
      'inventur.stichtag',
      'inventur.lesen',
      'inventur.erstellen',
      'inventur.abschliessen',
      'inventur.export',
    ],
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    beschreibung: 'Voller Zugriff auf alle Berechtigungen.',
    aktiv: true,
    erstelltAm: new Date('2026-01-01T00:00:00Z'),
    berechtigungen: [...KNOWN_PERMISSIONS],
  },
}

/**
 * Beschreibungen der bekannten Berechtigungen (UI-Text, deutsch).
 * Wird von /api/rollen ausgeliefert, damit die Client-Legende sie anzeigen kann.
 */
export interface BerechtigungInfo {
  titel: string
  beschreibung: string
}

export const BERECHTIGUNG_INFO: Record<Permission, BerechtigungInfo> = {
  'artikel.lesen': { titel: 'Artikel lesen', beschreibung: 'Artikelstammdaten ansehen.' },
  'artikel.schreiben': {
    titel: 'Artikel schreiben',
    beschreibung: 'Artikel anlegen und bearbeiten — ohne Einkaufspreis.',
  },
  'artikel.loeschen': {
    titel: 'Artikel loeschen',
    beschreibung: 'Artikel endgueltig loeschen (mit Buchungen nur per Storno moeglich).',
  },
  'standort.lesen': { titel: 'Standorte lesen', beschreibung: 'Lager und Standorte ansehen.' },
  'standort.schreiben': {
    titel: 'Standorte schreiben',
    beschreibung: 'Standorte anlegen, umbenennen und archivieren.',
  },
  'standort.loeschen': {
    titel: 'Standorte loeschen',
    beschreibung: 'Standorte endgueltig loeschen.',
  },
  'mindestbestand.lesen': {
    titel: 'Mindestbestand lesen',
    beschreibung: 'Mindestbestand-Panel und Alarm beobachten.',
  },
  'mindestbestand.schreiben': {
    titel: 'Mindestbestand schreiben',
    beschreibung: 'Mindestbestand je Artikel und Standort setzen.',
  },
  'buchung.erstellen': { titel: 'Buchen', beschreibung: 'Bestaende buchen (Ein-/Auslagerung, Umlagerung, Inventur).' },
  'buchung.storno': { titel: 'Stornieren', beschreibung: 'Buchungen stornieren.' },
  'kommission.beitragen': {
    titel: 'Kommissionen beitragen',
    beschreibung: 'Neue Kommissionen zur globalen Liste beitragen.',
  },
  'etikett.drucken': { titel: 'Etiketten drucken', beschreibung: 'Etiketten und Barcodes erzeugen.' },
  'katalog.lesen': { titel: 'Kataloge lesen', beschreibung: 'Artikel-Kataloge und Lieferantenlisten ansehen.' },
  'geraet.lokal': {
    titel: 'Lokaler Speicher',
    beschreibung: 'Einstellungen und den lokalen Geraetespeicher verwalten.',
  },
  'einkaufspreis': {
    titel: 'Einkaufspreis',
    beschreibung: 'Vertrauliche Einkaufspreise und Lieferantenrabatte sehen und pflegen.',
  },
  'stammdaten.verwalten': {
    titel: 'Stammdaten verwalten',
    beschreibung: 'Hersteller, Artikel-/Akku-Typen und die Kommissionen-Liste pflegen.',
  },
  'akkutausch.verwalten': {
    titel: 'Akkutausch verwalten',
    beschreibung: 'Netzteile, Projektakkus, Puffer und Bestellungen des Akkutausches pflegen.',
  },
  'globalEinstellung': {
    titel: 'Globale Einstellungen',
    beschreibung: 'Standard-Standort, Firmenname, Barcode-Format und Typenlisten pflegen.',
  },
  'benutzer.verwalten': {
    titel: 'Benutzer verwalten',
    beschreibung: 'Benutzer anlegen, Rollen und Passwoerter pflegen.',
  },
  'backup.verwalten': { titel: 'Backup', beschreibung: 'Backups erstellen und wiederherstellen.' },
  'import.fuehren': { titel: 'CSV-Import', beschreibung: 'CSV-Import ausfuehren.' },
  'apiKey.verwalten': { titel: 'API-Keys', beschreibung: 'API-Keys fuer die Agenten-API verwalten.' },
  'entwicklung': {
    titel: 'Entwicklung',
    beschreibung: 'Entwicklermenue, Geraete-Reset und Buchungs-Bulk-Delete.',
  },
  'inventur.stichtag': {
    titel: 'Inventur-Stichtag',
    beschreibung: 'Inventur-Stichtag und Erinnerungs-Vorlauf in den Einstellungen setzen.',
  },
  'inventur.lesen': {
    titel: 'Inventur lesen',
    beschreibung: 'Inventur-Stand, Liste „Artikel ohne Inventur" und Archiv einsehen.',
  },
  'inventur.erstellen': {
    titel: 'Inventur erstellen',
    beschreibung: 'Inventur-Buchung anlegen und „Inventurwert setzen" für Restbestände.',
  },
  'inventur.abschliessen': {
    titel: 'Inventur abschließen',
    beschreibung: 'Stichtag abschließen und Bestands-Snapshot für die Buchhaltung einfrieren.',
  },
  'inventur.export': {
    titel: 'Inventur exportieren',
    beschreibung: 'PDF/CSV für die Buchhaltung erzeugen (Preisspalten benötigen zusätzlich Einkaufspreis).',
  },
}

/**
 * Lädt die vollständige Rollen-Berechtigungs-Matrix aus der DB.
 * Gibt eine Map von Rolle → RolleMitBerechtigungen zurück.
 */
export async function ladeRollenMatrix(
  db: ReturnType<typeof getDb>,
): Promise<Record<Rolle, RolleMitBerechtigungen>> {
  const rolleRows = await db
    .select({
      id: rollen.id,
      name: rollen.name,
      beschreibung: rollen.beschreibung,
      aktiv: rollen.aktiv,
      erstelltAm: rollen.erstelltAm,
    })
    .from(rollen)
    .where(eq(rollen.aktiv, true))

  const permRows = await db
    .select({
      rolleId: rollenBerechtigungen.rolleId,
      berechtigung: rollenBerechtigungen.berechtigung,
    })
    .from(rollenBerechtigungen)

  const matrix: Record<Rolle, RolleMitBerechtigungen> = {}
  for (const r of rolleRows) {
    matrix[r.id] = {
      id: r.id,
      name: r.name,
      beschreibung: r.beschreibung,
      aktiv: r.aktiv,
      erstelltAm: r.erstelltAm,
      berechtigungen: [],
    }
  }
  for (const p of permRows) {
    const rolle = matrix[p.rolleId]
    if (rolle) rolle.berechtigungen.push(p.berechtigung)
  }
  return matrix
}

/** Prüft, ob ein unbekannter String eine guültige Rolle ist (prüft nicht gegen DB). */
export function istRolle(value: unknown): value is Rolle {
  return typeof value === 'string' && value.length > 0
}

/** Prüft, ob ein unbekannter String eine guültige Berechtigung ist. */
export function istBerechtigung(value: unknown): value is Permission {
  return typeof value === 'string' && value.length > 0
}

/**
 * Normalisiert beliebige Eingaben zu einem guültigen Rollen-Array.
 *
 * - `admin` ist exklusiv: sobald admin dabei ist, ist das Ergebnis `['admin']`.
 * - `user` ist die Basis und wird immer ergänzt (ausser bei admin).
 * - Ein leeres Ergebnis bedeutet `['user']`.
 *
 * Akzeptiert auch den Legacy-Einzelwert (`'admin'` / `'user'`).
 *
 * Hinweis: hier findet keine DB-Validierung statt (kein DB-Zugriff in dieser
 * Funktion). Ob eine Rolle in der DB existiert, wird aufrufend geprüft.
 */
export function normalisiereRollen(input: unknown): Rolle[] {
  const rohen: string[] = Array.isArray(input)
    ? input.filter((r): r is string => typeof r === 'string')
    : typeof input === 'string'
      ? [input]
      : []

  const bekannt = rohen.filter(istRolle)
  if (bekannt.includes('admin')) return ['admin']

  const set = new Set<Rolle>(bekannt)
  set.add('user')
  return [...set]
}

/** true, wenn der User Admin-Rechte hat. */
export function istAdmin(rollen: readonly Rolle[] | undefined | null): boolean {
  return !!rollen && rollen.includes('admin')
}

/**
 * Die vereinigten Berechtigungen aller übergebenen Rollen gemäß Matrix.
 * `admin` liefert immer alle bekannten Berechtigungen.
 */
export async function berechtigungenFuer(
  rollen: readonly Rolle[] | undefined | null,
): Promise<Permission[]> {
  if (!rollen || rollen.length === 0) return []
  const matrix = await ladeRollenMatrix(getDb()).catch(() => DEFAULT_ROLLEN_MATRIX)
  if (istAdmin(rollen)) {
    const all = new Set<Permission>()
    for (const r of Object.values(matrix)) for (const p of r.berechtigungen) all.add(p)
    return [...all]
  }
  const set = new Set<Permission>()
  for (const rolle of rollen) {
    for (const p of matrix[rolle]?.berechtigungen ?? []) set.add(p)
  }
  return [...set]
}

/** true, wenn die Rolle (bzw. der Rollen-Stack) die Berechtigung hat. */
export async function hatBerechtigung(
  rollen: readonly Rolle[] | undefined | null,
  berechtigung: Permission,
  matrix?: Record<Rolle, RolleMitBerechtigungen>,
): Promise<boolean> {
  if (istAdmin(rollen)) return true
  if (!rollen) return false
  const m = matrix ?? (await ladeRollenMatrix(getDb()).catch(() => DEFAULT_ROLLEN_MATRIX))
  return rollen.some((rolle) => m[rolle]?.berechtigungen.includes(berechtigung) ?? false)
}

/**
 * Wirft einen ValidationError, wenn die Berechtigung fehlt. Der Fehler
 * wird pro Op gemeldet (der Batch lauft weiter).
 */
export async function pruefeBerechtigung(
  rollen: readonly Rolle[] | undefined | null,
  berechtigung: Permission,
  kontext: string,
  matrix?: Record<Rolle, RolleMitBerechtigungen>,
): Promise<void> {
  const erlaubt = await hatBerechtigung(rollen, berechtigung, matrix)
  if (!erlaubt) {
    throw new ValidationError(
      'entity',
      `${kontext} erfordert die Berechtigung "${berechtigung}"`,
    )
  }
}

/**
 * Prueft, ob der User Akkutausch-Daten aendern darf (Admin-only).
 */
export async function pruefeAkkutauschRolle(
  rollen: readonly Rolle[] | undefined | null,
  matrix?: Record<Rolle, RolleMitBerechtigungen>,
): Promise<void> {
  await pruefeBerechtigung(rollen, 'akkutausch.verwalten', 'Akkutausch-Daten aendern', matrix)
}

/**
 * Der Legacy-Wert für die alte `users.rolle`-Spalte: `admin` oder `user`.
 * Wird dual geschrieben, damit ältere Server-Container während eines
 * Rollouts die Admin-Rolle weiterhin erkennen.
 */
export function legacyRolle(rollen: readonly Rolle[]): 'admin' | 'user' {
  return istAdmin(rollen) ? 'admin' : 'user'
}
