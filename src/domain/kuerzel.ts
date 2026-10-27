// Initials ("Kuerzel") of a display name, shown next to the "bestellt"
// marker of a Mindestbestand alarm (e.g. "Max Mustermann" -> "MM").

/**
 * Derives up to two uppercase initials from a display name.
 *
 * - `"Max Mustermann"` -> `"MM"` (first + last word)
 * - `"Lager"` -> `"LA"` (first two letters of the single word)
 * - `""` / `null` / whitespace -> `"?"`
 */
export function kuerzelAusName(name: string | null | undefined): string {
  const parts = (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return '?'
  if (parts.length === 1) {
    return Array.from(parts[0]!).slice(0, 2).join('').toUpperCase()
  }
  const first = Array.from(parts[0]!)[0] ?? ''
  const last = Array.from(parts[parts.length - 1]!)[0] ?? ''
  return (first + last).toUpperCase()
}
