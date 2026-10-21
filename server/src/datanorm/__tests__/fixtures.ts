// DATANORM test fixtures.
//
// Layout in this file mirrors the real format: the record marker sits in
// column 0, followed by fixed-width fields (see ../layout.ts for the exact
// offsets). Fixtures are deliberately small but exercise every code path
// Pass 1 cares about: cross-references, D/T descriptions, B records with
// different v4/v5 semantics, and multi-product P records.

import iconv from 'iconv-lite'

/** Pads/truncates a value to the exact field width (matches slice+trim). */
export function f(value: string, breite: number): string {
  return value.slice(0, breite).padEnd(breite, ' ')
}

/** Builds one A record (v5, semicolon-aware but fixed offsets). */
export function aV5(p: {
  matchcode: string
  matchcode2?: string
  ean?: string
  kurztext: string
  mengeneinheit?: string
  warengruppe?: string
  preisNetto?: string
  preisBrutto?: string
  gueltigAb?: string
  ersatz?: string
}): string {
  return (
    'A' +
    f(p.matchcode, 20) +
    f(p.matchcode2 ?? '', 10) +
    f(p.ean ?? '', 15) +
    f(p.kurztext, 40) +
    f(p.mengeneinheit ?? '', 5) +
    f(p.warengruppe ?? '', 10) +
    f(p.preisNetto ?? '', 12) +
    f(p.preisBrutto ?? '', 12) +
    f(p.preisAktion ?? '', 12) +
    f(p.gueltigAb ?? '', 8) +
    f(p.ersatz ?? '', 20)
  )
}

/** Builds one A record (v4, fixed-width, price unit = factor). */
export function aV4(p: {
  matchcode: string
  kurztext: string
  mengeneinheit?: string
  preiseinheit?: string
  preisNetto?: string
  preisBrutto?: string
  warengruppe?: string
}): string {
  return (
    'A' +
    f(p.matchcode, 14) +
    f(p.kurztext, 40) +
    f(p.mengeneinheit ?? '', 5) +
    f(p.preiseinheit ?? '', 2) +
    f(p.preisNetto ?? '', 10) +
    f(p.preisBrutto ?? '', 10) +
    f(p.warengruppe ?? '', 8)
  )
}

/** Builds a D record (description line, two text slots). */
export function d(matchcode: string, nr: string, text1: string, text2 = ''): string {
  return 'D' + f(matchcode, 14) + f(nr, 3) + f(text1, 40) + f(text2, 40)
}

/** Builds a T record (long-text block with its own id). */
export function t(textId: string, nr: string, matchcode: string, text1: string): string {
  return 'T' + f(textId, 14) + f(nr, 3) + f(matchcode, 14) + f(text1, 40) + f('', 40)
}

/** Builds a B record (v5 = delete marker). */
export function bV5(matchcode: string, aktion: string): string {
  return 'B' + f(matchcode, 20) + f(aktion, 10)
}

/** Builds a B record (v4 = EAN carrier). */
export function bV4(matchcode: string, ean: string): string {
  return 'B' + f(matchcode, 14) + f(ean, 15)
}

/** Builds a P record carrying up to three product/price slots. */
export function pEintraege(paare: Array<{ matchcode: string; preis?: string; gueltigAb?: string }>): string {
  const slots = [0, 1, 2].map((i) => {
    const e = paare[i]
    if (!e) return f('', 25)
    return (
      f(e.matchcode, 14) + f(e.preis ?? '', 9) + f(e.gueltigAb ?? '', 2)
    )
  })
  return 'P' + slots.join('')
}

/**
 * Joins records with CRLF, the classic DATANORM line ending.
 *
 * Encodes as CP850, not latin1: DATANORM v4 files are DOS CP850 and the
 * fixtures contain real German umlauts. latin1 would map 0x81 to a control
 * character instead of 'ü'.
 */
export function datei(zeilen: string[]): Buffer {
  return iconv.encode(zeilen.join('\r\n') + '\r\n', 'cp850')
}

/** Same as `datei`, but UTF-8 (for v5 files that ship as UTF-8). */
export function dateiUtf8(zeilen: string[]): Buffer {
  return Buffer.from(zeilen.join('\r\n') + '\r\n', 'utf-8')
}

/** A complete, well-formed v5 catalogue. */
export const BEISPIEL_V5 = [
  'V;5.0;20240115;EUR;MUELLER;Mueller GmbH',
  aV5({
    matchcode: 'ART-1001',
    ean: '4006381333931',
    kurztext: 'Bleistift HB',
    mengeneinheit: 'STK',
    warengruppe: 'WG-01',
    preisNetto: '2.49',
    preisBrutto: '2.99',
    gueltigAb: '20240115',
  }),
  aV5({
    matchcode: 'ART-1002',
    ean: '4012345678905',
    kurztext: 'Radiergummi',
    mengeneinheit: 'STK',
    warengruppe: 'WG-01',
    preisNetto: '0.79',
    preisBrutto: '0.95',
  }),
  // Cross-reference: the D block sits AFTER the A record.
  d('ART-1001', '001', 'Bleistift, Härtegrad HB, hexagonal'),
  d('ART-1001', '002', 'Lieferung in Kartons à 12 Stück'),
  // T block with its own id, referenced by nothing but stored.
  t('TEXT-77', '001', 'ART-1002', 'Radiergummi, weich, 65x23x35mm'),
  // P record with two different products on one line.
  pEintraege([
    { matchcode: 'ART-1001', preis: '2.59' },
    { matchcode: 'ART-1002', preis: '0.85' },
  ]),
  'Z',
]

/** A v4 catalogue. The B record carries the EAN (v4 A has no room for it). */
export const BEISPIEL_V4 = [
  'V4.0 20240115 EUR',
  aV4({
    matchcode: 'V4-ART1',
    kurztext: 'Kupferrohr 15mm',
    mengeneinheit: 'M',
    preiseinheit: '1',
    preisNetto: '12.90',
    preisBrutto: '15.48',
    warengruppe: 'ROHR',
  }),
  bV4('V4-ART1', '4001234567890'),
  d('V4-ART1', '001', 'Kupferrohr, DIN EN 1057'),
  'Z',
]

/** An A record that a v5 B record later marks as withdrawn. */
export const BEISPIEL_V5_MIT_DELETE = [
  'V;5.0;20240115;EUR;MUELLER;Mueller GmbH',
  aV5({
    matchcode: 'ART-2001',
    ean: '4006381333931',
    kurztext: 'Altes Produkt',
    preisNetto: '5.00',
  }),
  bV5('ART-2001', 'D'),
  'Z',
]

/** A file with a supplier-specific record marker we do not know. */
export const BEISPIEL_V5_UNBEKANNT = [
  'V;5.0;20240115;EUR;MUELLER;Mueller GmbH',
  aV5({ matchcode: 'ART-3001', kurztext: 'Normaler Artikel', preisNetto: '1.00' }),
  'Xirgendwas;Herstellerspezifische Ergaenzung',
  '€onderbar;Noch eine Zeile',
  'Z',
]