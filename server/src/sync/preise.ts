// Vertrauliche Preis-Felder im Sync.
//
// `einkaufspreis` ist der Netto-Einkaufspreis je Verpackungseinheit und
// darf ausschliesslich Admins erreichen. Der Snapshot-Endpoint strippt
// das Feld fuer alle anderen Rollen; der Push-Resolver ignoriert es
// entsprechend. Die Logik liegt hier zentral, damit sie testbar bleibt
// und Snapshot + Resolver nicht auseinanderlaufen.
//
// `hersteller.rabattsatz` (der durchschnittliche Lieferantenrabatt in
// Prozent) ist dieselbe Information in anderer Form: aus dem Listenpreis
// laesst sich der Einkaufspreis berechnen. Deshalb gilt fuer beide
// Felder dieselbe Regel — nur Admins sehen und schreiben sie.

export interface ArtikelPreisFeld {
  einkaufspreis?: number | null
}

export interface HerstellerRabattsatzFeld {
  rabattsatz: string | number | null
}

/**
 * Entfernt den Einkaufspreis aus Artikel-Rows fuer Nicht-Admins.
 * Admins erhalten die unveraenderte Row.
 *
 * Bewusst `null` statt `delete`: der Client spiegelt Artikel-Rows per
 * LWW. Ein explizites `null` ueberschreibt lokal noch vorhandene
 * Alt-Werte, sobald eine neuere Server-Version eintrifft.
 */
export function stripEinkaufspreis<T extends ArtikelPreisFeld>(
  rows: T[],
  istAdmin: boolean,
): T[] {
  if (istAdmin) return rows
  return rows.map((row) => ({ ...row, einkaufspreis: null }))
}

/**
 * Normalisiert die Hersteller-Rows fuer den Snapshot:
 *   * `rabattsatz` ist NUMERIC in Postgres — der Treiber liefert einen
 *     String ("20.00"). Der Client erwartet eine Zahl.
 *   * Nicht-Admins bekommen 0 (kein Rabatt bekannt). Das ueberschreibt
 *     lokal noch vorhandene Werte per LWW — dieselbe Wirkung wie das
 *     `null` beim Einkaufspreis.
 */
export function mappeHerstellerRabattsatz<T extends HerstellerRabattsatzFeld>(
  rows: readonly T[],
  istAdmin: boolean,
): Array<Omit<T, 'rabattsatz'> & { rabattsatz: number }> {
  return rows.map((row) => {
    const { rabattsatz, ...rest } = row
    if (!istAdmin) return { ...rest, rabattsatz: 0 }
    const wert = Number(rabattsatz ?? 0)
    return { ...rest, rabattsatz: Number.isFinite(wert) ? wert : 0 }
  })
}
