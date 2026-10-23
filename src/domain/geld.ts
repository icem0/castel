// Geld-Helfer.
//
// Preise liegen im Modell und in der API als Ganzzahl in Cent vor
// (siehe `artikel.listenpreis` / `artikel.einkaufspreis`). Die UI
// arbeitet in Euro. Zentrale Umrechnung, damit Formulare und Anzeigen
// nicht auseinanderlaufen.

/** Cent -> Euro (z. B. 1234 -> 12.34). */
export function centZuEuro(cent: number | null | undefined): number | null {
  if (cent === null || cent === undefined || !Number.isFinite(cent)) return null
  return cent / 100
}

/** Euro -> Cent, kaufmaennisch gerundet (z. B. 12.345 -> 1235). */
export function euroZuCent(euro: number | null | undefined): number | null {
  if (euro === null || euro === undefined || !Number.isFinite(euro)) return null
  return Math.round(euro * 100)
}

/** Formatiert einen Cent-Betrag als lokalisierte Waehrung. */
export function formatiereCent(
  cent: number | null | undefined,
  locale: string,
  waehrung = 'EUR',
): string {
  if (cent === null || cent === undefined || !Number.isFinite(cent)) return '—'
  return new Intl.NumberFormat(locale, { style: 'currency', currency: waehrung }).format(cent / 100)
}
