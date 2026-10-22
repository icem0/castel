// Reine Geometrie fuer den Etiketten-Bogen — bewusst ohne jsPDF, damit die
// Seiten-/Positionberechnung testbar bleibt (und der PDF-Renderer nur noch
// zeichnen muss).
//
// Alle Masse in Millimetern, A4 = 210 x 297 mm.

import {
  A4_BREITE_MM,
  A4_HOEHE_MM,
  etikettenJeSeite,
  randPreset,
  type EtikettenPreset,
} from './presets'

export interface EtikettPosition {
  /** Seitenzahl (1-basiert). */
  seite: number
  /** Spalte auf der Seite (0-basiert). */
  spalte: number
  /** Zeile auf der Seite (0-basiert). */
  zeile: number
  /** linke obere Ecke in mm. */
  x: number
  /** linke obere Ecke in mm. */
  y: number
  /** Breite in mm. */
  w: number
  /** Hoehe in mm. */
  h: number
}

/**
 * Verteilt `anzahl` Etiketten auf die Seiten des Bogens.
 * Die Reihenfolge entspricht der Auswahl-Reihenfolge des Aufrufers.
 */
export function planeEtiketten(anzahl: number, p: EtikettenPreset): EtikettPosition[] {
  const out: EtikettPosition[] = []
  if (anzahl <= 0) return out
  const { marginX, marginY } = randPreset(p)
  const jeSeite = etikettenJeSeite(p)
  for (let i = 0; i < anzahl; i++) {
    const seite = Math.floor(i / jeSeite)
    const index = i % jeSeite
    const spalte = index % Math.max(1, p.cols)
    const zeile = Math.floor(index / Math.max(1, p.cols))
    out.push({
      seite: seite + 1,
      spalte,
      zeile,
      x: marginX + spalte * (p.labelW + p.gapX),
      y: marginY + zeile * (p.labelH + p.gapY),
      w: p.labelW,
      h: p.labelH,
    })
  }
  return out
}

/**
 * Prueft ein Preset auf plausible Werte. Liefert eine Liste von
 * Problemen (leer = alles ok). Der Aufrufer zeigt sie als Hinweis an.
 */
export function presetWarnungen(p: EtikettenPreset): string[] {
  const probleme: string[] = []
  if (!Number.isFinite(p.cols) || p.cols < 1) probleme.push('cols')
  if (!Number.isFinite(p.rows) || p.rows < 1) probleme.push('rows')
  if (!Number.isFinite(p.labelW) || p.labelW <= 0) probleme.push('labelW')
  if (!Number.isFinite(p.labelH) || p.labelH <= 0) probleme.push('labelH')
  if (probleme.length > 0) return probleme
  const { marginX, marginY } = randPreset(p)
  const belegtX = p.cols * p.labelW + (p.cols - 1) * p.gapX + 2 * marginX
  const belegtY = p.rows * p.labelH + (p.rows - 1) * p.gapY + 2 * marginY
  if (belegtX > A4_BREITE_MM + 0.01) probleme.push('zuBreit')
  if (belegtY > A4_HOEHE_MM + 0.01) probleme.push('zuHoch')
  return probleme
}
