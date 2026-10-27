// Mapping and normalization helpers for device CSV imports.
//
// The CSV format is intentionally close to the device UI:
//   Anlage;Firma;PLZ;Gruppe;Name;VdS-Anerkennung;Anzahl;Kapazität;Einbaudatum;Austauschintervall;Fälligkeit

import { parseDatum, parseKapazitaet } from '../../domain/akkutausch/berechnung'
import { normalisiereName } from './netzteil-reparatur'

/**
 * Column order of the known device list export.
 *
 * Used to repair a header line where the first data row was glued to the
 * last column name.
 */
export const KANONISCHE_NETZTEIL_HEADER = [
  'Anlage',
  'Firma',
  'PLZ',
  'Gruppe',
  'Name',
  'VdS-Anerkennung',
  'Anzahl',
  'Kapazität',
  'Einbaudatum',
  'Austauschintervall',
  'Fälligkeit',
]

export type NetzteilFeld =
  | 'anlage'
  | 'objekt'
  | 'name'
  | 'einbaudatum'
  | 'intervallJahre'
  | 'kapazitaetAh'
  | 'anzahl'
  | 'gruppe'
  | 'plz'
  | 'vdsAnerkennung'
  | 'faelligkeit'

export type NetzteilMapping = Record<string, NetzteilFeld | null>

export const NETZTEIL_FELD_BESCHREIBUNG: Record<
  NetzteilFeld,
  { format: string; bedeutung: string }
> = {
  anlage: {
    format: 'Text (Pflicht, nicht leer)',
    bedeutung: 'Anlage bzw. System',
  },
  objekt: {
    format: 'Text (Pflicht, nicht leer)',
    bedeutung: 'Objekt; wird aus der CSV-Spalte "Firma" übernommen',
  },
  name: {
    format: 'Text (Pflicht, nicht leer)',
    bedeutung: 'Gerätename bzw. Position',
  },
  einbaudatum: {
    format: 'Datum: MM/JJJJ, TT.MM.JJJJ oder YYYY-MM-DD',
    bedeutung: 'Einbaudatum; MM/JJJJ wird auf den Monatsersten normalisiert',
  },
  intervallJahre: {
    format: 'Ganzzahl ≥ 1, optional mit Text wie "4 Jahre" oder "12 Monate"',
    bedeutung: 'Austauschintervall in Jahren',
  },
  kapazitaetAh: {
    format: 'Dezimalzahl > 0 (Pflicht), Komma oder Punkt',
    bedeutung: 'Akku-Kapazität in Ah',
  },
  anzahl: {
    format: 'Ganzzahl ≥ 1 (Pflicht)',
    bedeutung: 'Anzahl Akkus pro Gerät',
  },
  gruppe: {
    format: 'Text (optional)',
    bedeutung: 'Gruppe oder Kunde',
  },
  plz: {
    format: 'Text (optional)',
    bedeutung: 'Postleitzahl des Standorts',
  },
  vdsAnerkennung: {
    format: 'Text (optional)',
    bedeutung: 'VDS-Anerkennung',
  },
  faelligkeit: {
    format: 'Datum: MM/JJJJ, TT.MM.JJJJ oder YYYY-MM-DD (optional)',
    bedeutung: 'Plausibilitätsprüfung gegen Einbaudatum plus Intervall',
  },
}

export const PFLICHT_NETZTEIL_FELDER: NetzteilFeld[] = [
  'anlage',
  'objekt',
  'name',
  'einbaudatum',
  'intervallJahre',
  'kapazitaetAh',
  'anzahl',
]

/** Heuristic auto-mapping for common CSV headers. */
export function defaultNetzteilMapping(headers: string[]): NetzteilMapping {
  const map: NetzteilMapping = {}

  for (const header of headers) {
    const key = normalisiereName(header)

    if (key === 'anlage' || key === 'plant' || key === 'system') map[header] = 'anlage'
    else if (
      key === 'firma' ||
      key === 'objekt' ||
      key === 'object' ||
      key === 'liegenschaft' ||
      key === 'gebaeude' ||
      key === 'building'
    )
      map[header] = 'objekt'
    else if (key === 'name' || key === 'geraet' || key === 'device') map[header] = 'name'
    else if (
      key === 'einbaudatum' ||
      key === 'datum' ||
      key === 'installdate' ||
      key === 'installationdate'
    )
      map[header] = 'einbaudatum'
    else if (
      key === 'austauschintervall' ||
      key === 'intervall' ||
      key === 'intervalljahre' ||
      key === 'wechselintervall' ||
      key === 'replacementinterval' ||
      key === 'interval'
    )
      map[header] = 'intervallJahre'
    else if (
      key === 'kapazitaet' ||
      key === 'kapazitat' ||
      key === 'kapazitaetah' ||
      key === 'kapazitatah' ||
      key === 'capacity' ||
      key === 'ah'
    )
      map[header] = 'kapazitaetAh'
    else if (key === 'anzahl' || key === 'menge' || key === 'count' || key === 'quantity')
      map[header] = 'anzahl'
    else if (key === 'gruppe' || key === 'group') map[header] = 'gruppe'
    else if (key === 'plz' || key === 'postalcode' || key === 'zip') map[header] = 'plz'
    else if (key === 'vdsanerkennung' || key === 'vds' || key === 'anerkennung')
      map[header] = 'vdsAnerkennung'
    else if (
      key === 'faelligkeit' ||
      key === 'falligkeit' ||
      key === 'faellig' ||
      key === 'fallig' ||
      key === 'due' ||
      key === 'duedate'
    )
      map[header] = 'faelligkeit'
    else map[header] = null
  }

  return map
}

/** Stable natural key used to detect devices that already exist. */
export function netzteilSchluessel(anlage: string, objekt: string, name: string): string {
  return [anlage, objekt, name].map((value) => normalisierterSchluesselTeil(value)).join('\u0000')
}

/**
 * Deterministic UUID-shaped id for imported rows.
 *
 * Re-imports of the same CSV can therefore update the same row instead of
 * creating a duplicate. The id is not cryptographic; it is only an import
 * identity helper.
 */
export function netzteilIdFuerSchluessel(schluessel: string): string {
  const h0 = fnv1a32(schluessel, 0x811c9dc5)
  const h1 = fnv1a32(schluessel, 0xdeadbeef)
  const h2 = fnv1a32(schluessel, 0x9e3779b9)
  const h3 = fnv1a32(schluessel, 0x85ebca6b)

  const hex0 = h0.toString(16).padStart(8, '0')
  const hex1 = h1.toString(16).padStart(8, '0')
  const hex2 = h2.toString(16).padStart(8, '0')
  const hex3 = h3.toString(16).padStart(8, '0')
  const variant = (((h2 >>> 4) & 0x3) | 8).toString(16)

  return [
    hex0,
    hex1.slice(0, 4),
    `4${hex1.slice(4, 7)}`,
    `${variant}${hex2.slice(1, 4)}`,
    `${hex2.slice(4)}${hex3}`,
  ].join('-')
}

/** Parses `MM/YYYY`, `MM-YYYY`, `DD.MM.YYYY`, and `YYYY-MM-DD` into `YYYY-MM-DD`. */
export function parseNetzteilDatum(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const monthYear = /^(\d{1,2})\/(\d{4})$/.exec(trimmed)
  if (monthYear) {
    return monthToIso(Number(monthYear[2]), Number(monthYear[1]))
  }

  const isoMonth = /^(\d{4})-(\d{1,2})$/.exec(trimmed)
  if (isoMonth) {
    return monthToIso(Number(isoMonth[1]), Number(isoMonth[2]))
  }

  return parseDatum(trimmed)
}

/** Parses interval text such as `4 Jahre` or `12 Monate` into whole years. */
export function parseIntervallJahre(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed) return null

  const months = /^(\d+(?:[.,]\d+)?)\s*monat(?:e)?$/.exec(trimmed)
  if (months) {
    const wert = decimalNumber(months[1] ?? '')
    return wert === null ? null : Math.max(1, Math.round(wert / 12))
  }

  const years = /^(\d+(?:[.,]\d+)?)\s*(?:jahre?|j|year(?:s)?|y)$/.exec(trimmed)
  if (years) {
    const wert = decimalNumber(years[1] ?? '')
    return wert === null || wert < 1 ? null : Math.max(1, Math.trunc(wert))
  }

  const wert = decimalNumber(trimmed)
  if (wert === null || wert < 1) return null
  return Math.max(1, Math.trunc(wert))
}

/** Parses a positive integer, rejecting decimals because Postgres requires integer. */
export function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s/g, '')
  if (!trimmed) return null

  const n = Number(trimmed.replace(',', '.'))
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null
  return n
}

/** Parses capacity values with comma or dot as decimal separator. */
export function parseNetzteilKapazitaet(raw: string): number | null {
  return parseKapazitaet(raw)
}

/** Trims and decodes common HTML entities; optional fields become `null`. */
export function normalisierterText(raw: string): string | null {
  const trimmed = decodeHtmlEntities(raw).trim()
  if (!trimmed) return null
  if (/^[./\\|=,\-\s]+$/.test(trimmed)) return null
  return trimmed
}

/** Required text normalization: empty is invalid, punctuation stays allowed. */
export function pflichtText(raw: string): string | null {
  const trimmed = decodeHtmlEntities(raw).trim()
  return trimmed === '' ? null : trimmed
}

function normalisierterSchluesselTeil(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function decimalNumber(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.')
  if (!trimmed) return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function monthToIso(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 1 || month < 1 || month > 12) return null
  return `${pad(year, 4)}-${pad(month, 2)}-01`
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;?/g, '&')
    .replace(/&quot;?/g, '"')
    .replace(/&#39;|&apos;?/g, "'")
    .replace(/&lt;?/g, '<')
    .replace(/&gt;?/g, '>')
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}
