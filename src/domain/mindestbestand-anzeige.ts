// Display helper for the minimum-stock alarm list.
//
// `mindestbestand_ereignisse` is an append-only log: every booking that
// leaves the stock below the threshold writes another event. While the
// stock stays below the minimum, all those historical events are
// evaluated as "open" against the live stock, so the UI would show the
// same alarm repeatedly. Only the newest event per (article, location)
// is relevant for the user.

export interface AlarmPaar {
  ereignis: {
    artikelId: string
    standortId: string
  }
}

/**
 * Keeps only the newest event per (article, location).
 *
 * The input MUST be sorted newest first (as the store's `zeilen`
 * already are). Order of first appearance is preserved.
 */
export function neuesteJePaar<T extends AlarmPaar>(zeilen: readonly T[]): T[] {
  const gesehen = new Set<string>()
  const ergebnis: T[] = []
  for (const z of zeilen) {
    const schluessel = `${z.ereignis.artikelId}#${z.ereignis.standortId}`
    if (gesehen.has(schluessel)) continue
    gesehen.add(schluessel)
    ergebnis.push(z)
  }
  return ergebnis
}
