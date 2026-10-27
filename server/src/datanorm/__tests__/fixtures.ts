// DATANORM test fixtures.
//
// The records below follow the REAL DATANORM layout — semicolon-separated
// fields, one record per line, CRLF line endings, CP850 encoding:
//
//   v4 A: A;N;Artikelnummer;Textkennzeichen;Kurztext 1;Kurztext 2;
//          Preiskennzeichen;Preiseinheit;Mengeneinheit;Preis;Rabattgruppe;
//          Hauptwarengruppe;Langtextschlüssel;
//   v4 B: B;N;Artikelnummer;Matchcode;Ersatz;Katalogseite;Kupfer…;EAN;
//          Anbindungsnummer;Warengruppe;Kostenart;Verpackungsmenge;Referenz…;
//   v4 D: D;N;Artikelnummer;Zeilennummer;Unterkennzeichen;Langtextschlüssel;Text;
//   v4 T: T;N;Langtextnummer;;Zeilennummer;Unterkennzeichen;Text;
//   v4 P: P;A;Artikelnummer;Preiskennzeichen;Preis;Rabatt…  (3–11 wiederholt sich)
//
// The v5 A record merges A and B: the EAN moved into the A record.
//
// The first article of BEISPIEL_V4 is a real-world sample (a 19" rack
// mounting set) — it guards the case where the supplier truncates the short
// text at 40 characters and continues in the second text field.

import iconv from 'iconv-lite'

/** The v4 Vorlaufsatz is a fixed-width record of 128 characters. */
export function v4Vorsatz(firma = 'Muster Handel GmbH', datum = '150124'): string {
  const info1 = firma.slice(0, 40).padEnd(40, ' ')
  const info2 = ''.padEnd(40, ' ')
  const info3 = ''.padEnd(35, ' ')
  return `V ${datum}${info1}${info2}${info3}04EUR`
}

/** The v5 Vorlaufsatz is semicolon-separated again. */
export function v5Vorsatz(firma = 'Muster Handel GmbH', datum = '20240115'): string {
  return `V;050;1;${datum};EUR;${firma};`
}

/** Builds one v4 A record (article master data). */
export function aV4(p: {
  artikelnummer: string
  verarbeitung?: string
  textkennzeichen?: string
  kurztext1?: string
  kurztext2?: string
  preisKennzeichen?: string
  preisEinheit?: string
  mengeneinheit?: string
  /** Price in cents ("4700" = 47,00 EUR). */
  preis?: string
  rabattgruppe?: string
  hauptwarengruppe?: string
  langtextschluessel?: string
}): string {
  return [
    'A',
    p.verarbeitung ?? 'N',
    p.artikelnummer,
    p.textkennzeichen ?? '00',
    p.kurztext1 ?? '',
    p.kurztext2 ?? '',
    p.preisKennzeichen ?? '2',
    p.preisEinheit ?? '0',
    p.mengeneinheit ?? '',
    p.preis ?? '',
    p.rabattgruppe ?? '',
    p.hauptwarengruppe ?? '',
    p.langtextschluessel ?? '',
    '',
  ].join(';')
}

/** Builds one v5 A record (A and B merged, EAN inside the A record). */
export function aV5(p: {
  artikelnummer: string
  verarbeitung?: string
  kurztext1?: string
  kurztext2?: string
  mengeneinheit?: string
  preisKennzeichen?: string
  /** The factor itself in v5 (1, 10, 100, …). */
  preisEinheit?: string
  preis?: string
  rabattgruppe?: string
  hauptwarengruppe?: string
  langtextschluessel?: string
  marke?: string
  ean?: string
  verpackungsmenge?: string
}): string {
  return [
    'A',
    p.verarbeitung ?? 'N',
    p.artikelnummer,
    p.kurztext1 ?? '',
    p.kurztext2 ?? '',
    p.mengeneinheit ?? '',
    p.preisKennzeichen ?? '2',
    p.preisEinheit ?? '1',
    p.preis ?? '',
    p.rabattgruppe ?? '',
    p.hauptwarengruppe ?? '',
    p.langtextschluessel ?? '',
    '',
    '',
    '',
    p.marke ?? '',
    '',
    p.artikelnummer,
    p.ean ?? '',
    '',
    p.verpackungsmenge ?? '',
    '',
    '0',
    '',
  ].join(';')
}

/** Builds one v4 B record (EAN, matchcode, pack size). */
export function bV4(p: {
  artikelnummer: string
  verarbeitung?: string
  matchcode?: string
  ersatz?: string
  ean?: string
  warengruppe?: string
  verpackungsmenge?: string
}): string {
  return [
    'B',
    p.verarbeitung ?? 'N',
    p.artikelnummer,
    p.matchcode ?? '',
    p.ersatz ?? '',
    '',
    '0',
    '0',
    '0',
    p.ean ?? '',
    '',
    p.warengruppe ?? '',
    '0',
    p.verpackungsmenge ?? '',
    '',
    '',
    '',
  ].join(';')
}

/** Builds one v4 D record (dimension text) with any number of text blocks. */
export function dV4(
  artikelnummer: string,
  bloecke: Array<{ nr: string; unterkennzeichen?: string; text: string }>,
): string {
  const f = ['D', 'N', artikelnummer]
  for (const b of bloecke) {
    f.push(b.nr, b.unterkennzeichen ?? 'F', '', b.text)
  }
  f.push('')
  return f.join(';')
}

/** Builds one v4 T record (long text block) with any number of text lines. */
export function tV4(
  langtextnummer: string,
  bloecke: Array<{ nr: string; text: string }>,
): string {
  const f = ['T', 'N', langtextnummer, '']
  for (const b of bloecke) {
    f.push(b.nr, '', b.text)
  }
  f.push('')
  return f.join(';')
}

/** Builds one v4 P record (price change) with up to three articles per line. */
export function pV4(
  paare: Array<{ artikelnummer: string; preisKennzeichen?: string; preis?: string }>,
): string {
  const f = ['P', 'A']
  for (const p of paare) {
    f.push(p.artikelnummer, p.preisKennzeichen ?? '2', p.preis ?? '', '0', '', '0', '', '0', '')
  }
  f.push('')
  return f.join(';')
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

/** Same as `datei`, but UTF-8 (for files that ship as UTF-8). */
export function dateiUtf8(zeilen: string[]): Buffer {
  return Buffer.from(zeilen.join('\r\n') + '\r\n', 'utf-8')
}

/**
 * A complete, well-formed v4 catalogue.
 *
 * The first article is a real supplier sample: the short text is cut off at
 * 40 characters and continues in the second text field, the price is 4700
 * cent (47,00 EUR) and the EAN lives in the B record.
 */
export const BEISPIEL_V4 = [
  v4Vorsatz('Muster Handel GmbH', '150124'),
  aV4({
    artikelnummer: '63-1211456-',
    textkennzeichen: '01',
    kurztext1: '19"-Rack-Montagesatz Front- und Rücks',
    kurztext2: 'eite, 1 HE',
    preisKennzeichen: '2',
    preisEinheit: '0',
    mengeneinheit: 'STK',
    preis: '4700',
    rabattgruppe: 'R01',
    hauptwarengruppe: 'H01',
    langtextschluessel: 'T000001',
  }),
  bV4({
    artikelnummer: '63-1211456-',
    matchcode: 'HEK-1001',
    ean: '4012345678905',
    verpackungsmenge: '1',
    warengruppe: 'W01',
  }),
  dV4('63-1211456-', [
    { nr: '1', text: 'Rack-Montagesatz für 19-Zoll-Technik, Front- und Rückseite.' },
    { nr: '2', text: 'Lieferung lose.' },
  ]),
  tV4('T000001', [
    { nr: '1', text: 'Montagesatz mit 2 HE, Front- und Rückseite.' },
    { nr: '2', text: 'Inkl. Befestigungsmaterial.' },
  ]),
  aV4({
    artikelnummer: '50-0500449-',
    textkennzeichen: '00',
    kurztext1: 'ABS-Gewindering M20',
    preisKennzeichen: '2',
    mengeneinheit: 'STK',
    preis: '0',
    rabattgruppe: 'R01',
    hauptwarengruppe: 'H02',
  }),
  bV4({ artikelnummer: '50-0500449-', ean: '4012345678912' }),
  'Z',
]

/** A complete, well-formed v5 catalogue (A and B merged, EAN in the A record). */
export const BEISPIEL_V5 = [
  v5Vorsatz('Muster Handel GmbH', '20240115'),
  aV5({
    artikelnummer: 'ART-1001',
    kurztext1: 'Bleistift HB',
    mengeneinheit: 'PCE',
    preisKennzeichen: '2',
    preisEinheit: '1',
    preis: '249',
    rabattgruppe: 'R01',
    hauptwarengruppe: 'H01',
    marke: 'Muster',
    ean: '4006381333931',
  }),
  aV5({
    artikelnummer: 'ART-1002',
    kurztext1: 'Radiergummi',
    kurztext2: 'weich 65x23x35mm',
    mengeneinheit: 'PCE',
    preisKennzeichen: '2',
    preis: '79',
    hauptwarengruppe: 'H01',
    ean: '4012345678905',
  }),
  'Z',
]

/** A v4 article that the supplier withdrew ("L" = Löschen). */
export const BEISPIEL_V4_MIT_DELETE = [
  v4Vorsatz(),
  aV4({
    artikelnummer: 'ART-2001',
    kurztext1: 'Altes Produkt',
    preis: '500',
  }),
  aV4({
    artikelnummer: 'ART-2002',
    verarbeitung: 'L',
    kurztext1: 'Zurückgezogenes Produkt',
  }),
  'Z',
]

/** A file with a supplier-specific record marker we do not know. */
export const BEISPIEL_V5_UNBEKANNT = [
  v5Vorsatz(),
  aV5({ artikelnummer: 'ART-3001', kurztext1: 'Normaler Artikel', preis: '100' }),
  'Xirgendwas;Herstellerspezifische Ergänzung',
  '€onderbar;Noch eine Zeile',
  'Z',
]
