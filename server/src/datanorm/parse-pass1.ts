// DATANORM Pass 1: stream + collect.
//
// Why two passes? DATANORM records cross-reference each other freely:
//   * an A record references a D/T block located anywhere in the file
//   * T blocks are addressed by their own id (Langtextschlüssel), not by
//     the article number
//   * B records pair with an A record elsewhere in the stream
// A single-pass "one line = one product" reader therefore cannot produce a
// usable record. Pass 1 collects everything into keyed maps; Pass 2
// (resolve.ts) joins the pieces.
//
// Streaming: the input arrives as an async iterable of Buffers (the upload
// stream), so a multi-hundred-MB file never lands in RAM as one string.
// We decode incrementally with a TextDecoder and split on line breaks as
// bytes arrive.
//
// Memory: Pass 1 holds the decoded records in Maps. Above
// DATANORM_DISK_SPILL_BYTES estimated size we spill to JSONL chunks under
// DATANORM_TMP_DIR (see spill.ts). For a 500 MB supplier catalogue this
// keeps the resident set bounded instead of growing to gigabytes.

import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import {
  LAYOUT_A,
  LAYOUT_B,
  LAYOUT_D,
  LAYOUT_P,
  LAYOUT_T,
  SATZZEICHEN,
  feld,
  joinedKurztext,
  normalisiereEan,
  parseDatum,
  parsePreisCent,
  parsePreiseinheit,
  parseZahl,
  zerlegeFelder,
} from './layout.js'
import { erkenneEncoding, erzeugeStreamDecoder } from './encoding.js'
import { erzeugeSpillStore } from './spill.js'
import type {
  ArtikelRecord,
  BRecord,
  DescriptionRecord,
  DatanormEncoding,
  DatanormFormat,
  DatanormVersion,
  GesammelteRecords,
  Parserfehler,
  PreisAenderung,
  PreisRecord,
  Rohsatz,
  Satzart,
  TextRecord,
  VorsatzRecord,
} from './types.js'
import { config } from '../config/config.js'

/** Cap on collected parser errors; the report keeps the first N. */
export const MAX_FEHLER_DETAILS = 100

export interface ParseOptionen {
  /** Override the auto-detected encoding (admin override from the UI). */
  encoding?: DatanormEncoding
  /** Abort when the buffer exceeds this many bytes. */
  maxBytes?: number
  /** Force a version instead of auto-detection (used by tests). */
  version?: DatanormVersion
  /** Force a format instead of auto-detection (admin override from the UI). */
  format?: DatanormFormat
  /** Hard-fail on the first structural problem instead of collecting it. */
  strict?: boolean
  /** Progress callback, invoked for every record. */
  onFortschritt?: (verarbeitet: number, hinweis: string) => void
}

export class DatanormFehler extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'DatanormFehler'
  }
}

/** Byte length of a decoded line. Only an estimate, used for the size cap. */
function byteLaenge(text: string): number {
  // cp850 is single-byte; utf-8 up to 3 bytes per BMP char (plus 4 for
  // astral). 3 is a safe upper bound for our size-limit accounting.
  return text.length * 3
}

function leereSammlung(
  version: DatanormVersion,
  encoding: DatanormEncoding,
): GesammelteRecords {
  return {
    version,
    encoding,
    vorsatz: null,
    artikel: new Map(),
    bRecords: new Map(),
    descriptions: new Map(),
    texte: new Map(),
    texteNachMatchcode: new Map(),
    preise: new Map(),
    fehler: [],
    zeilenGesamt: 0,
  }
}

/** Splits a line into its record marker and its payload. */
export function zerlegeSatz(zeile: string, nr: number): Rohsatz {
  const zeichen = zeile.length > 0 ? (zeile[0] as string) : ''
  const satzart: Satzart = SATZZEICHEN[zeichen] ?? 'unbekannt'
  return {
    satzart,
    rohSatzzeichen: zeichen,
    inhalt: zeile.slice(1).trimEnd(),
    zeile: nr,
  }
}

/**
 * Normalizes a version token to a version number.
 *
 * The tokens are zero-padded: the v4 Vorlaufsatz carries "04"/"05", the v5
 * one "050". `'04'.startsWith('4')` is false — the leading zeros have to go
 * before the comparison.
 */
function versionAusToken(roh: string): DatanormVersion | null {
  const ziffern = roh.replace(/\D/g, '').replace(/^0+/, '')
  if (ziffern.startsWith('5')) return 5
  if (ziffern.startsWith('4')) return 4
  return null
}

/**
 * Detects the format version.
 *
 * The Vorlaufsatz (V) carries it. In v4 the V record is a fixed-width
 * 128-character record whose last six characters are the version ("04")
 * and the currency ("EUR"); in v5 it is semicolon-separated and field 2
 * holds "050".
 *
 * @param zeile The first meaningful line of the file.
 */
export function erkenneVersion(zeile: string): DatanormVersion | null {
  if (!zeile.startsWith('V')) return null

  if (zeile.includes(';')) {
    const f = zerlegeFelder(zeile)
    return versionAusToken(f[1] ?? '')
  }

  // Fixed-width v4: "… 04EUR" at the very end.
  const m = /(\d{2})\s*([A-Z]{3})\s*$/.exec(zeile)
  if (m) {
    const v = versionAusToken(m[1]!)
    if (v !== null) return v
  }
  return versionAusToken(zeile.slice(123, 125))
}

/**
 * Detects the version from the field count of an A record.
 *
 * A v4 article record has 13 fields (14 with the trailing semicolon), a v5
 * article record has 23 (24 with it). The threshold sits safely in between.
 */
export function erkenneVersionAusFeldern(feldAnzahl: number): DatanormVersion {
  return feldAnzahl >= 18 ? 5 : 4
}

/** Converts the v4 date format (TTMMJJ) to an ISO date. */
function parseDatumTTMMJJ(roh: string): string | null {
  const s = roh.trim()
  if (!/^\d{6}$/.test(s)) return null
  const tag = s.slice(0, 2)
  const monat = s.slice(2, 4)
  const jahr = s.slice(4, 6)
  if (Number(monat) < 1 || Number(monat) > 12) return null
  if (Number(tag) < 1 || Number(tag) > 31) return null
  return `20${jahr}-${monat}-${tag}`
}

/**
 * Parses the Vorlaufsatz (V). Returns null when it carries nothing usable.
 *
 * Two shapes exist:
 *   * v4 — fixed width, 128 characters: `V` + free + TTMMJJ + three info
 *     texts + version ("04") + currency ("EUR").
 *   * v5 — semicolon-separated: `V;050;<Datenkennzeichen>;JJJJMMTT;EUR;…`.
 */
export function parseVorsatz(
  zeile: string,
  version: DatanormVersion,
  nr: number,
): VorsatzRecord {
  let versionRoh = ''
  let waehrung: string | null = null
  let stichtag: string | null = null
  let lieferantName: string | null = null
  let lieferantMatchcode: string | null = null

  if (zeile.includes(';')) {
    const f = zerlegeFelder(zeile)
    versionRoh = f[1] ?? ''
    // Date and currency: scan the fields, the order differs between exports.
    for (let i = 2; i < f.length; i++) {
      const wert = f[i] ?? ''
      if (stichtag === null) {
        const d = parseDatum(wert)
        if (d !== null) {
          stichtag = d
          continue
        }
      }
      if (waehrung === null && /^[A-Z]{3}$/.test(wert)) {
        waehrung = wert
        continue
      }
      if (lieferantName === null && wert !== '' && /[A-Za-zÄÖÜäöüß]/.test(wert)) {
        lieferantName = wert
      }
    }
  } else {
    // Fixed-width v4.
    const m = /(\d{2})\s*([A-Z]{3})\s*$/.exec(zeile)
    versionRoh = m ? m[1]! : zeile.slice(123, 125).trim()
    waehrung = m ? m[2]! : zeile.slice(125, 128).trim() || null
    stichtag = parseDatumTTMMJJ(zeile.slice(2, 8))
    const info1 = zeile.slice(8, 48).trim()
    const info2 = zeile.slice(48, 88).trim()
    lieferantName = info1 || info2 || null
  }

  const versionAusVorsatz = erkenneVersion(zeile)

  return {
    version: versionAusVorsatz ?? version,
    versionRoh,
    waehrung: waehrung || null,
    stichtag,
    lieferantMatchcode,
    lieferantName,
    zeile: nr,
  }
}

/**
 * Parses an A record (article master data).
 *
 * v4: `A;N;Artikelnummer;Textkennzeichen;Kurztext 1;Kurztext 2;Preiskennz.;
 * Preiseinheit;Mengeneinheit;Preis;Rabattgruppe;Hauptwarengruppe;Langtext;`
 * v5: the A and B records were merged — the EAN moved into the A record.
 */
export function parseArtikel(
  zeile: string,
  version: DatanormVersion,
  nr: number,
): ArtikelRecord | null {
  const l = LAYOUT_A[version]
  const f = zerlegeFelder(zeile)

  const matchcode = feld(f, l.artikelnummer)
  if (matchcode === '') return null

  const verarbeitung = feld(f, l.verarbeitung).toUpperCase()

  const kurztext1 = feld(f, l.kurztext1)
  const kurztext2 = l.kurztext2 === null ? '' : feld(f, l.kurztext2)
  const textkennzeichen = l.textkennzeichen === null ? '' : feld(f, l.textkennzeichen)
  // The supplier splits the short text over two fields of 40 characters.
  // Both belong together — the title would be cut off mid-word otherwise.
  const kurztext = joinedKurztext(kurztext1, kurztext2, textkennzeichen)

  const preisKennzeichen = feld(f, l.preisKennzeichen)
  const preis = parsePreisCent(feld(f, l.preis))
  const preisNettoCent = preisKennzeichen === '2' ? preis : null
  const preisBruttoCent = preisKennzeichen === '1' ? preis : preisKennzeichen === '2' ? null : preis

  const ean = l.ean === null ? null : normalisiereEan(feld(f, l.ean))

  return {
    matchcode,
    matchcode2: null,
    ean,
    kurztext,
    langtextschluessel:
      l.langtextschluessel === null ? null : feld(f, l.langtextschluessel) || null,
    mengeneinheit: feld(f, l.mengeneinheit) || null,
    preiseinheit: parsePreiseinheit(feld(f, l.preisEinheit), version),
    inhalt: null,
    warengruppe: feld(f, l.hauptwarengruppe) || null,
    preisNettoCent,
    preisBruttoCent,
    preisAktionCent: null,
    gueltigAb: null,
    steuersatz: null,
    gewicht: null,
    ersatzMatchcode: null,
    // "L" = Löschen: the supplier withdrew the article.
    isDelete: verarbeitung === 'L',
    zeile: nr,
  }
}

/** Parses a B record.
 *
 * v4 carries the extra article data (EAN, matchcode, pack size).
 * v5 uses the B record only for deletions and article number changes.
 */
export function parseB(
  zeile: string,
  version: DatanormVersion,
  nr: number,
): BRecord | null {
  const l = LAYOUT_B[version]
  const f = zerlegeFelder(zeile)

  const matchcode = feld(f, l.artikelnummer)
  if (matchcode === '') return null

  const verarbeitung = feld(f, l.verarbeitung).toUpperCase()
  const verpackungsmenge = l.verpackungsmenge < 0 ? null : parseZahl(feld(f, l.verpackungsmenge))

  return {
    matchcode,
    matchcode2: l.matchcode < 0 ? null : feld(f, l.matchcode) || null,
    ean: l.ean < 0 ? null : normalisiereEan(feld(f, l.ean)),
    ersatzMatchcode: l.ersatz < 0 ? null : feld(f, l.ersatz) || null,
    warengruppe: l.warengruppe < 0 ? null : feld(f, l.warengruppe) || null,
    verpackungsmenge,
    isDelete: verarbeitung === 'L',
    zeile: nr,
  }
}

/**
 * Parses a D record (dimension text) into its text blocks.
 *
 * `D;N;Artikelnummer;1;F;;Dimensionstext;2;F;;Dimensionstext;`
 * After the header (marker, flag, article number) the line carries blocks of
 * four fields: line number, sub-flag, text key, text.
 */
export function parseD(
  zeile: string,
  version: DatanormVersion,
  nr: number,
): DescriptionRecord[] {
  const l = LAYOUT_D[version]
  const f = zerlegeFelder(zeile)

  const matchcode = feld(f, l.artikelnummer)
  if (matchcode === '') return []

  const out: DescriptionRecord[] = []
  for (let base = l.blockStart; base < f.length; base += l.blockGroesse) {
    const laufendeNr = feld(f, base + l.zeilennummer)
    const text = feld(f, base + l.text)
    if (text === '' && laufendeNr === '') continue
    out.push({ matchcode, laufendeNr, text, zeile: nr })
  }
  return out
}

/**
 * Parses a T record (long text block) into its text blocks.
 *
 * `T;N;Langtext-Nummer;;1;;Text Langtextzeile 1;2;;Text Langtextzeile 2;`
 * After the header (marker, flag, text number, dummy) the line carries
 * blocks of three fields: line number, sub-flag, text.
 */
export function parseT(
  zeile: string,
  version: DatanormVersion,
  nr: number,
): TextRecord[] {
  const l = LAYOUT_T[version]
  const f = zerlegeFelder(zeile)

  const textId = feld(f, l.langtextnummer)
  if (textId === '') return []

  const out: TextRecord[] = []
  for (let base = l.blockStart; base < f.length; base += l.blockGroesse) {
    const laufendeNr = feld(f, base + l.zeilennummer)
    const text = feld(f, base + l.text)
    if (text === '' && laufendeNr === '') continue
    out.push({ textId, matchcode: null, laufendeNr: laufendeNr || null, text, zeile: nr })
  }
  return out
}

/**
 * Parses a P record (price change) into its product/price blocks.
 *
 * The fields 3 to 11 repeat for every further article on the line, i.e.
 * blocks of nine fields starting at the article number.
 */
export function parseP(zeile: string, version: DatanormVersion, nr: number): PreisRecord {
  const l = LAYOUT_P[version]
  const f = zerlegeFelder(zeile)

  const aenderungen: PreisAenderung[] = []
  for (let base = l.blockStart; base < f.length; base += l.blockGroesse) {
    const matchcode = feld(f, base + l.artikelnummer)
    if (matchcode === '') continue
    const kennzeichen = feld(f, base + l.preisKennzeichen)
    aenderungen.push({
      matchcode,
      preisCent: parsePreisCent(feld(f, base + l.preis)),
      preisKennzeichen: kennzeichen === '' ? null : Number.parseInt(kennzeichen, 10) || null,
      gueltigAb: null,
    })
  }
  return { aenderungen, zeile: nr }
}

/**
 * Pushes onto the error list, honouring the cap and strict mode.
 * Returns false when strict mode demanded an abort.
 */
function meldeFehler(
  sammel: GesammelteRecords,
  strict: boolean,
  fehler: Parserfehler,
): boolean {
  if (strict) {
    throw new DatanormFehler(
      `Zeile ${fehler.zeile}: ${fehler.meldung}`,
      fehler.code,
    )
  }
  if (sammel.fehler.length < MAX_FEHLER_DETAILS) sammel.fehler.push(fehler)
  return true
}

/**
 * Pass 1 — decodes and collects every record of a DATANORM file.
 *
 * @param source A file stream (the upload stream) or a Buffer (tests).
 */
export async function sammleDatanorm(
  source: Readable | Buffer,
  opts: ParseOptionen = {},
): Promise<GesammelteRecords> {
  const strict = opts.strict ?? config.DATANORM_STRICT_MODE
  const maxBytes = opts.maxBytes ?? config.DATANORM_MAX_FILE_BYTES

  // ---- Encoding ---------------------------------------------------------
  // A Buffer is already in memory, so we inspect its head directly. For a
  // stream we read the first chunk to sniff the encoding, then chain it
  // back into the generator so no bytes are lost.
  const chunks: AsyncIterable<Buffer<ArrayBufferLike>> = Buffer.isBuffer(source)
    ? (async function* () {
        yield source
      })()
    : (source as AsyncIterable<Buffer<ArrayBufferLike>>)

  let head: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let ersterChunk: Buffer<ArrayBufferLike> | null = null
  const iterator = chunks[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (!first.done) {
    ersterChunk = first.value
    head = ersterChunk.subarray(0, 16 * 1024)
  }

  const byteStrom: AsyncIterable<Buffer<ArrayBufferLike>> = (async function* () {
    if (ersterChunk) yield ersterChunk
    for (;;) {
      const n = await iterator.next()
      if (n.done) return
      yield n.value
    }
  })()

  const erkannt = opts.encoding
    ? { encoding: opts.encoding, ersetzungen: 0, unsicher: false }
    : erkenneEncoding(head)
  const encoding = erkannt.encoding

  // ---- Zeilenweise dekodieren --------------------------------------------
  // The decoder is created from the *detected* encoding. For UTF-8 its
  // stream mode keeps multi-byte sequences that straddle chunk boundaries
  // intact — decoding each chunk separately would corrupt every umlaut
  // landing on a boundary. CP850 is single-byte, so chunks are safe there.
  const decodeChunk = erzeugeStreamDecoder(encoding)
  async function* dekodiert(): AsyncGenerator<string> {
    for await (const chunk of byteStrom) {
      const s = decodeChunk(chunk, false)
      if (s.length > 0) yield s
    }
    const tail = decodeChunk(Buffer.alloc(0), true)
    if (tail.length > 0) yield tail
  }

  // ---- Version bestimmen ------------------------------------------------
  // The admin can force a version; otherwise the Vorlaufsatz decides, and
  // if there is none the field count of the first A record does.
  const formatOverride: DatanormFormat = opts.format ?? 'auto'
  let version: DatanormVersion = opts.version ?? 4
  let versionFest = opts.version !== undefined || formatOverride !== 'auto'
  if (formatOverride === 'v4') version = 4
  if (formatOverride === 'v5') version = 5

  const sammel = leereSammlung(version, encoding)
  const spill = erzeugeSpillStore(config.DATANORM_TMP_DIR, config.DATANORM_DISK_SPILL_BYTES)

  let bytesGesamt = 0
  let satzAnzahl = 0
  let nr = 0

  const rl = createInterface({
    input: Readable.from(dekodiert()),
    crlfDelay: Infinity,
  })

  try {
    for await (const rohzeile of rl) {
      const zeile = (rohzeile as string).replace(/\r$/, '')
      if (zeile.trim() === '') continue
      nr += 1
      bytesGesamt += byteLaenge(zeile)
      if (bytesGesamt > maxBytes) {
        throw new DatanormFehler(
          `Datei überschreitet das Limit von ${maxBytes} Bytes`,
          'DATANORM_ZU_GROSS',
        )
      }

      const satz = zerlegeSatz(zeile, nr)
      sammel.zeilenGesamt = nr

      // ---- Version aus dem Vorlaufsatz oder der Feldzahl ableiten ----
      if (!versionFest) {
        if (satz.satzart === 'V') {
          const erkanntV = erkenneVersion(zeile)
          if (erkanntV !== null) {
            version = erkanntV
            sammel.version = erkanntV
            versionFest = true
          }
        } else if (satz.satzart === 'A') {
          const feldAnzahl = zeile.split(';').length
          version = erkenneVersionAusFeldern(feldAnzahl)
          sammel.version = version
          versionFest = true
        }
      }

      satzAnzahl += 1
      opts.onFortschritt?.(satzAnzahl, `Satz ${satz.satzart}`)

      switch (satz.satzart) {
        case 'V': {
          if (sammel.vorsatz === null) {
            sammel.vorsatz = parseVorsatz(zeile, version, nr)
            if (sammel.vorsatz.version !== version) {
              version = sammel.vorsatz.version
              sammel.version = version
            }
          }
          break
        }
        case 'A': {
          const a = parseArtikel(zeile, version, nr)
          if (a === null) {
            meldeFehler(sammel, strict, {
              satzart: 'A',
              zeile: nr,
              code: 'DATANORM_A_OHNE_ARTIKELNUMMER',
              meldung: 'A-Satz ohne Artikelnummer — Datensatz übersprungen.',
              kontext: zeile.slice(0, 80),
            })
            break
          }
          // A record already present for this article number: keep the
          // first, report the duplicate. Suppliers sometimes ship both a
          // full and a delta file concatenated.
          const vorhanden = sammel.artikel.get(a.matchcode)
          if (vorhanden) {
            meldeFehler(sammel, strict, {
              satzart: 'A',
              zeile: nr,
              code: 'DATANORM_A_DOPPELT',
              meldung:
                `Artikelnummer ${a.matchcode} kommt mehrfach vor — erster Datensatz bleibt maßgeblich.`,
            })
            break
          }
          sammel.artikel.set(a.matchcode, a)
          spill.wennZuGross(sammel.artikel.size, () => sammel.artikel.get(a.matchcode))
          break
        }
        case 'B': {
          const b = parseB(zeile, version, nr)
          if (b === null) break
          sammel.bRecords.set(b.matchcode, b)
          break
        }
        case 'D': {
          for (const d of parseD(zeile, version, nr)) {
            const liste = sammel.descriptions.get(d.matchcode)
            if (liste) liste.push(d)
            else sammel.descriptions.set(d.matchcode, [d])
          }
          break
        }
        case 'T': {
          for (const t of parseT(zeile, version, nr)) {
            const liste = sammel.texte.get(t.textId)
            if (liste) liste.push(t)
            else sammel.texte.set(t.textId, [t])
          }
          break
        }
        case 'P': {
          const p = parseP(zeile, version, nr)
          for (const aenderung of p.aenderungen) {
            const liste = sammel.preise.get(aenderung.matchcode)
            const eintrag: PreisRecord = { aenderungen: [aenderung], zeile: p.zeile }
            if (liste) liste.push(eintrag)
            else sammel.preise.set(aenderung.matchcode, [eintrag])
          }
          break
        }
        case 'R':
        case 'S':
        case 'G':
        case 'E': {
          // Discount groups, item groups, image bindings, end marker: they
          // carry no article data we store.
          break
        }
        case 'unbekannt': {
          meldeFehler(sammel, strict, {
            satzart: `unbekannt(${satz.rohSatzzeichen || '?'})`,
            zeile: nr,
            code: 'DATANORM_SATZ_UNBEKANNT',
            meldung:
              'Zeile mit unbekanntem Satzzeichen — wird ignoriert (DATANORM erlaubt herstellerspezifische Ergänzungen).',
            kontext: zeile.slice(0, 80),
          })
          break
        }
      }
    }
  } finally {
    rl.close()
  }

  if (sammel.artikel.size === 0) {
    throw new DatanormFehler(
      'Keine A-Sätze (Artikelstammsätze) in der Datei gefunden — das ist keine gültige DATANORM-Artikeldatei.',
      'DATANORM_KEINE_ARTIKEL',
    )
  }

  await spill.close()
  return sammel
}

/** Convenience wrapper for tests and small files. */
export function sammleDatanormAusBuffer(
  buffer: Buffer,
  opts: ParseOptionen = {},
): Promise<GesammelteRecords> {
  return sammleDatanorm(buffer, opts)
}
