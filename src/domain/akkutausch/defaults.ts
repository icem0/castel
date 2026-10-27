// Default battery size ranges for the Akkutausch tool.
//
// The ladder covers the common small batteries in 1 Ah steps up to 12 Ah.
// The bands are deliberately non-overlapping and leave small gaps between
// them — a 1.9 Ah battery belongs to the 1.0-1.9 band, a 2.0 Ah battery to
// the 2.0-2.9 band.
//
// The nominal capacity of a default type is the lower bound of its band.

import type { AkkuTyp } from './types'

/** A default size without the fields that are assigned when it is created. */
export type AkkuTypVorschlag = Omit<AkkuTyp, 'id' | 'artikelId'>

/** Capacity bands (inclusive) offered by default. */
export const DEFAULT_AKKU_GROESSEN: readonly AkkuTypVorschlag[] = [
  { kapazitaetAh: 1.0, von: 1.0, bis: 1.9 },
  { kapazitaetAh: 2.0, von: 2.0, bis: 2.9 },
  { kapazitaetAh: 3.0, von: 3.0, bis: 3.9 },
  { kapazitaetAh: 4.0, von: 4.0, bis: 4.9 },
  { kapazitaetAh: 5.0, von: 5.0, bis: 5.9 },
  { kapazitaetAh: 6.0, von: 6.0, bis: 6.9 },
  { kapazitaetAh: 7.0, von: 7.0, bis: 7.9 },
  { kapazitaetAh: 8.0, von: 8.0, bis: 8.9 },
  { kapazitaetAh: 9.0, von: 9.0, bis: 9.9 },
  { kapazitaetAh: 10.0, von: 10.0, bis: 10.9 },
  { kapazitaetAh: 11.0, von: 11.0, bis: 11.9 },
  { kapazitaetAh: 12.0, von: 12.0, bis: 12.9 },
]
