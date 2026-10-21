// Encoding detection for DATANORM files.
//
// DATANORM predates Unicode by two decades. In practice:
//   * v4 files are DOS CP850 (IBM code page 850, Western Europe).
//   * v5 files are often UTF-8 but plenty of suppliers kept CP850.
//   * Some are Windows-1252 (a close relative of CP850).
//
// Why `iconv-lite` instead of `TextDecoder`: WHATWG TextDecoder only
// supports a small, fixed set of labels. CP850 is NOT among them — even
// with full ICU, `new TextDecoder('cp850')` throws. iconv-lite ships its
// own CP850 table, which is exactly what we need to read the legacy files
// this format is made of. (Node has no built-in DOS code page support at
// all; iconv-lite is the standard dependency for it.)
//
// Detection strategy: a valid UTF-8 byte sequence decodes without U+FFFD.
// A CP850 file decoded as UTF-8 almost always produces U+FFFD for the
// umlauts, so "no replacement chars" is a reliable UTF-8 signal. When the
// file is not valid UTF-8 we fall through to CP850 (the documented
// DATANORM default) and finally Windows-1252 as a safety net.

import iconv from 'iconv-lite'
import type { DatanormEncoding } from './types.js'

export interface EncodingErgebnis {
  encoding: DatanormEncoding
  /** Number of U+FFFD replacement characters the chosen decoder produced. */
  ersetzungen: number
  /** True when we are not confident and the admin should confirm. */
  unsicher: boolean
}

const REPLACEMENT = '�'

/** Bytes we inspect when sniffing. Enough for a header plus a few records. */
const PROBE_BYTES = 16 * 1024

function zaehleErsetzungen(text: string): number {
  let n = 0
  for (const ch of text) if (ch === REPLACEMENT) n++
  return n
}

/** Strict UTF-8 decode; returns null when the bytes are not valid UTF-8. */
function dekodiereUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

/**
 * Detects the encoding of a DATANORM buffer.
 *
 * @param probe Bytes to inspect. Defaults to the first 16 KB.
 */
export function erkenneEncoding(buffer: Buffer, probe = PROBE_BYTES): EncodingErgebnis {
  const slice = buffer.subarray(0, Math.min(probe, buffer.length))

  // 1) Valid UTF-8? Then it is UTF-8 — no ambiguity.
  if (dekodiereUtf8(slice) !== null) {
    return { encoding: 'utf-8', ersetzungen: 0, unsicher: false }
  }

  // 2) Some files are UTF-8 with a few stray bytes. A tiny number of
  //    U+FFFD in an otherwise decodable stream still means "mostly UTF-8",
  //    which CP850 would mangle far worse. Accept below 0.1 % damage.
  const tolerant = new TextDecoder('utf-8', { fatal: false }).decode(slice)
  const ersetzungen = zaehleErsetzungen(tolerant)
  if (ersetzungen > 0 && ersetzungen / Math.max(1, slice.length) < 0.001) {
    return { encoding: 'utf-8', ersetzungen, unsicher: true }
  }

  // 3) Not valid UTF-8. CP850 is the documented DATANORM default for v4.
  //    We sanity-check the decode: a real CP850 file yields plenty of
  //    printable German text, whereas mis-decoding random bytes produces
  //    control characters. Cheap heuristic, avoids false positives.
  const cp850 = iconv.decode(slice, 'cp850')
  const steuerzeichen = (cp850.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).length
  if (steuerzeichen / Math.max(1, cp850.length) < 0.02) {
    return { encoding: 'cp850', ersetzungen: 0, unsicher: false }
  }

  // 4) Last resort: Windows-1252 maps every byte, so this can never fail.
  return { encoding: 'windows-1252', ersetzungen: 0, unsicher: true }
}

/**
 * Decodes a full buffer with a previously detected encoding.
 *
 * Uses iconv-lite for the legacy code pages; UTF-8 goes through the native
 * TextDecoder, which is faster and handles a BOM transparently (we still
 * strip the BOM explicitly below).
 */
export function dekodiere(buffer: Buffer, encoding: DatanormEncoding): string {
  let text: string
  if (encoding === 'utf-8') {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  } else {
    text = iconv.decode(buffer, encoding === 'cp850' ? 'cp850' : 'win1252')
  }
  // Strip a BOM — it would otherwise end up in the first record marker.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Creates a streaming decoder for one encoding.
 *
 * CP850 is single-byte, so chunk boundaries are safe there. For UTF-8 the
 * native TextDecoder's stream mode is required: decoding chunks separately
 * would corrupt every umlaut that happens to straddle a boundary.
 */
export function erzeugeStreamDecoder(
  encoding: DatanormEncoding,
): (chunk: Buffer, final?: boolean) => string {
  if (encoding === 'utf-8') {
    const dec = new TextDecoder('utf-8', { fatal: false })
    return (chunk: Buffer, final = false) => dec.decode(chunk, { stream: !final })
  }
  // iconv-lite: CP850 is single-byte, so no character can straddle a chunk
  // boundary and decoding chunk-by-chunk is lossless. win1252 likewise.
  return (chunk: Buffer, _final = false) =>
    iconv.decode(chunk, encoding === 'cp850' ? 'cp850' : 'win1252')
}