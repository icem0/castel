// DATANORM field layout.
//
// DATANORM is a proprietary legacy format. The tables below follow the
// de-facto specification ("Technische Spezifikationen der DATANORM-Dateien",
// Haufe/Lexware), cross-checked against two independent open-source parsers
// (EulandaConnect/Convert-FromDatanorm.ps1 and the skava.io DATANORM
// viewer) and against real supplier exports.
//
// CRITICAL: DATANORM records are SEMICOLON-separated in BOTH v4 and v5 — the
// A, B, D, T and P records. Only the Vorlaufsatz (V) of v4 is a fixed-width
// 128-character record; the v5 V record is semicolon-separated again.
// An earlier version of this module assumed fixed-width columns for every
// record type. That matched no real supplier file and shredded every
// catalogue: with a v4 file "A;N;63-1211456-;01;19\"-Rack-Montagesatz…"
// the fixed-width slice produced the article number ";N;63-1211456-" and the
// title ";01;19\"-Rack-Montagesatz Front- und Rücks".
//
// Field numbers below are the INDEX of the field after splitting the record
// at ';' — i.e. field 0 is the record marker itself ("Satzkennzeichen").
// This differs from the numbering in the printed specification, which counts
// the "Stellen" of the copper-weight block of the B record as one field
// while the file carries three.

import type { DatanormVersion, Satzart } from './types.js'

/** Characters a single text field may hold (monospace printer heritage). */
export const TEXTFELD_BREITE = 40

// ---------- A-Satz (Artikel-Stammsatz) ----------

export interface A_Felder {
  /** Verarbeitungskennzeichen: N = Neu, A = Änderung, L = Löschen. */
  verarbeitung: number
  /** Artikelnummer (the matchcode of the article). */
  artikelnummer: number
  /** Textkennzeichen (2 digits) — v4 only. */
  textkennzeichen: number | null
  /** Kurztextzeile 1. */
  kurztext1: number
  /** Kurztextzeile 2 — the continuation of the short text. */
  kurztext2: number | null
  /** Mengeneinheit. */
  mengeneinheit: number
  /** Preiskennzeichen: 1 = Brutto/Listenpreis, 2 = Netto. */
  preisKennzeichen: number
  /** Preiseinheit: v4 a code, v5 the factor itself. */
  preisEinheit: number
  /** Preis in Cent (integer). */
  preis: number
  /** Hauptwarengruppe. */
  hauptwarengruppe: number
  /** Langtextschlüssel — reference to the T record's text number. */
  langtextschluessel: number | null
  /** EAN — v5 carries it in the A record, v4 in the B record. */
  ean: number | null
  /** Verpackungsmenge (pack size) — v5 only. */
  verpackungsmenge: number | null
}

export const LAYOUT_A: Record<DatanormVersion, A_Felder> = {
  4: {
    verarbeitung: 1,
    artikelnummer: 2,
    textkennzeichen: 3,
    kurztext1: 4,
    kurztext2: 5,
    mengeneinheit: 8,
    preisKennzeichen: 6,
    preisEinheit: 7,
    preis: 9,
    hauptwarengruppe: 11,
    langtextschluessel: 12,
    ean: null,
    verpackungsmenge: null,
  },
  5: {
    verarbeitung: 1,
    artikelnummer: 2,
    textkennzeichen: null,
    kurztext1: 3,
    kurztext2: 4,
    mengeneinheit: 5,
    preisKennzeichen: 6,
    preisEinheit: 7,
    preis: 8,
    hauptwarengruppe: 10,
    langtextschluessel: 11,
    ean: 18,
    verpackungsmenge: 20,
  },
}

// ---------- B-Satz ----------

export interface B_Felder {
  verarbeitung: number
  /** Artikelnummer — the article this record belongs to. */
  artikelnummer: number
  /** Matchcode (supplier-internal article number). */
  matchcode: number
  /** Alternativ-/Ersatz-Artikelnummer. */
  ersatz: number
  /** EAN — v4 carries the EAN here, the A record has no room for it. */
  ean: number
  /** Warengruppe. */
  warengruppe: number
  /** Verpackungsmenge (pack size). */
  verpackungsmenge: number
}

export const LAYOUT_B: Record<DatanormVersion, B_Felder> = {
  4: {
    verarbeitung: 1,
    artikelnummer: 2,
    matchcode: 3,
    ersatz: 4,
    ean: 9,
    warengruppe: 11,
    verpackungsmenge: 13,
  },
  5: {
    // v5 merged A and B: the B record only announces deletions and article
    // number changes. The article number is still field 2.
    verarbeitung: 1,
    artikelnummer: 2,
    matchcode: 3,
    ersatz: 4,
    ean: -1,
    warengruppe: -1,
    verpackungsmenge: -1,
  },
}

// ---------- D-Satz (Dimensionstext) ----------

export interface D_Felder {
  verarbeitung: number
  artikelnummer: number
  /** Index of the first text block. */
  blockStart: number
  /** Fields per text block. */
  blockGroesse: number
  /** Offset of the line number inside the block. */
  zeilennummer: number
  /** Offset of the sub-flag (F = free text, T/E = text block). */
  unterkennzeichen: number
  /** Offset of the text inside the block. */
  text: number
}

/**
 * v4 D record:
 * `D;N;Artikelnummer;1;F;;Dimensionstext;2;F;;Dimensionstext;`
 * Header: marker, flag, article number. Then blocks of four fields:
 * line number, sub-flag, text key, text.
 */
export const LAYOUT_D: Record<DatanormVersion, D_Felder> = {
  4: {
    verarbeitung: 1,
    artikelnummer: 2,
    blockStart: 3,
    blockGroesse: 4,
    zeilennummer: 0,
    unterkennzeichen: 1,
    text: 3,
  },
  5: {
    verarbeitung: 1,
    artikelnummer: 2,
    blockStart: 3,
    blockGroesse: 4,
    zeilennummer: 0,
    unterkennzeichen: 1,
    text: 3,
  },
}

// ---------- T-Satz (Langtext) ----------

export interface T_Felder {
  verarbeitung: number
  /** Langtextnummer — the key the A record references. */
  langtextnummer: number
  /** Index of the first text block. */
  blockStart: number
  /** Fields per text block. */
  blockGroesse: number
  /** Offset of the line number inside the block. */
  zeilennummer: number
  /** Offset of the text inside the block. */
  text: number
}

/**
 * v4 T record:
 * `T;N;Langtext-Nummer;;1;;Text Langtextzeile 1;2;;Text Langtextzeile 2;`
 * Header: marker, flag, text number, dummy. Then blocks of three fields:
 * line number, sub-flag, text.
 */
export const LAYOUT_T: Record<DatanormVersion, T_Felder> = {
  4: {
    verarbeitung: 1,
    langtextnummer: 2,
    blockStart: 4,
    blockGroesse: 3,
    zeilennummer: 0,
    text: 2,
  },
  5: {
    verarbeitung: 1,
    langtextnummer: 2,
    blockStart: 4,
    blockGroesse: 3,
    zeilennummer: 0,
    text: 2,
  },
}

// ---------- P-Satz (Preisänderung) ----------

export interface P_Felder {
  verarbeitung: number
  /** Index of the first article block. */
  blockStart: number
  /** Fields per article block. */
  blockGroesse: number
  /** Offset of the article number inside the block. */
  artikelnummer: number
  /** Offset of the price flag inside the block (1 = Brutto, 2 = Netto). */
  preisKennzeichen: number
  /** Offset of the price inside the block (Cent). */
  preis: number
}

/**
 * v4 P record: `P;A;Artikelnummer;Preiskennzeichen;Preis;…` — the fields 3
 * to 11 repeat for every further article on the line, i.e. blocks of nine.
 */
export const LAYOUT_P: Record<DatanormVersion, P_Felder> = {
  4: {
    verarbeitung: 1,
    blockStart: 2,
    blockGroesse: 9,
    artikelnummer: 0,
    preisKennzeichen: 1,
    preis: 2,
  },
  5: {
    verarbeitung: 1,
    blockStart: 2,
    blockGroesse: 9,
    artikelnummer: 0,
    preisKennzeichen: 1,
    preis: 2,
  },
}

// ---------- Vorlaufsatz (V) ----------

/**
 * The v4 Vorlaufsatz is a fixed-width record of 128 characters:
 * `V` + free + date (TTMMJJ) + three info texts + version (04) + currency.
 * The v5 Vorlaufsatz is semicolon-separated again
 * (`V;050;…;JJJJMMTT;EUR;…`).
 */
export const V_VERSION_POS_V4 = 123
export const V_WAEHRUNG_POS_V4 = 125

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
  // G = Grafik-Anbindung (v5), E = Endesatz (v5), W = Warengruppe
  G: 'G',
  E: 'E',
}

// ---------- Hilfsfunktionen ----------

/** Splits a record into its semicolon-separated fields, trimmed. */
export function zerlegeFelder(inhalt: string): string[] {
  return inhalt.split(';').map((f) => f.trim())
}

/** Reads a field by index, '' when the record is too short. */
export function feld(felder: string[], index: number): string {
  if (index < 0 || index >= felder.length) return ''
  return felder[index] ?? ''
}

/**
 * Joins the two short-text fields of an A record.
 *
 * The exporter splits the short text over two fields of 40 characters —
 * sometimes cutting a word in half. The Textkennzeichen (first digit) says
 * which texts are combined: 0 = "Kurztext 1 + Kurztext 2", 4/5/6 = the same
 * plus long/dimension text. In those cases both fields carry ONE text and
 * must be glued together — a space would produce "…Rücks eitseite" instead
 * of "…Rückseite".
 */
export function joinedKurztext(
  kurztext1: string,
  kurztext2: string,
  textkennzeichen = '',
): string {
  const a = kurztext1.trim()
  const b = kurztext2.trim()
  if (a === '') return b
  if (b === '') return a
  const ersteZiffer = textkennzeichen.trim().charAt(0)
  if (ersteZiffer !== '' && '0456'.includes(ersteZiffer)) return `${a}${b}`
  return `${a} ${b}`
}

/** Reads a decimal number, returning null for blank/garbage input. */
export function parseZahl(roh: string): number | null {
  const s = roh.trim().replace(',', '.')
  if (s === '') return null
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Reads a DATANORM price.
 *
 * DATANORM prices are integer CENT — "1234" means 12,34 EUR. The last two
 * digits are always the decimals, there is no decimal separator and no
 * thousands separator in the file. A supplier that writes "12,34" anyway
 * still means 1234 cent (the digits are read as a whole).
 *
 * The previous implementation multiplied by 100, which turned every price
 * into a hundredfold too large value.
 */
export function parsePreisCent(roh: string): number | null {
  const s = roh.trim()
  if (s === '') return null
  const negativ = s.startsWith('-')
  const ziffern = s.replace(/\D/g, '')
  if (ziffern === '') return null
  const cent = Number.parseInt(ziffern, 10)
  if (!Number.isFinite(cent)) return null
  return negativ ? -cent : cent
}

/**
 * Converts the v4 preis-einheit code into the factor it stands for.
 *
 * v4: 0 = per unit, 1 = per 10 units, 2 = per 100 units, 3 = per 1000 units.
 * v5: the field holds the factor itself.
 */
export function parsePreiseinheit(roh: string, version: DatanormVersion): number | null {
  const s = roh.trim()
  if (s === '') return null
  const n = Number.parseInt(s, 10)
  if (!Number.isFinite(n)) return null
  if (version === 5) return n > 0 ? n : null
  switch (n) {
    case 1:
      return 10
    case 2:
      return 100
    case 3:
      return 1000
    default:
      // 0 = "je Mengeneinheit" — der Preis gilt für eine Einheit.
      return 1
  }
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
