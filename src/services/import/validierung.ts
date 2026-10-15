// Validierung für den CSV-Import: prüft Mapping-Vollständigkeit,
// Pflichtfelder, Enum-Werte, sharePointId-Duplikate.

import type { ArtikelFeld, ArtikelMapping, WarenFeld, WarenMapping } from './mapping'

export interface ValidierungsProblem {
  /** Zeilenindex in der Quelldatei (0-basiert, ohne Header). */
  zeile: number
  /** Spaltenname (SharePoint-Header). */
  spalte?: string
  /** Problembeschreibung. */
  meldung: string
}

export interface ValidierungsErgebnis {
  ok: boolean
  probleme: ValidierungsProblem[]
}

/** Pflichtfelder, die in der Lager-CSV gemappt sein müssen. */
const PFLICHT_ARTIKEL: ArtikelFeld[] = ['titel', 'typ']

/** Pflichtfelder, die in der Warenfluss-CSV gemappt sein müssen. */
const PFLICHT_WAREN: WarenFeld[] = ['menge', 'artikelTitle']

export function validiereArtikelMapping(
  mapping: ArtikelMapping,
  rows: string[][],
  headers: string[],
): ValidierungsErgebnis {
  const probleme: ValidierungsProblem[] = []

  for (const pf of PFLICHT_ARTIKEL) {
    const gefunden = (Object.values(mapping) as Array<ArtikelFeld | null | undefined>).includes(pf)
    if (!gefunden) {
      probleme.push({
        zeile: -1,
        meldung: `Pflichtfeld "${pf}" ist nicht gemappt.`,
      })
    }
  }

  // Zeilenprüfung: Titel und Typ müssen befüllt sein.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    for (const h of headers) {
      const feld = mapping[h]
      if (!feld) continue
      if (feld === 'titel' || feld === 'typ') {
        const v = row[headers.indexOf(h)] ?? ''
        if (!v.trim()) {
          probleme.push({
            zeile: i,
            spalte: h,
            meldung: `Pflichtfeld "${feld}" ist in Zeile ${i + 2} leer.`,
          })
        }
      }
    }
  }

  // sharePointId-Duplikate.
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const headerId = headers.find((h) => mapping[h] === 'sharePointId')
    if (!headerId) continue
    const raw = row[headers.indexOf(headerId)] ?? ''
    const id = Number.parseInt(raw, 10)
    if (!Number.isFinite(id)) continue
    if (seen.has(id)) {
      probleme.push({
        zeile: i,
        spalte: headerId,
        meldung: `Doppelte sharePointId ${id} in Zeile ${i + 2}.`,
      })
    }
    seen.add(id)
  }

  return { ok: probleme.length === 0, probleme }
}

export function validiereWarenMapping(
  mapping: WarenMapping,
  rows: string[][],
  headers: string[],
): ValidierungsErgebnis {
  const probleme: ValidierungsProblem[] = []

  for (const pf of PFLICHT_WAREN) {
    const gefunden = (Object.values(mapping) as Array<WarenFeld | null | undefined>).includes(pf)
    if (!gefunden) {
      probleme.push({
        zeile: -1,
        meldung: `Pflichtfeld "${pf}" ist nicht gemappt.`,
      })
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const headerMenge = headers.find((h) => mapping[h] === 'menge')
    if (headerMenge) {
      const raw = row[headers.indexOf(headerMenge)] ?? ''
      const n = Number(raw.replace(/\./g, '').replace(',', '.'))
      if (!raw.trim() || !Number.isFinite(n)) {
        probleme.push({
          zeile: i,
          spalte: headerMenge,
          meldung: `Menge fehlt oder ist nicht parsebar in Zeile ${i + 2}.`,
        })
      }
    }
  }

  return { ok: probleme.length === 0, probleme }
}
