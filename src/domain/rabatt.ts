// Rabatt → Einkaufspreis (EK).
//
// Fachregel: Der "wahre Wert" eines Artikels ist der Netto-Einkaufspreis.
// Aus dem Listenpreis laesst er sich ueber den durchschnittlichen Rabatt
// des Lieferanten schaetzen:
//
//     EK = Listenpreis * (1 - Rabattsatz / 100)
//
// Beispiele: Listenpreis 100,00 EUR, Rabatt 20 % → EK 80,00 EUR.
//
// Einheit: Alle Geld-Werte in Cent (Ganzzahl) — wie `artikel.listenpreis`
// und `artikel.einkaufspreis`. Die UI rechnet in Euro und wandelt an der
// Formulargrenze um (siehe `domain/geld.ts`).
//
// Der Rabattsatz ist am Lieferanten (Hersteller) gepflegt und damit das
// fachliche Pendant zum Listenpreis: ohne Rabattsatz gibt es keinen
// automatisch erzeugten EK — der Admin trage ihn dann manuell ein.

/** Mindest- und Maximalwert eines Rabattsatzes in Prozent. */
export const RABATT_MIN_PROZENT = 0
export const RABATT_MAX_PROZENT = 100

/**
 * Normalisiert einen Rabattsatz: Nicht-Zahlen und Werte ausserhalb
 * 0…100 % werden auf 0 bzw. auf die Grenze geklemmt.
 */
export function normalisiereRabattsatz(rabattsatz: number | null | undefined): number {
  if (typeof rabattsatz !== 'number' || !Number.isFinite(rabattsatz)) return 0
  if (rabattsatz <= RABATT_MIN_PROZENT) return RABATT_MIN_PROZENT
  if (rabattsatz >= RABATT_MAX_PROZENT) return RABATT_MAX_PROZENT
  return rabattsatz
}

/**
 * Liefert den Rabattsatz eines Lieferanten — `null`, wenn kein Rabatt
 * hinterlegt ist (dann wird der EK nicht automatisch berechnet).
 */
export function rabattsatzVon(lieferant: { rabattsatz: number } | null | undefined): number | null {
  if (!lieferant) return null
  const satz = normalisiereRabattsatz(lieferant.rabattsatz)
  return satz > 0 ? satz : null
}

/**
 * Berechnet den Einkaufspreis (in Cent) aus dem Listenpreis (in Cent) und
 * dem Rabattsatz (in Prozent).
 *
 * `null` wird zurueckgegeben, wenn kein Rabatt hinterlegt ist oder der
 * Listenpreis fehlt — in beiden Faellen kann der EK nicht automatisch
 * erzeugt werden.
 */
export function berechneEinkaufspreisCent(
  listenpreisCent: number | null | undefined,
  rabattsatz: number | null | undefined,
): number | null {
  if (typeof listenpreisCent !== 'number' || !Number.isFinite(listenpreisCent)) return null
  if (listenpreisCent < 0) return null
  const satz = normalisiereRabattsatz(rabattsatz)
  if (satz <= 0) return null
  return Math.round((listenpreisCent * (100 - satz)) / 100)
}
