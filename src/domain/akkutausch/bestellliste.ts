// Plain-text rendering of the order list for e-mail/clipboard use.
//
// The output is deliberately simple: a title, the inventory cut-off, a
// space-aligned table and the total. No HTML, no markdown — every mail
// client renders it as a clean monospace block and it stays readable when
// pasted into a plain-text field.

import type { Bestellzeile, IsoDatum } from './types'
import { formatDatum, formatKapazitaet, formatKapazitaetBereich, formatZahl } from './formatierung'

/** Labels come from the active locale (the domain stays i18n-free). */
export interface BestelllisteTextOptionen {
  quartal: number
  jahr: number
  inventurDatum: IsoDatum | null
  inventurKuerzel: string | null
  titel: string
  inventurLabel: string
  kopfGroesse: string
  kopfNennkapazitaet: string
  kopfMenge: string
  gesamtLabel: string
}

/** Spaces between two columns — wide enough to stay readable in monospace. */
const SPALTEN_ABSTAND = 4

/**
 * Renders the order list as aligned plain text.
 *
 * The inventory line is always present — callers pass an empty/unknown date
 * only in exceptional cases so the recipient can see that the stock is not
 * dated.
 */
export function bestelllisteText(
  zeilen: readonly Bestellzeile[],
  locale: string,
  optionen: BestelllisteTextOptionen,
): string {
  const tabelle = zeilen.map((zeile) => [
    formatKapazitaetBereich(zeile.von, zeile.bis, locale),
    formatKapazitaet(zeile.kapazitaetAh, locale),
    formatZahl(zeile.menge, locale),
  ])

  const breite = (werte: readonly string[]): number =>
    werte.reduce((max, wert) => Math.max(max, wert.length), 0)

  const breiteGroesse = breite([optionen.kopfGroesse, ...tabelle.map((z) => z[0] ?? '')])
  const breiteKapazitaet = breite([optionen.kopfNennkapazitaet, ...tabelle.map((z) => z[1] ?? '')])
  const breiteMenge = breite([optionen.kopfMenge, ...tabelle.map((z) => z[2] ?? '')])

  const inventurDatum = optionen.inventurDatum ? formatDatum(optionen.inventurDatum, locale) : '—'
  const inventurKuerzel = optionen.inventurKuerzel ? ` (${optionen.inventurKuerzel})` : ''
  const gesamt = zeilen.reduce((summe, zeile) => summe + zeile.menge, 0)

  /** One table line: the quantity column is right-aligned like a number. */
  const tabellenZeile = (werte: readonly string[]): string =>
    [
      (werte[0] ?? '').padEnd(breiteGroesse),
      (werte[1] ?? '').padEnd(breiteKapazitaet),
      (werte[2] ?? '').padStart(breiteMenge),
    ]
      .join(' '.repeat(SPALTEN_ABSTAND))
      .trimEnd()

  const kopf = tabellenZeile([
    optionen.kopfGroesse,
    optionen.kopfNennkapazitaet,
    optionen.kopfMenge,
  ])
  const zeilenText = tabelle.map((zeile) => tabellenZeile(zeile))
  const gesamtText = `${optionen.gesamtLabel}: ${formatZahl(gesamt, locale)}`

  return [
    `${optionen.titel} – Q${optionen.quartal} ${optionen.jahr}`,
    `${optionen.inventurLabel}: ${inventurDatum}${inventurKuerzel}`,
    '',
    kopf,
    '-'.repeat(kopf.length),
    ...zeilenText,
    '',
    gesamtText.padStart(kopf.length),
  ].join('\n')
}
