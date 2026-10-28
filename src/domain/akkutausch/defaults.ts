// Default battery size ranges for the Akkutausch tool.
//
// The ladder follows the standard battery types (1.2, 2.3, 3.4, 5, 7.2, 9,
// 12, 18, 26, 45, 63 Ah). Each band is the capacity corridor that maps to
// the nominal type of that row.
//
// The source table lists 8.5-11 Ah for the 9 Ah type and 10-12.9 Ah for the
// 12 Ah type. Ranges must not overlap (the server rejects the whole setting
// otherwise), so the 9 Ah band is clipped at 9.9 Ah; the 12 Ah band keeps its
// 10-12.9 Ah corridor.

import type { AkkuTyp } from './types'

/** A default size without the fields that are assigned when it is created. */
export type AkkuTypVorschlag = Omit<AkkuTyp, 'id' | 'artikelId'>

/** Capacity bands (inclusive) offered by default. */
export const DEFAULT_AKKU_GROESSEN: readonly AkkuTypVorschlag[] = [
  { kapazitaetAh: 1.2, von: 1.0, bis: 1.9 },
  { kapazitaetAh: 2.3, von: 2.0, bis: 2.9 },
  { kapazitaetAh: 3.4, von: 3.0, bis: 3.9 },
  { kapazitaetAh: 5.0, von: 4.5, bis: 5.9 },
  { kapazitaetAh: 7.2, von: 7.0, bis: 7.9 },
  { kapazitaetAh: 9.0, von: 8.5, bis: 9.9 },
  { kapazitaetAh: 12.0, von: 10.0, bis: 12.9 },
  { kapazitaetAh: 18.0, von: 17.0, bis: 19.0 },
  { kapazitaetAh: 26.0, von: 22.0, bis: 28.0 },
  { kapazitaetAh: 45.0, von: 41.0, bis: 49.0 },
  { kapazitaetAh: 63.0, von: 60.0, bis: 69.0 },
]
