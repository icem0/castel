// Vertrauliche Preis-Felder im Sync.
//
// `einkaufspreis` ist der Netto-Einkaufspreis je Verpackungseinheit und
// darf ausschliesslich Admins erreichen. Der Snapshot-Endpoint strippt
// das Feld fuer alle anderen Rollen; der Push-Resolver ignoriert es
// entsprechend. Die Logik liegt hier zentral, damit sie testbar bleibt
// und Snapshot + Resolver nicht auseinanderlaufen.

export interface ArtikelPreisFeld {
  einkaufspreis?: number | null
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
