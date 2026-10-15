// CSV-Parser-Wrapper um papaparse.
// Erkennt `;` vs. `,` automatisch, normalisiert Whitespace.
// Liefert ein typisiertes Ergebnis mit Header-Zeile und Datenzeilen.

import Papa from 'papaparse'

export interface ParsedCsv {
  /** Erkannter Trenner (';' oder ','). */
  delimiter: string
  /** Originale Header-Zeile, normalisiert. */
  headers: string[]
  /** Datenzeilen als Arrays gleicher Länge wie `headers`. */
  rows: string[][]
  /** Anzahl Datenzeilen (ohne Header). */
  rowCount: number
}

/**
 * Parst einen CSV-Text. Liefert die erste Wahl `delimiter` durch Sniffing
 * der ersten Zeile. Trim um Whitespace und Anführungszeichen.
 */
export function parseCsv(text: string): ParsedCsv {
  if (!text.trim()) {
    return { delimiter: ',', headers: [], rows: [], rowCount: 0 }
  }

  // Trenner-Sniff: erstes Vorkommen in der ersten nichtleeren Zeile.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ','

  const result = Papa.parse<string[]>(text.trim(), {
    delimiter,
    skipEmptyLines: 'greedy',
    transform: (v) => v.trim(),
  })

  const rowsAll = result.data.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''))
  const headers = (rowsAll[0] ?? []).map((h) => h.replace(/^"+|"+$/g, '').trim())
  const rows = rowsAll.slice(1).map((row) => row.map((cell) => cell.replace(/^"+|"+$/g, '').trim()))

  return { delimiter, headers, rows, rowCount: rows.length }
}
