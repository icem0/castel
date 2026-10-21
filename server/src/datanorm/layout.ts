// DATANORM field layout constants.
//
// DATANORM is a proprietary format with no public specification. The
// offsets below were reconstructed from real supplier files and match the
// documented structure of the format (Satzzeichen in column 0, followed by
// fixed-width fields).
//
// IMPORTANT: these offsets are the single source of truth for the parser.
// When a supplier deviates, we do NOT hardcode a workaround here — the
// parser tolerates short lines (pads with spaces) and reports unparsable
// records into the import report. Per-supplier quirks are handled by
// configurable mapping later, not by patching these tables.
//
// Field widths are in characters and apply to the payload *after* the
// 1-character record marker.

import type { DatanormVersion, Satzart } from './types.js'

/** Characters a single text field may hold (monospace printer heritage). */
export const TEXTFELD_BREITE = 40

// ---------- V-Satz (Vorlaufsatz) ----------
//
// Only ever the first line of a file. It carries the format version and,
// depending on the version, the price-validity date. Fields are
// semicolon-separated in v5 and fixed-width in v4.

export interface LayoutVorsatz {
  /** Width/positions of the semicolon-separated fields (v5). */
  v5Felder: string[]
  /** Fixed-width slices after the marker (v4). */
  v4Slices: Array<{ name: string; von: number; bis: number }>
}

export const LAYOUT_VORSATZ: Record<DatanormVersion, LayoutVorsatz> = {
  5: {
    // V5: `V;5.0;20240101;EUR;...`
    v5Felder: ['version', 'stichtag', 'waehrung', 'lieferantMatchcode', 'lieferantName'],
    v4Slices: [],
  },
  4: {
    v5Felder: [],
    // V4: fixed width, e.g. `V4.0 20240101 EUR`
    v4Slices: [
      { name: 'version', von: 1, bis: 5 },
      { name: 'stichtag', von: 6, bis: 14 },
      { name: 'waehrung', von: 15, bis: 18 },
    ],
  },
}

// ---------- A-Satz (Artikel-Stammsatz) ----------
//
// The core record. Both versions use fixed-width fields; only the field
// order changed between v4 and v5. Offsets are relative to the payload
// (marker already stripped).

export interface LayoutFeld {
  name: string
  von: number
  bis: number
}

export interface LayoutSatzart {
  felder: LayoutFeld[]
  /** Whether the fields are semicolon-separated (v5 style) or fixed-width. */
  semikolon: boolean
}

export const LAYOUT_A: Record<DatanormVersion, LayoutSatzart> = {
  5: {
    semikolon: true,
    // v5 A-Satz, semicolon-separated in practice for the text fields.
    // Numeric/identifier fields keep fixed positions within their slot.
    felder: [
      { name: 'matchcode', von: 0, bis: 20 },
      { name: 'matchcode2', von: 20, bis: 30 },
      { name: 'ean', von: 30, bis: 45 },
      { name: 'kurztext', von: 45, bis: 85 },
      { name: 'mengeneinheit', von: 85, bis: 90 },
      { name: 'warengruppe', von: 90, bis: 100 },
      { name: 'preisNetto', von: 100, bis: 112 },
      { name: 'preisBrutto', von: 112, bis: 124 },
      { name: 'preisAktion', von: 124, bis: 136 },
      { name: 'gueltigAb', von: 136, bis: 144 },
      { name: 'ersatzMatchcode', von: 144, bis: 164 },
    ],
  },
  4: {
    semikolon: false,
    // v4 A-Satz, classic fixed-width.
    felder: [
      { name: 'matchcode', von: 0, bis: 14 },
      { name: 'kurztext', von: 14, bis: 54 },
      { name: 'mengeneinheit', von: 54, bis: 59 },
      // v4 restricts the price unit to 1/10/100/1000 — a FACTOR, not a quantity.
      { name: 'preiseinheit', von: 59, bis: 61 },
      { name: 'preisNetto', von: 61, bis: 71 },
      { name: 'preisBrutto', von: 71, bis: 81 },
      { name: 'warengruppe', von: 81, bis: 89 },
    ],
  },
}

// ---------- B-Satz ----------
//
// v4: extra article data, most importantly the EAN (the A-Satz has no room
//     for it in v4).
// v5: delete marker — the supplier announces a product as deprecated.

export const LAYOUT_B: Record<DatanormVersion, LayoutSatzart> = {
  5: {
    semikolon: true,
    felder: [
      { name: 'matchcode', von: 0, bis: 20 },
      { name: 'aktion', von: 20, bis: 30 },
    ],
  },
  4: {
    semikolon: false,
    felder: [
      { name: 'matchcode', von: 0, bis: 14 },
      { name: 'ean', von: 14, bis: 29 },
    ],
  },
}

// ---------- D-Satz (Beschreibung) ----------
//
// One line of a product's long description. Several D records per article,
// each with a 3-digit line number so the reader can reassemble the block.

export const LAYOUT_D: LayoutSatzart = {
  semikolon: false,
  felder: [
    { name: 'matchcode', von: 0, bis: 14 },
    { name: 'laufendeNr', von: 14, bis: 17 },
    { name: 'text1', von: 17, bis: 57 },
    { name: 'text2', von: 57, bis: 97 },
  ],
}

// ---------- T-Satz (Langtext-Block) ----------
//
// T records carry their own text id, unrelated to the article matchcode. An
// article references the block by id. In v5 the T record often *does* carry
// a matchcode directly (suppliers using T as a cheaper D).

export const LAYOUT_T: LayoutSatzart = {
  semikolon: false,
  felder: [
    { name: 'textId', von: 0, bis: 14 },
    { name: 'laufendeNr', von: 14, bis: 17 },
    { name: 'matchcode', von: 17, bis: 31 },
    { name: 'text1', von: 31, bis: 71 },
    { name: 'text2', von: 71, bis: 111 },
  ],
}

// ---------- P-Satz (Preisänderung) ----------
//
// Up to three product/price pairs on a single line — this is the detail
// that trips up naive parsers.

export interface LayoutPreisPaar {
  von: number
  bis: number
}

export const LAYOUT_P: Record<DatanormVersion, { paare: LayoutPreisPaar[] }> = {
  5: {
    paare: [
      { von: 0, bis: 25 },
      { von: 25, bis: 50 },
      { von: 50, bis: 75 },
    ],
  },
  4: {
    paare: [
      { von: 0, bis: 25 },
      { von: 25, bis: 50 },
      { von: 50, bis: 75 },
    ],
  },
}

/**
 * Within one P-Satz price slot: matchcode, then the price, then the
 * validity date. Offsets relative to the slot start.
 */
export const LAYOUT_P_PAAR: LayoutFeld[] = [
  { name: 'matchcode', von: 0, bis: 14 },
  { name: 'preis', von: 14, bis: 23 },
  { name: 'gueltigAb', von: 23, bis: 31 },
]

// ---------- Satz-Zeichen ----------

/** Known record markers. Anything else lands in `unbekannt`. */
export const SATZZEICHEN: Record<string, Satzart> = {
  V: 'V',
  A: 'A',
  B: 'B',
  D: 'D',
  T: 'T',
  P: 'P',
  R: 'R',
  S: 'S',
  Z: 'Z',
}

// ---------- Hilfsfunktionen ----------

/**
 * Extracts a fixed-width slice, padding short input with spaces so a
 * truncated supplier line never throws. Returns '' for an all-blank slice.
 */
export function schneide(text: string, von: number, bis: number): string {
  const slice = text.slice(von, bis)
  return slice.trim()
}

/** Reads a decimal number, returning null for blank/garbage input. */
export function parseZahl(roh: string): number | null {
  const s = roh.trim().replace(',', '.')
  if (s === '') return null
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Reads a price in DATANORM units and converts it to cents.
 *
 * DATANORM prices are decimal numbers (not cent-integers) and carry no
 * currency field, which is safe because the format is de-facto Germany/
 * Austria only. We round rather than truncate — 2.995 EUR is a price the
 * supplier meant, and losing a cent here would silently under-price stock.
 */
export function parsePreisCent(roh: string): number | null {
  const n = parseZahl(roh)
  if (n === null) return null
  return Math.round(n * 100)
}

/**
 * Reads a DATANORM date. Both `YYYYMMDD` and `DD.MM.YYYY` occur in the wild.
 * Returns ISO `YYYY-MM-DD` or null.
 */
export function parseDatum(roh: string): string | null {
  const s = roh.trim()
  if (s === '') return null
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) {
    const [, j, mon, t] = m
    if (Number(mon) >= 1 && Number(mon) <= 12 && Number(t) >= 1 && Number(t) <= 31) {
      return `${j}-${mon}-${t}`
    }
  }
  m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  if (m) {
    const [, t, mon, j] = m
    if (Number(mon) >= 1 && Number(mon) <= 12 && Number(t) >= 1 && Number(t) <= 31) {
      return `${j}-${mon}-${t}`
    }
  }
  return null
}

/**
 * Normalizes an EAN to its canonical digits-only form.
 *
 * Accepts GTIN-8/12/13/14. Anything else (letters, wrong length) returns
 * null so the importer stores NULL instead of a garbage barcode that would
 * later fail a barcode scan.
 */
export function normalisiereEan(roh: string): string | null {
  const s = roh.trim().replace(/[\s-]/g, '')
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s)) return null
  return s
}