// Etiketten-Bogen-Vorlagen fuer den DIN-A4-Druck.
//
// Geometrie komplett in Millimetern (A4 = 210 x 297 mm).
//
// `layout`:
//   - 'raster'  → klassischer Label-Bogen: gleich grosse Etiketten in
//                  Spalten/Zeilen (jedes Etikett: Barcode + Artikelname).
//   - 'liste'   → eine Zeile je Artikel (Artikelname links, Barcode
//                  rechts) — die "aufgelistete" Variante fuer den
//                  Etikettenbogen ohne Stanzmasse.
//
// `marginX`/`marginY` = `null` bedeutet: der Block wird auf der Seite
// zentriert (aus Spalten/Zeilen/Etikettenmasse berechnet). Der
// Benutzer kann im "Benutzerdefiniert"-Modus feste Rande angeben, wenn
// der eigene Bogen einen asymmetrischen Aufdruck hat.

export const A4_BREITE_MM = 210
export const A4_HOEHE_MM = 297

export type EtikettLayout = 'raster' | 'liste'

export interface EtikettenPreset {
  id: string
  /** i18n-Key des Anzeigenamens (leer bei benutzerdefinierten Presets). */
  nameKey: string
  layout: EtikettLayout
  /** Spalten je Seite (Raster) bzw. 1 (Liste). */
  cols: number
  /** Zeilen je Seite. */
  rows: number
  /** Etikettenbreite in mm. */
  labelW: number
  /** Etikettenhoehe in mm. */
  labelH: number
  /** horizontaler Abstand zwischen den Etiketten in mm. */
  gapX: number
  /** vertikaler Abstand zwischen den Etiketten in mm. */
  gapY: number
  /** linker Rand in mm (null = zentriert). */
  marginX: number | null
  /** oberer Rand in mm (null = zentriert). */
  marginY: number | null
}

export const PRESET_21ER: EtikettenPreset = {
  id: '21er',
  nameKey: 'view.barcode.layout.preset21er',
  layout: 'raster',
  cols: 3,
  rows: 7,
  labelW: 63.5,
  labelH: 38.1,
  gapX: 2.5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

export const PRESET_30ER: EtikettenPreset = {
  id: '30er',
  nameKey: 'view.barcode.layout.preset30er',
  layout: 'raster',
  cols: 3,
  rows: 10,
  labelW: 63.5,
  labelH: 25.4,
  gapX: 2.5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

export const PRESET_12ER: EtikettenPreset = {
  id: '12er',
  nameKey: 'view.barcode.layout.preset12er',
  layout: 'raster',
  cols: 2,
  rows: 6,
  labelW: 99.1,
  labelH: 42.5,
  gapX: 5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

export const PRESET_8ER: EtikettenPreset = {
  id: '8er',
  nameKey: 'view.barcode.layout.preset8er',
  layout: 'raster',
  cols: 2,
  rows: 4,
  labelW: 99.1,
  labelH: 66,
  gapX: 5,
  gapY: 0,
  marginX: null,
  marginY: null,
}

export const PRESET_LISTE: EtikettenPreset = {
  id: 'liste',
  nameKey: 'view.barcode.layout.presetListe',
  layout: 'liste',
  cols: 1,
  rows: 40,
  labelW: 190,
  labelH: 6.2,
  gapX: 0,
  gapY: 0,
  marginX: null,
  marginY: null,
}

export const ETIKETTEN_PRESETS: EtikettenPreset[] = [
  PRESET_21ER,
  PRESET_30ER,
  PRESET_12ER,
  PRESET_8ER,
  PRESET_LISTE,
]

export const PRESET_ID_BENUTZERDEFINIERT = 'benutzerdefiniert'

/** Standardwerte des benutzerdefinierten Presets (Start aus dem 21er-Bogen). */
export function benutzerdefiniertesPreset(): EtikettenPreset {
  return {
    id: PRESET_ID_BENUTZERDEFINIERT,
    nameKey: '',
    layout: 'raster',
    cols: 3,
    rows: 7,
    labelW: 63.5,
    labelH: 38.1,
    gapX: 2.5,
    gapY: 0,
    marginX: null,
    marginY: null,
  }
}

export interface Rander {
  marginX: number
  marginY: number
}

/** Berechnet die tatsaechlichen Seitenraender (zentriert, falls nicht gesetzt). */
export function randPreset(p: EtikettenPreset): Rander {
  const belegtX = p.cols * p.labelW + (p.cols - 1) * p.gapX
  const belegtY = p.rows * p.labelH + (p.rows - 1) * p.gapY
  const marginX = p.marginX ?? Math.max(0, (A4_BREITE_MM - belegtX) / 2)
  const marginY = p.marginY ?? Math.max(0, (A4_HOEHE_MM - belegtY) / 2)
  return { marginX, marginY }
}

/** Anzahl Etiketten, die auf eine Seite passen. */
export function etikettenJeSeite(p: EtikettenPreset): number {
  return Math.max(1, p.cols * p.rows)
}

/** Anzahl Seiten fuer `anzahl` Etiketten. */
export function seitenAnzahl(anzahl: number, p: EtikettenPreset): number {
  if (anzahl <= 0) return 0
  return Math.ceil(anzahl / etikettenJeSeite(p))
}
