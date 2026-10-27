// (De-)Serialization of the global `akkuTypen` setting.
//
// The setting is stored as a JSON string in `einstellungen` (the same way
// `artikelTypen` and `kommissionen` are stored). Parsing is tolerant:
// malformed entries are dropped instead of breaking the whole app, mirroring
// the error tolerance of the other JSON settings.

import type { AkkuTyp } from './types'

/** Reads the setting value into a list of battery sizes. */
export function parseAkkuTypen(value: string): AkkuTyp[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const typen: AkkuTyp[] = []
  for (const eintrag of parsed) {
    if (!eintrag || typeof eintrag !== 'object') continue
    const roh = eintrag as Record<string, unknown>
    const id = typeof roh['id'] === 'string' ? roh['id'] : ''
    const kapazitaetAh = roh['kapazitaetAh']
    const von = roh['von']
    const bis = roh['bis']
    const artikelId = roh['artikelId']
    if (id === '') continue
    if (typeof kapazitaetAh !== 'number' || !Number.isFinite(kapazitaetAh)) continue
    if (typeof von !== 'number' || !Number.isFinite(von)) continue
    if (typeof bis !== 'number' || !Number.isFinite(bis)) continue
    typen.push({
      id,
      kapazitaetAh,
      von,
      bis,
      artikelId: typeof artikelId === 'string' && artikelId !== '' ? artikelId : null,
    })
  }
  return typen
}

/** Serializes the battery sizes for the `einstellungen` table. */
export function serialisiereAkkuTypen(typen: readonly AkkuTyp[]): string {
  return JSON.stringify(
    typen.map((typ) => ({
      id: typ.id,
      kapazitaetAh: typ.kapazitaetAh,
      von: typ.von,
      bis: typ.bis,
      artikelId: typ.artikelId,
    })),
  )
}
