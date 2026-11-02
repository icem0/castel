import { describe, expect, it } from 'vitest'
import { neuesteJePaar } from '../mindestbestand-anzeige'

interface TestZeile {
  ereignis: {
    id: string
    artikelId: string
    standortId: string
    erstelltAm: string
  }
}

function zeile(id: string, artikelId: string, standortId: string, erstelltAm: string): TestZeile {
  return { ereignis: { id, artikelId, standortId, erstelltAm } }
}

describe('neuesteJePaar', () => {
  it('behält pro Artikel+Standort nur das neueste Ereignis', () => {
    const eingabe = [
      zeile('e-2', 'a-1', 's-1', '2026-11-02T09:46:36.000Z'),
      zeile('e-1', 'a-1', 's-1', '2026-10-30T14:58:47.000Z'),
    ]

    expect(neuesteJePaar(eingabe).map((z) => z.ereignis.id)).toEqual(['e-2'])
  })

  it('unterscheidet Standorte und Artikel', () => {
    const eingabe = [
      zeile('e-4', 'a-1', 's-1', '2026-11-02T09:46:36.000Z'),
      zeile('e-3', 'a-2', 's-1', '2026-11-01T09:00:00.000Z'),
      zeile('e-2', 'a-1', 's-2', '2026-10-31T09:00:00.000Z'),
      zeile('e-1', 'a-1', 's-1', '2026-10-30T09:00:00.000Z'),
    ]

    expect(neuesteJePaar(eingabe).map((z) => z.ereignis.id)).toEqual(['e-4', 'e-3', 'e-2'])
  })

  it('lässt eine leere Liste unverändert', () => {
    expect(neuesteJePaar([])).toEqual([])
  })
})
