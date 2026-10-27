// Repair helpers for ragged CSV rows.
//
// Real-world exports of the device list are not always well-formed:
//
//   * a cell may contain an unescaped semicolon (`GmbH &amp; Co. KG`), which
//     splits the row into one column too many — every value behind it is
//     shifted and would be read into the wrong field;
//   * a column may be missing completely, so the row is one column short.
//
// Instead of aborting the whole import, the affected rows are realigned — but
// only when the result is unambiguous. A candidate is accepted when the
// repaired row parses cleanly; if several candidates would fit, the row is
// reported instead of guessed.

export interface ZeilenReparatur {
  /** Cells after the repair (same length as the header). */
  zellen: string[]
  /** Human-readable note about the applied repair. */
  hinweis: string
}

/**
 * Realigns a ragged row to the expected column count.
 *
 * `bewerte` scores a candidate alignment: it returns `null` when the
 * candidate is implausible (a mandatory field is missing or unparsable) and
 * a score otherwise — the higher the better. When several candidates share
 * the best score the row stays ambiguous and is reported instead of guessed.
 */
export function reparereZeile(
  zellen: string[],
  zielLaenge: number,
  bewerte: (zellen: string[]) => number | null,
  mergedErlaubt?: (spaltenIndex: number) => boolean,
): ZeilenReparatur | null {
  const diff = zellen.length - zielLaenge

  if (diff === 0) return { zellen, hinweis: '' }

  const kandidaten: Array<{ index: number; zellen: string[]; score: number; hinweis: string }> = []

  if (diff === 1) {
    // A trailing extra column: the first columns are already in place.
    const ohneLetzte = zellen.slice(0, zielLaenge)
    const scoreOhne = bewerte(ohneLetzte)
    if (scoreOhne !== null) {
      kandidaten.push({
        index: zellen.length - 1,
        zellen: ohneLetzte,
        score: scoreOhne,
        hinweis: 'überzählige Spalte am Zeilenende entfernt',
      })
    }

    // Two adjacent cells were probably split by an unescaped semicolon.
    for (let i = 0; i < zellen.length - 1; i++) {
      if (mergedErlaubt && !mergedErlaubt(i)) continue
      const merged = [
        ...zellen.slice(0, i),
        fuegeZusammen(zellen[i] ?? '', zellen[i + 1] ?? ''),
        ...zellen.slice(i + 2),
      ]
      if (merged.length !== zielLaenge) continue
      const score = bewerte(merged)
      if (score === null) continue
      kandidaten.push({
        index: i,
        zellen: merged,
        score,
        hinweis: `unmaskiertes ";" in Spalte ${i + 1} zusammengeführt`,
      })
    }
  } else if (diff === -1) {
    // One column is missing: try inserting an empty cell at every position.
    for (let i = 0; i <= zellen.length; i++) {
      const merged = [...zellen.slice(0, i), '', ...zellen.slice(i)]
      const score = bewerte(merged)
      if (score === null) continue
      kandidaten.push({
        index: i,
        zellen: merged,
        score,
        hinweis: `fehlende Spalte ${i + 1} ergänzt`,
      })
    }
  } else {
    return null
  }

  if (kandidaten.length === 0) return null

  const besterScore = Math.max(...kandidaten.map((k) => k.score))
  const beste = kandidaten.filter((k) => k.score === besterScore)
  if (beste.length !== 1) return null

  const treffer = beste[0]!
  return { zellen: treffer.zellen, hinweis: treffer.hinweis }
}

/**
 * Detects a header line where the first data row was glued to the last
 * column name (`…;Fälligkeit10020_02;OKA …`) — a common artefact of
 * copy-pasting or of exports without a line break.
 *
 * The repair is only applied when the header matches the known column order
 * of the device list; otherwise the original header is kept.
 */
export function repariereGeklebtenHeader(
  headers: string[],
  rows: string[][],
  kanonischeHeader: string[],
): { headers: string[]; ersteZeile: string[] | null; hinweis: string | null } {
  const unveraendert = { headers, ersteZeile: null, hinweis: null }

  if (rows.length === 0) return unveraendert

  const mode = haeufigsteLaenge(rows)
  if (mode === headers.length) return unveraendert
  if (mode !== kanonischeHeader.length) return unveraendert
  // Header line + glued first data row: 11 names + 11 values = 21 fields.
  if (headers.length !== 2 * mode - 1) return unveraendert

  // The names before the glued one have to match the known order.
  for (let i = 0; i < mode - 1; i++) {
    if (normalisiereName(headers[i] ?? '') !== normalisiereName(kanonischeHeader[i] ?? '')) {
      return unveraendert
    }
  }

  const geklebt = headers[mode - 1] ?? ''
  const name = kanonischeHeader[mode - 1] ?? ''
  if (!geklebt.toLowerCase().startsWith(name.toLowerCase())) return unveraendert

  const ersterWert = geklebt.slice(name.length)
  if (!ersterWert) return unveraendert

  const ersteZeile = [ersterWert, ...headers.slice(mode)]
  if (ersteZeile.length !== mode) return unveraendert

  return {
    headers: [...headers.slice(0, mode - 1), name],
    ersteZeile,
    hinweis: 'Header und erste Datenzeile waren zusammengeklebt — korrigiert.',
  }
}

/**
 * Joins two cells that were split by an unescaped semicolon.
 *
 * The CSV parser trims every cell, so a space that separated two words is
 * lost when the cell is cut in half (`GmbH &amp; Co. KG` becomes
 * `GmbH &amp` + `Co. KG`). When both halves end/start with a word character
 * the space is restored.
 */
function fuegeZusammen(a: string, b: string): string {
  if (!a || !b) return `${a};${b}`
  const trenntWort = /[\p{L}\p{N}]$/u.test(a) && /^[\p{L}]/u.test(b)
  return trenntWort ? `${a}; ${b}` : `${a};${b}`
}

/** Most common row length of the given rows. Ties are resolved by the shorter length. */ export function haeufigsteLaenge(
  rows: string[][],
): number {
  const zaehler = new Map<number, number>()
  for (const row of rows) {
    zaehler.set(row.length, (zaehler.get(row.length) ?? 0) + 1)
  }
  let bestLaenge = 0
  let bestAnzahl = 0
  for (const [laenge, anzahl] of zaehler) {
    if (anzahl > bestAnzahl || (anzahl === bestAnzahl && laenge < bestLaenge)) {
      bestLaenge = laenge
      bestAnzahl = anzahl
    }
  }
  return bestLaenge
}

/** Lower-case, umlaut-free comparison of two column names. */
export function normalisiereName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}
