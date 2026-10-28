// Inventory cut-off detection for the Akkutausch tool.
//
// The stock is only meaningful when it was counted recently. The rule is:
// take the oldest inventory booking of a linked battery article that lies
// inside the last four weeks. An inventory run usually creates one booking
// per article/location; the oldest date marks the start (cut-off) and the
// initials of the bookings on that day identify who conducted it.
//
// Pure module: no Vue, no Dexie, no server imports.

import { kuerzelAusName } from '../kuerzel'
import type { InventurBuchung, InventurStatus } from './types'

/** Rolling window for a valid inventory (four weeks). */
export const INVENTUR_FENSTER_TAGE = 28

const TAG_MS = 24 * 60 * 60 * 1000

/** Returns the UTC calendar date (`YYYY-MM-DD`) of an ISO timestamp. */
function tagVon(iso: string): string | null {
  const zeit = Date.parse(iso)
  if (Number.isNaN(zeit)) return null
  return new Date(zeit).toISOString().slice(0, 10)
}

/** Returns today's UTC calendar date (`YYYY-MM-DD`). */
function tagVonDatum(datum: Date): string {
  return datum.toISOString().slice(0, 10)
}

/** Shifts a `YYYY-MM-DD` date by a number of days (UTC). */
function tagPlusTage(tag: string, tage: number): string {
  const jahr = Number(tag.slice(0, 4))
  const monat = Number(tag.slice(5, 7))
  const tagImMonat = Number(tag.slice(8, 10))
  return new Date(Date.UTC(jahr, monat - 1, tagImMonat) + tage * TAG_MS).toISOString().slice(0, 10)
}

/**
 * Determines the inventory cut-off for the battery articles.
 *
 * @param buchungen All known bookings (cancelled originals are ignored).
 * @param akkuArtikelIds Article IDs linked to a configured battery size.
 * @param jetzt Reference time (defaults to now; injectable for tests).
 */
export function ermittleInventurStatus(
  buchungen: readonly InventurBuchung[],
  akkuArtikelIds: Iterable<string>,
  jetzt: Date = new Date(),
): InventurStatus {
  const artikelIds = new Set(akkuArtikelIds)
  const heuteTag = tagVonDatum(jetzt)
  const grenzeTag = tagPlusTage(heuteTag, -INVENTUR_FENSTER_TAGE)

  const relevant: Array<{ tag: string; erstelltVon: string }> = []
  for (const buchung of buchungen) {
    if (buchung.typ !== 'inventur' || buchung.storno) continue
    if (!artikelIds.has(buchung.artikelId)) continue
    const tag = tagVon(buchung.erstelltAm)
    if (!tag) continue
    if (tag < grenzeTag || tag > heuteTag) continue
    relevant.push({ tag, erstelltVon: buchung.erstelltVon })
  }

  if (relevant.length === 0) {
    return { gueltig: false, datum: null, kuerzel: null, anzahlBuchungen: 0 }
  }

  const aeltesterTag = relevant.reduce(
    (min, eintrag) => (eintrag.tag < min ? eintrag.tag : min),
    relevant[0]!.tag,
  )
  const kuerzel = [
    ...new Set(
      relevant
        .filter((eintrag) => eintrag.tag === aeltesterTag)
        .map((eintrag) => kuerzelAusName(eintrag.erstelltVon)),
    ),
  ].sort()

  return {
    gueltig: true,
    datum: aeltesterTag,
    kuerzel: kuerzel.join(', '),
    anzahlBuchungen: relevant.length,
  }
}
