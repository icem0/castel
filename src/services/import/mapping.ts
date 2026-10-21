// Mapping zwischen CSV-Spaltennamen und Dexie-Feldern für den
// Artikel-Stammdaten-Import.

import type { ArtikelStatus, NachbestellHinweis } from '../../db/types'

/** CSV-Spaltenname aus der gewählten Datei. */
export type SharePointSpalte = string

/** Dexie-Feld in unserem Datenmodell. */
export type ArtikelFeld =
  | 'titel'
  | 'foto'
  | 'status'
  | 'typ'
  | 'lieferant'
  | 'verpackungseinheit'
  | 'mindestbestand'
  | 'nachbestellHinweis'
  | 'bestellnummer'
  | 'barcode'
  | 'listenpreis'
  | 'geaendertAm'
  | 'sharePointId'

/**
 * Fester Beschreibungstext pro Dexie-Feld für die Mapping-Tabelle.
 * - `format`: Erwartung an den Wert (Typ + ggf. zulässige Werte)
 * - `bedeutung`: wozu das Feld in der Domäne dient
 */
export const ARTIKEL_FELD_BESCHREIBUNG: Record<ArtikelFeld, { format: string; bedeutung: string }> =
  {
    titel: {
      format: 'Text (Pflicht, nicht leer)',
      bedeutung: 'Anzeigename des Artikels',
    },
    foto: {
      format: 'Text (Dateiname / URL — optional)',
      bedeutung: 'Foto zum Artikel',
    },
    status: {
      format: 'Enum: verfuegbar · reserviert · gesperrt · ausgesondert',
      bedeutung: 'aktueller Lebenszyklus-Status des Artikels',
    },
    typ: {
      format: 'Text (Pflicht, nicht leer)',
      bedeutung: 'Artikel-Typ / Kategorie',
    },
    lieferant: {
      format: 'Text (optional, sonst leer)',
      bedeutung: 'Name des Lieferanten',
    },
    verpackungseinheit: {
      format: 'Positive Ganzzahl (Pflicht)',
      bedeutung: 'Stückzahl pro VPE',
    },
    mindestbestand: {
      format: 'Positive Ganzzahl (optional, sonst leer)',
      bedeutung: 'Mindestbestand für Nachbestell-Warnung',
    },
    nachbestellHinweis: {
      format: 'Enum: i.O · bald · dringend (sonst leer)',
      bedeutung: 'Dringlichkeit der Wiederbeschaffung',
    },
    bestellnummer: {
      format: 'Text (optional)',
      bedeutung: 'Bestellnummer beim Lieferanten',
    },
    barcode: {
      format: 'Text (optional)',
      bedeutung: 'EAN / Barcode zum Scannen',
    },
    listenpreis: {
      format: 'Ganzzahl in Cent (optional, sonst leer)',
      bedeutung: 'Listenpreis als Ganzzahl in Cent',
    },
    geaendertAm: {
      format: 'Datum: ISO 8601 oder DD.MM.YYYY[ HH:mm] (optional)',
      bedeutung: 'Zeitpunkt der letzten Änderung',
    },
    sharePointId: {
      format: 'Ganzzahl (optional)',
      bedeutung: 'ursprüngliche SharePoint-Listen-ID',
    },
  }

/** Mapping-Tabelle: CSV-Spalte → Dexie-Feld oder null (ungenutzt). */
export type ArtikelMapping = Partial<Record<SharePointSpalte, ArtikelFeld | null>>

/** Vorschlag-Heuristik: CSV-Header → Dexie-Feld. */
export function defaultArtikelMapping(headers: string[]): ArtikelMapping {
  const map: ArtikelMapping = {}
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[^a-z0-9äöü]/gi, '')
    if (key === 'id') map[h] = 'sharePointId'
    else if (key === 'title' || key === 'titel') map[h] = 'titel'
    else if (key === 'foto') map[h] = 'foto'
    else if (key === 'status') map[h] = 'status'
    else if (key === 'type' || key === 'typ') map[h] = 'typ'
    else if (key === 'lieferant') map[h] = 'lieferant'
    else if (key === 've' || key === 'verpackungseinheit') map[h] = 'verpackungseinheit'
    else if (key === 'bestandmin' || key === 'mindestbestand') map[h] = 'mindestbestand'
    else if (key === 'nachbestellung') map[h] = 'nachbestellHinweis'
    else if (key === 'bestellnr' || key === 'bestellnummer') map[h] = 'bestellnummer'
    else if (key === 'barcode' || key === 'ean' || key === 'strichcode') map[h] = 'barcode'
    else if (key === 'listenpreis') map[h] = 'listenpreis'
    else if (
      key === 'gendert' ||
      key === 'geaendert' ||
      key === 'geaendertam' ||
      key === 'geändert'
    )
      map[h] = 'geaendertAm'
    else map[h] = null
  }
  return map
}

// Normalisierungs-Helfer für Enum-Felder.

export const ARTIKEL_STATUS_WERTE: ArtikelStatus[] = [
  'verfuegbar',
  'reserviert',
  'gesperrt',
  'ausgesondert',
]

export function normalizeArtikelStatus(raw: string): ArtikelStatus {
  const k = raw.toLowerCase().trim()
  if (k === '' || k === 'verfügbar' || k === 'verfuegbar') return 'verfuegbar'
  if (k === 'reserviert') return 'reserviert'
  if (k === 'gesperrt') return 'gesperrt'
  if (k === 'ausgesondert' || k === 'ausgemustert') return 'ausgesondert'
  // Fallback: nicht zuordbar → verfuegbar; Validierung meldet das.
  return 'verfuegbar'
}

export function normalizeNachbestellHinweis(raw: string): NachbestellHinweis {
  const k = raw.toLowerCase().trim()
  if (k === '' || k === 'i.o.' || k === 'io' || k === 'i.o') return 'i.O'
  if (k === 'bald') return 'bald'
  if (k === 'dringend') return 'dringend'
  return null
}

/**
 * ISO-Datum oder leer → ISO-String.
 * Akzeptiert zusaetzlich gaengige deutsche bzw. europaeische
 * Datums-/Zeit-Formate (`DD.MM.YYYY` oder `DD.MM.YYYY HH:mm`), weil
 * SharePoint-Listen in DE-Lokalen Spalten wie `15.02.2025` liefern,
 * die JS-`Date` nicht direkt parsen kann. Wir versuchen erst ISO,
 * dann DD.MM.YYYY (mit optionaler Uhrzeit), und fallen sonst auf
 * null zurueck.
 */
export function parseIsoDatum(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 1) Direkter ISO-Parse (YYYY-MM-DD, mit/ohne T, mit TZ).
  const direct = new Date(trimmed)
  if (!Number.isNaN(direct.getTime())) return direct.toISOString()

  // 2) DD.MM.YYYY oder DD.MM.YYYY HH:mm.
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(trimmed)
  if (de) {
    const [, dd, mm, yyyy, hh = '0', min = '0'] = de
    // Monat ist 0-basiert in JS-Date.
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }

  return null
}

/**
 * Parst Ganzzahlen (akzeptiert deutsches Komma-Format).
 * Liefert `null`, wenn der Wert leer ist, keine Zahl enthält oder Nachkomma-
 * stellen hat — das Sync-Schema (server `z.number().int()`) lehnt
 * Dezimalwerte ohnehin ab, also fail-fast hier ist ehrlicher als
 * stilles Runden.
 */
export function parseIntOrNull(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t.replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  return n
}

export function parseInt0(raw: string): number {
  const t = raw.trim()
  if (!t) return 0
  return Number.parseInt(t, 10) || 0
}
