// Kommissionen: parsing and merge of the global `kommissionen` setting.
//
// The value is a JSON array of commission names (e.g. "Projekt Müller").
// The list is global. Admins maintain it completely (sorting, removing);
// every other user may only ADD to it. The server merges those contributions
// with the stored state (union), so a stale client can never empty the list.
//
// The merge is additive by design: a user can add entries but never remove
// them. Removing stays exclusive to the admin.

export interface KommissionenParseErgebnis {
  kommissionen: string[]
  /** Human readable problems — a non-empty list means the value is rejected. */
  fehler: string[]
}

/** Upper bound for the length of a commission name. */
export const MAX_KOMMISSION_LAENGE = 120

/** Upper bound for the number of commissions in the list. */
export const MAX_KOMMISSIONEN = 500

/**
 * Parses and validates the raw `kommissionen` setting value. Structural
 * problems (no JSON, no list, no text) are rejected — a broken value would
 * empty the list in every client. Empty names and duplicates are silently
 * dropped.
 */
export function parseKommissionenWert(value: string): KommissionenParseErgebnis {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { kommissionen: [], fehler: ['kommissionen ist kein gültiges JSON'] }
  }
  if (!Array.isArray(parsed)) {
    return { kommissionen: [], fehler: ['kommissionen muss eine Liste sein'] }
  }

  const kommissionen: string[] = []
  const fehler: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const eintrag = parsed[i]
    if (typeof eintrag !== 'string') {
      fehler.push(`kommissionen[${i}] ist kein Text`)
      continue
    }
    const name = eintrag.trim()
    if (name === '') continue
    if (name.length > MAX_KOMMISSION_LAENGE) {
      fehler.push(`kommissionen[${i}] ist zu lang`)
      continue
    }
    if (!kommissionen.includes(name)) kommissionen.push(name)
  }
  if (kommissionen.length > MAX_KOMMISSIONEN) {
    fehler.push(`kommissionen hat mehr als ${MAX_KOMMISSIONEN} Einträge`)
  }
  return { kommissionen, fehler }
}

/**
 * Tolerant parser for an already stored value: a broken legacy value
 * degrades to an empty list instead of throwing.
 */
export function parseGespeicherteKommissionen(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return parseKommissionenWert(value).kommissionen
}

/**
 * Union of two commission lists: the stored order comes first, new names
 * are appended. Used for the add-only merge of non-admin writes.
 */
export function mergeKommissionen(
  bestehend: readonly string[],
  eingehend: readonly string[],
): string[] {
  const vereinigt = [...bestehend]
  for (const name of eingehend) {
    if (!vereinigt.includes(name)) vereinigt.push(name)
  }
  return vereinigt
}
