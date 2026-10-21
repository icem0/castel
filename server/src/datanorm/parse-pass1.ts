// DATANORM Pass 1: stream + collect.
//
// Why two passes? DATANORM records cross-reference each other freely:
//   * an A record may reference a D/T block located anywhere in the file
//   * T blocks are addressed by their own id, not by article matchcode
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
import { LAYOUT_A, LAYOUT_B, LAYOUT_D, LAYOUT_P, LAYOUT_P_PAAR, LAYOUT_T, LAYOUT_VORSATZ, SATZZEICHEN, normalisiereEan, parseDatum, parsePreisCent, parseZahl, schneide } from './layout.js'
import { erkenneEncoding, erzeugeStreamDecoder } from './encoding.js'
import { erzeugeSpillStore } from './spill.js'
import type {
  ArtikelRecord,
  BRecord,
  DescriptionRecord,
  DatanormEncoding,
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

/** Splits a line into its record marker and payload. */
export function zerlegeSatz(zeile: string, nr: number): Rohsatz {
  const zeichen = zeile.length > 0 ? zeile[0] as string : ''
  const satzart: Satzart = SATZZEICHEN[zeichen] ?? 'unbekannt'
  return {
    satzart,
    rohSatzzeichen: zeichen,
    inhalt: zeile.slice(1).trimEnd(),
    zeile: nr,
  }
}

/**
 * Detects the format version from the first meaningful line.
 *
 * The V record carries it (`V5.0…` in v4 fixed-width, `V;5.0;…` in v5).
 * When there is no V record at all we fall back to v4, which is still the
 * more commonly shipped version in the German trades.
 */
export function erkenneVersion(ersteZeile: string): DatanormVersion | null {
  if (!ersteZeile.startsWith('V')) return null
  const m = /(\d)\.(\d)/.exec(ersteZeile.slice(1, 12))
  if (!m) return null
  const major = Number(m[1])
  if (major === 5) return 5
  if (major === 4) return 4
  return null
}

/** Parses the V record. Returns null when it carries nothing usable. */
export function parseVorsatz(inhalt: string, version: DatanormVersion, zeile: number): VorsatzRecord {
  const layout = LAYOUT_VORSATZ[version]
  const werte: Record<string, string> = {}

  if (layout.v5Felder.length > 0 && inhalt.includes(';')) {
    // v5 is semicolon-separated: `V;5.0;20240115;EUR;MATCH;Name`. The
    // caller already stripped the leading `V`, so the payload typically
    // starts with a separator. Drop a leading empty field so the version
    // does not shift into the currency slot.
    const roh = inhalt.split(';')
    if (roh[0] === '') roh.shift()
    layout.v5Felder.forEach((name, i) => {
      werte[name] = (roh[i] ?? '').trim()
    })
  } else {
    for (const f of layout.v4Slices) {
      werte[f.name] = schneide(inhalt, f.von, f.bis)
    }
  }

  const versionRoh = werte.version ?? ''
  const versionAusVorsatz = erkenneVersion(`V${versionRoh}`)

  return {
    version: versionAusVorsatz ?? version,
    versionRoh,
    waehrung: werte.waehrung || null,
    stichtag: parseDatum(werte.stichtag ?? ''),
    lieferantMatchcode: werte.lieferantMatchcode || null,
    lieferantName: werte.lieferantName || null,
    zeile,
  }
}

/** Parses an A record. Returns null when the matchcode is unusable. */
export function parseArtikel(
  inhalt: string,
  version: DatanormVersion,
  zeile: number,
): ArtikelRecord | null {
  const layout = LAYOUT_A[version]
  const g: Record<string, string> = {}
  for (const f of layout.felder) g[f.name] = schneide(inhalt, f.von, f.bis)

  const matchcode = g.matchcode ?? ''
  if (matchcode === '') return null

  // v5 splits text on semicolons when the supplier uses them; fixed-width
  // text fields can contain a semicolon legitimately, so only split when
  // the layout is semicolon-based and the raw value looks truncated.
  let kurztext = g.kurztext ?? ''
  if (layout.semikolon && kurztext.includes(';')) {
    kurztext = kurztext.split(';')[0] ?? kurztext
  }

  // v4's quantity field is a FACTOR (this price covers N units) and is
  // restricted to 1/10/100/1000. v5 leaves it free.
  const preiseinheit = version === 4 ? parseZahl(g.preiseinheit ?? '') : null

  return {
    matchcode,
    matchcode2: g.matchcode2 || null,
    ean: normalisiereEan(g.ean ?? ''),
    kurztext,
    langtext: null,
    mengeneinheit: g.mengeneinheit || null,
    preiseinheit:
      preiseinheit !== null && preiseinheit > 0 && Number.isInteger(preiseinheit)
        ? preiseinheit
        : null,
    inhalt: version === 4 ? preiseinheit : null,
    warengruppe: g.warengruppe || null,
    preisNettoCent: parsePreisCent(g.preisNetto ?? ''),
    preisBruttoCent: parsePreisCent(g.preisBrutto ?? ''),
    preisAktionCent: parsePreisCent(g.preisAktion ?? ''),
    gueltigAb: parseDatum(g.gueltigAb ?? ''),
    steuersatz: null,
    gewicht: null,
    ersatzMatchcode: g.ersatzMatchcode || null,
    zeile,
  }
}

/** Parses a B record. Semantics differ by version (see types.ts). */
export function parseB(inhalt: string, version: DatanormVersion, zeile: number): BRecord | null {
  const layout = LAYOUT_B[version]
  const g: Record<string, string> = {}
  for (const f of layout.felder) g[f.name] = schneide(inhalt, f.von, f.bis)

  const matchcode = g.matchcode ?? ''
  if (matchcode === '') return null

  if (version === 4) {
    return { matchcode, ean: normalisiereEan(g.ean ?? ''), isDelete: false, zeile }
  }

  // v5: an action code in the second slot marks the article as withdrawn.
  const aktion = (g.aktion ?? '').toUpperCase()
  return { matchcode, ean: null, isDelete: aktion.startsWith('D') || aktion === 'LOESCH', zeile }
}

/** Parses a D record (one description line, two text slots). */
export function parseD(inhalt: string, zeile: number): DescriptionRecord | null {
  const g: Record<string, string> = {}
  for (const f of LAYOUT_D.felder) g[f.name] = schneide(inhalt, f.von, f.bis)
  const matchcode = g.matchcode ?? ''
  if (matchcode === '') return null
  const text1 = g.text1 ?? ''
  const text2 = g.text2 ?? ''
  const text = text2 ? `${text1} ${text2}`.trim() : text1
  return { matchcode, laufendeNr: g.laufendeNr ?? '', text, zeile }
}

/** Parses a T record (long-text block with its own id). */
export function parseT(inhalt: string, zeile: number): TextRecord | null {
  const g: Record<string, string> = {}
  for (const f of LAYOUT_T.felder) g[f.name] = schneide(inhalt, f.von, f.bis)
  const textId = g.textId ?? ''
  if (textId === '') return null
  const text1 = g.text1 ?? ''
  const text2 = g.text2 ?? ''
  const text = text2 ? `${text1} ${text2}`.trim() : text1
  return {
    textId,
    matchcode: g.matchcode || null,
    laufendeNr: g.laufendeNr || null,
    text,
    zeile,
  }
}

/**
 * Parses a P record into up to three product/price pairs.
 *
 * A P line holds prices for one, two, or three *different* articles, so we
 * return an array rather than a single pair. Empty slots are dropped.
 */
export function parseP(inhalt: string, version: DatanormVersion, zeile: number): PreisRecord {
  const layout = LAYOUT_P[version]
  const aenderungen: PreisAenderung[] = []
  for (const slot of layout.paare) {
    const g: Record<string, string> = {}
    for (const f of LAYOUT_P_PAAR) {
      g[f.name] = schneide(inhalt, slot.von + f.von, slot.von + f.bis)
    }
    const matchcode = g.matchcode ?? ''
    if (matchcode === '') continue
    aenderungen.push({
      matchcode,
      preisCent: parsePreisCent(g.preis ?? ''),
      gueltigAb: parseDatum(g.gueltigAb ?? ''),
    })
  }
  return { aenderungen, zeile }
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

  // ---- Version bestimmen (erste sinnvolle Zeile) ------------------------
  let version: DatanormVersion = opts.version ?? 4
  const sammel = leereSammlung(version, encoding)
  const spill = erzeugeSpillStore(config.DATANORM_TMP_DIR, config.DATANORM_DISK_SPILL_BYTES)

  let bytesGesamt = 0
  let ersteZeileGesehen = false
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

      if (!ersteZeileGesehen) {
        ersteZeileGesehen = true
        const erkannteVersion = erkenneVersion(zeile)
        if (opts.version) {
          // caller forced it
        } else if (erkannteVersion !== null) {
          version = erkannteVersion
          sammel.version = erkannteVersion
        } else {
          meldeFehler(
            sammel,
            strict,
            {
              satzart: satz.satzart,
              zeile: nr,
              code: 'DATANORM_VERSION_UNBEKANNT',
              meldung:
                'K DATANORM-Version nicht erkannt — nehme v4 an (v4 ist der verbreitetere Export).',
              kontext: zeile.slice(0, 80),
            },
          )
        }
      }

      satzAnzahl += 1
      opts.onFortschritt?.(satzAnzahl, `Satz ${satz.satzart}`)

      switch (satz.satzart) {
        case 'V': {
          if (sammel.vorsatz === null) {
            sammel.vorsatz = parseVorsatz(satz.inhalt, version, nr)
            if (sammel.vorsatz.version !== version) {
              sammel.version = sammel.vorsatz.version
              version = sammel.vorsatz.version
            }
          }
          break
        }
        case 'A': {
          const a = parseArtikel(satz.inhalt, version, nr)
          if (a === null) {
            meldeFehler(sammel, strict, {
              satzart: 'A',
              zeile: nr,
              code: 'DATANORM_A_OHNE_MATCHCODE',
              meldung: 'A-Satz ohne Matchcode — Datensatz übersprungen.',
              kontext: zeile.slice(0, 80),
            })
            break
          }
          // A record already present for this matchcode: keep the first,
          // report the duplicate. Suppliers sometimes ship both a full and
          // a delta file concatenated.
          const vorhanden = sammel.artikel.get(a.matchcode)
          if (vorhanden) {
            meldeFehler(sammel, strict, {
              satzart: 'A',
              zeile: nr,
              code: 'DATANORM_A_DOPPELT',
              meldung: `Matchcode ${a.matchcode} kommt mehrfach vor — erster Datensatz bleibt maßgeblich.`,
            })
            break
          }
          sammel.artikel.set(a.matchcode, a)
          spill.wennZuGross(sammel.artikel.size, () => sammel.artikel.get(a.matchcode))
          break
        }
        case 'B': {
          const b = parseB(satz.inhalt, version, nr)
          if (b === null) break
          sammel.bRecords.set(b.matchcode, b)
          break
        }
        case 'D': {
          const d = parseD(satz.inhalt, nr)
          if (d === null) break
          const liste = sammel.descriptions.get(d.matchcode)
          if (liste) liste.push(d)
          else sammel.descriptions.set(d.matchcode, [d])
          break
        }
        case 'T': {
          const t = parseT(satz.inhalt, nr)
          if (t === null) break
          const liste = sammel.texte.get(t.textId)
          if (liste) liste.push(t)
          else sammel.texte.set(t.textId, [t])
          // v5 style: T carrying a matchcode directly.
          if (t.matchcode) {
            const mListe = sammel.texteNachMatchcode.get(t.matchcode)
            if (mListe) mListe.push(t)
            else sammel.texteNachMatchcode.set(t.matchcode, [t])
          }
          break
        }
        case 'P': {
          const p = parseP(satz.inhalt, version, nr)
          for (const aenderung of p.aenderungen) {
            const liste = sammel.preise.get(aenderung.matchcode)
            const eintrag: PreisRecord = { aenderungen: [aenderung], zeile: p.zeile }
            if (liste) liste.push(eintrag)
            else sammel.preise.set(aenderung.matchcode, [eintrag])
          }
          break
        }
        case 'R':
        case 'S': {
          // Discount groups and article groups: parsed implicitly (they are
          // referenced by code from A records), not stored as their own
          // entities in the MVP.
          break
        }
        case 'Z': {
          // File-end marker in v5. Anything after it is out of scope.
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