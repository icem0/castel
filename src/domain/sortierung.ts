// Shared name sorting for drop-down lists and other visible collections.
// Uses the German collation so umlauts and numeric suffixes sort naturally.

export function vergleicheNachName(a: string, b: string): number {
  return a.localeCompare(b, 'de', { sensitivity: 'base', numeric: true })
}

export function sortiereNachName<T>(items: readonly T[], wert: (item: T) => string): T[] {
  return [...items].sort((a, b) => vergleicheNachName(wert(a), wert(b)))
}
