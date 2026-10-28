// Order options for the Akkutausch tool.
//
// The planning table knows sizes and quantities, but an order needs a
// supplier. This module resolves the chain
//
//   Bestellzeile -> AkkuTyp -> Artikel -> Hersteller
//
// and groups the order lines by supplier. The UI then offers one option per
// supplier (order mail and/or website) and lists the articles each option
// covers.
//
// Pure module: no Vue, no Dexie, no server imports. The data comes in as
// lookup maps, so the logic stays unit-testable.

import { formatDatum, formatKapazitaetBereich, formatZahl } from './formatierung'
import type { AkkuTyp, Bestellzeile, IsoDatum } from './types'

/** Minimal article shape needed to build the order options. */
export interface ArtikelKontakt {
  id: string
  titel: string
  bestellnummer: string | null
  herstellerId: string | null
}

/** Minimal manufacturer shape needed to build the order options. */
export interface HerstellerKontakt {
  id: string
  name: string
  bestellEmail: string | null
  bestellWebseite: string | null
}

/** One article inside an order option. */
export interface BestelloptionZeile {
  artikelId: string
  artikelTitel: string
  bestellnummer: string | null
  /** Lower bound of the (possibly merged) capacity range. */
  von: number
  /** Upper bound of the (possibly merged) capacity range. */
  bis: number
  /** Nominal capacity of the size. */
  kapazitaetAh: number
  /** Number of pieces to order. */
  menge: number
}

/** One order option: everything that is ordered at a single supplier. */
export interface Bestelloption {
  herstellerId: string
  herstellerName: string
  bestellEmail: string | null
  bestellWebseite: string | null
  zeilen: BestelloptionZeile[]
  gesamtMenge: number
}

/** Reason why a line of the order list cannot be ordered. */
export type OhneKontaktGrund = 'kein_artikel' | 'kein_hersteller' | 'kein_bestellkontakt'

/** A line of the order list that has no order contact. */
export interface OhneKontakt {
  grund: OhneKontaktGrund
  artikelId: string | null
  artikelTitel: string | null
  von: number
  bis: number
  kapazitaetAh: number
  menge: number
}

/** Order options per supplier plus the lines that cannot be ordered. */
export interface Bestelloptionen {
  optionen: Bestelloption[]
  ohneKontakt: OhneKontakt[]
}

/** Input of {@link ermittleBestelloptionen}. */
export interface BestelloptionenEingabe {
  /** Lines of the order list (only the sizes with a demand). */
  zeilen: readonly Bestellzeile[]
  /** Configured battery sizes — they carry the article link. */
  typen: readonly AkkuTyp[]
  /** Articles by id. */
  artikel: ReadonlyMap<string, ArtikelKontakt>
  /** Manufacturers by id. */
  hersteller: ReadonlyMap<string, HerstellerKontakt>
}

/**
 * Groups the lines of the order list by supplier.
 *
 * Every line is checked: a size without an article, an article without a
 * manufacturer and a manufacturer without an order contact end up in
 * `ohneKontakt` — the UI shows them instead of silently dropping them.
 * Several sizes that share the same article are merged into one row with
 * the summed quantity.
 *
 * The options are sorted by manufacturer name, the rows keep the order of
 * the order list (ascending nominal capacity).
 */
export function ermittleBestelloptionen(eingabe: BestelloptionenEingabe): Bestelloptionen {
  const typJeId = new Map(eingabe.typen.map((typ) => [typ.id, typ]))
  const optionen = new Map<string, Bestelloption>()
  const ohneKontakt: OhneKontakt[] = []

  for (const zeile of eingabe.zeilen) {
    const typ = typJeId.get(zeile.typId)
    const artikelId = typ?.artikelId ?? null
    const artikel = artikelId ? eingabe.artikel.get(artikelId) : undefined

    if (!artikelId || !artikel) {
      ohneKontakt.push({
        grund: 'kein_artikel',
        artikelId,
        artikelTitel: null,
        von: zeile.von,
        bis: zeile.bis,
        kapazitaetAh: zeile.kapazitaetAh,
        menge: zeile.menge,
      })
      continue
    }

    const herstellerId = artikel.herstellerId
    const hersteller = herstellerId ? eingabe.hersteller.get(herstellerId) : undefined

    if (!herstellerId || !hersteller) {
      ohneKontakt.push({
        grund: 'kein_hersteller',
        artikelId: artikel.id,
        artikelTitel: artikel.titel,
        von: zeile.von,
        bis: zeile.bis,
        kapazitaetAh: zeile.kapazitaetAh,
        menge: zeile.menge,
      })
      continue
    }

    if (!hatBestellkontakt(hersteller)) {
      ohneKontakt.push({
        grund: 'kein_bestellkontakt',
        artikelId: artikel.id,
        artikelTitel: artikel.titel,
        von: zeile.von,
        bis: zeile.bis,
        kapazitaetAh: zeile.kapazitaetAh,
        menge: zeile.menge,
      })
      continue
    }

    let option = optionen.get(herstellerId)
    if (!option) {
      option = {
        herstellerId,
        herstellerName: hersteller.name,
        bestellEmail: hersteller.bestellEmail,
        bestellWebseite: hersteller.bestellWebseite,
        zeilen: [],
        gesamtMenge: 0,
      }
      optionen.set(herstellerId, option)
    }

    const vorhanden = option.zeilen.find((z) => z.artikelId === artikel.id)
    if (vorhanden) {
      vorhanden.menge += zeile.menge
      vorhanden.von = Math.min(vorhanden.von, zeile.von)
      vorhanden.bis = Math.max(vorhanden.bis, zeile.bis)
    } else {
      option.zeilen.push({
        artikelId: artikel.id,
        artikelTitel: artikel.titel,
        bestellnummer: artikel.bestellnummer,
        von: zeile.von,
        bis: zeile.bis,
        kapazitaetAh: zeile.kapazitaetAh,
        menge: zeile.menge,
      })
    }
    option.gesamtMenge += zeile.menge
  }

  const sortiert = [...optionen.values()].sort((a, b) =>
    a.herstellerName.localeCompare(b.herstellerName, 'de'),
  )

  return { optionen: sortiert, ohneKontakt }
}

/** True when the manufacturer has an order mail or an order website. */
export function hatBestellkontakt(hersteller: HerstellerKontakt): boolean {
  return Boolean(hersteller.bestellEmail?.trim() || hersteller.bestellWebseite?.trim())
}

/** Labels and context of the order mail (the domain stays i18n-free). */
export interface BestelloptionTextOptionen {
  quartal: number
  jahr: number
  inventurDatum: IsoDatum | null
  inventurKuerzel: string | null
  locale: string
  titel: string
  inventurLabel: string
  kopfArtikel: string
  kopfGroesse: string
  kopfMenge: string
  kopfBestellnummer: string
  gesamtLabel: string
}

/**
 * Renders the order of one supplier as aligned plain text.
 *
 * The supplier needs the article title, the size, the quantity and the
 * order number of the article — the capacity alone is not enough to identify
 * the battery.
 */
export function bestelloptionText(
  option: Bestelloption,
  optionen: BestelloptionTextOptionen,
): string {
  const { locale } = optionen

  const tabelle = option.zeilen.map((zeile) => [
    zeile.artikelTitel,
    formatKapazitaetBereich(zeile.von, zeile.bis, locale),
    formatZahl(zeile.menge, locale),
    zeile.bestellnummer ?? '—',
  ])

  const breite = (werte: readonly string[]): number =>
    werte.reduce((max, wert) => Math.max(max, wert.length), 0)

  const breiteArtikel = breite([optionen.kopfArtikel, ...tabelle.map((z) => z[0] ?? '')])
  const breiteGroesse = breite([optionen.kopfGroesse, ...tabelle.map((z) => z[1] ?? '')])
  const breiteMenge = breite([optionen.kopfMenge, ...tabelle.map((z) => z[2] ?? '')])

  const inventurDatum = optionen.inventurDatum ? formatDatum(optionen.inventurDatum, locale) : '—'
  const inventurKuerzel = optionen.inventurKuerzel ? ` (${optionen.inventurKuerzel})` : ''

  const zeilenText = tabelle.map((zeile) =>
    [
      (zeile[0] ?? '').padEnd(breiteArtikel),
      (zeile[1] ?? '').padEnd(breiteGroesse),
      (zeile[2] ?? '').padEnd(breiteMenge),
      zeile[3] ?? '',
    ].join('  '),
  )

  return [
    `${optionen.titel} – Q${optionen.quartal} ${optionen.jahr}`,
    `${optionen.inventurLabel}: ${inventurDatum}${inventurKuerzel}`,
    '',
    [
      optionen.kopfArtikel.padEnd(breiteArtikel),
      optionen.kopfGroesse.padEnd(breiteGroesse),
      optionen.kopfMenge.padEnd(breiteMenge),
      optionen.kopfBestellnummer,
    ].join('  '),
    ...zeilenText,
    '',
    `${optionen.gesamtLabel}: ${formatZahl(option.gesamtMenge, locale)}`,
  ].join('\n')
}
