// Core types for the DATANORM importer.
//
// DATANORM is a German legacy master-data format (de-facto standard for
// supplier catalogues in the SHK/electrical/painting trades). It is *not* a
// regular CSV: each line carries a record-type marker ("Satzkennzeichen")
// and the field layout differs per record type and per version (v4 vs v5).
//
// These types describe the *decoded* view of the format, i.e. what Pass 1
// (stream + collect) and Pass 2 (resolve) hand over to each other. The DB
// row shape lives in the Drizzle schema, the API payload shape is defined
// per route.
//
// References: the field layout constants in ./layout.ts carry the record
// offsets. They are intentionally kept separate from the parsing logic so
// the specification can be reviewed in one place.

/** DATANORM spec version we can decode. */
export type DatanormVersion = 4 | 5

/** Character encoding detected for a source file. */
export type DatanormEncoding = 'utf-8' | 'cp850' | 'windows-1252'

/**
 * Record types ("Satzkennzeichen") as used by DATANORM.
 *
 * `unbekannt` is the tolerant catch-all: suppliers extend the format and
 * put arbitrary letters into the first column. Those lines are collected
 * and reported instead of aborting the import.
 */
export type Satzart =
  | 'V' // Vorlaufsatz (file header: version, currency, price date)
  | 'A' // Artikel-Stammsatz (the core record)
  | 'B' // v4: extra article data (EAN). v5: delete marker
  | 'D' // Description line (long text, numbered lines)
  | 'T' // Long-text block with its own id
  | 'P' // Price change (up to 3 products per line)
  | 'R' // Rabattgruppe
  | 'S' // Warengruppe / Haupt- oder Warengruppensatz
  | 'Z' // File-end record (v5)
  | 'unbekannt'

/** One raw input line, split into the record marker and its payload. */
export interface Rohsatz {
  satzart: Satzart
  /** Raw character marker exactly as found in column 0 (may be unmapped). */
  rohSatzzeichen: string
  /** Decoded payload without the leading record marker, trimmed right. */
  inhalt: string
  /** 1-based line number in the source file (for error reporting). */
  zeile: number
}

/** Vorlaufsatz (V). Pure metadata, never article data. */
export interface VorsatzRecord {
  version: DatanormVersion
  /** Decimal version string as written in the file, e.g. "5.0". */
  versionRoh: string
  waehrung: string | null
  /** Price validity date (YYYY-MM-DD) if the file carries one. */
  stichtag: string | null
  /** Supplier matchcode / Kuerzel from the header, if present. */
  lieferantMatchcode: string | null
  lieferantName: string | null
  zeile: number
}

/** Artikel-Stammsatz (A). */
export interface ArtikelRecord {
  matchcode: string
  matchcode2: string | null
  ean: string | null
  /** Short text (up to 40 chars) - the primary label in the catalogue. */
  kurztext: string
  langtext: string | null
  mengeneinheit: string | null
  /**
   * Price unit factor. In v4 the quantity unit is restricted to
   * 1/10/100/1000, meaning "this price covers N units". v5 leaves it free.
   */
  preiseinheit: number | null
  /** Content per saleable unit (e.g. 12 pieces per pack). */
  inhalt: number | null
  warengruppe: string | null
  /** Prices in cents, mirroring `artikel.listenpreis`. */
  preisNettoCent: number | null
  preisBruttoCent: number | null
  preisAktionCent: number | null
  /** Date from which the prices are valid (YYYY-MM-DD). */
  gueltigAb: string | null
  steuersatz: number | null
  gewicht: number | null
  ersatzMatchcode: string | null
  zeile: number
}

/**
 * B-Satz. Semantics differ by version:
 * - v4 carries additional article data, most importantly the EAN.
 * - v5 is a delete marker (supplier announces a product as deprecated).
 */
export interface BRecord {
  matchcode: string
  ean: string | null
  /** v5 delete marker detected. */
  isDelete: boolean
  zeile: number
}

/** Description line (D). Multiple D records per article, numbered. */
export interface DescriptionRecord {
  matchcode: string
  /** Zero-padded line number within the description block. */
  laufendeNr: string
  text: string
  zeile: number
}

/**
 * Long-text block (T). T records carry their own text id; in v4 that id is
 * unrelated to the article matchcode, the article references it. In v5 T is
 * commonly (mis)used as a drop-in for D and references the matchcode
 * directly. We keep both possibilities and let Pass 2 decide.
 */
export interface TextRecord {
  /** The T record's own id. */
  textId: string
  /** Matchcode if the record carries one (v5 style). */
  matchcode: string | null
  laufendeNr: string | null
  text: string
  zeile: number
}

/** One product/price pair inside a P record. */
export interface PreisAenderung {
  matchcode: string
  /** New price in cents. */
  preisCent: number | null
  gueltigAb: string | null
}

/** P-Satz: up to three product/price pairs on one line. */
export interface PreisRecord {
  aenderungen: PreisAenderung[]
  zeile: number
}

/** One tolerated problem (unknown record, unparsable field, ...). */
export interface Parserfehler {
  satzart: string
  zeile: number
  code: string
  meldung: string
  /** Short excerpt of the offending line, for the admin report. */
  kontext?: string
}

/** Everything Pass 1 collected from one file. */
export interface GesammelteRecords {
  version: DatanormVersion
  encoding: DatanormEncoding
  vorsatz: VorsatzRecord | null
  artikel: Map<string, ArtikelRecord>
  /** v4: extra article data keyed by matchcode. */
  bRecords: Map<string, BRecord>
  /** D records grouped by matchcode, insertion-ordered by line number. */
  descriptions: Map<string, DescriptionRecord[]>
  /** T records keyed by their own text id. */
  texte: Map<string, TextRecord[]>
  /** v5 style: T records that already carry a matchcode. */
  texteNachMatchcode: Map<string, TextRecord[]>
  preise: Map<string, PreisRecord[]>
  fehler: Parserfehler[]
  /** Total lines read, for progress reporting and error percentages. */
  zeilenGesamt: number
}

/** One fully resolved catalogue entry, ready to be persisted. */
export interface AufgeloesterArtikel {
  matchcode: string
  ean: string | null
  titel: string
  beschreibung: string | null
  mengeneinheit: string | null
  preiseinheit: number | null
  inhalt: number | null
  warengruppe: string | null
  preisNettoCent: number | null
  preisBruttoCent: number | null
  preisAktionCent: number | null
  gueltigAb: string | null
  ersatzMatchcode: string | null
  /** Set when a v5 B delete marker was seen for this matchcode. */
  deaktiviert: boolean
}

/** Progress phases an import can report through SSE. */
export type ImportPhase = 'stream' | 'parse' | 'persist' | 'fertig'

/** Progress payload emitted while an import runs. */
export interface ImportFortschritt {
  importId: string
  phase: ImportPhase
  verarbeitet: number
  gesamt: number
  fehler: number
  hinweis?: string
}

/** Lifecycle of one import job. */
export type ImportStatus = 'gestartet' | 'erfolg' | 'teilfehler' | 'fehler'