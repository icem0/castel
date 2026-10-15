import { describe, it, expect } from 'vitest'
import { useTableSort } from '../useTableSort'

interface Artikel {
  id: string
  titel: string
  typ: string
  bestand: number
}

const daten: Artikel[] = [
  { id: '1', titel: 'Bohrer', typ: 'Werkzeug', bestand: 5 },
  { id: '2', titel: 'Akkuschrauber', typ: 'Maschine', bestand: 1 },
  { id: '3', titel: 'Schraube', typ: 'Material', bestand: 100 },
]

describe('useTableSort', () => {
  it('startet im off-Modus, wenn kein defaultKey gesetzt', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    expect(s.sortKey.value).toBeNull()
    expect(s.sortDir.value).toBe('off')
    expect(s.istAktiv.value).toBe(false)
  })

  it('sortiere im off-Modus gibt die Reihenfolge unveraendert zurueck', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    const result = s.sortiere(daten)
    expect(result.map((d) => d.id)).toEqual(['1', '2', '3'])
  })

  it('sortiere gibt im off-Modus eine neue Array-Instanz zurueck (kein Sort-Call)', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    const result = s.sortiere(daten)
    expect(result).not.toBe(daten)
    expect(result).toEqual(daten)
  })

  it('Zyklus off -> asc -> desc -> off auf gleicher Spalte', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    s.onSort('titel')
    expect(s.sortKey.value).toBe('titel')
    expect(s.sortDir.value).toBe('asc')

    s.onSort('titel')
    expect(s.sortKey.value).toBe('titel')
    expect(s.sortDir.value).toBe('desc')

    s.onSort('titel')
    expect(s.sortKey.value).toBeNull()
    expect(s.sortDir.value).toBe('off')
  })

  it('Spaltenwechsel resettet auf asc', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      defaultKey: 'titel',
      defaultDir: 'desc',
      getValue: (a, k) => a[k],
    })
    expect(s.sortKey.value).toBe('titel')
    expect(s.sortDir.value).toBe('desc')

    s.onSort('typ')
    expect(s.sortKey.value).toBe('typ')
    expect(s.sortDir.value).toBe('asc')
  })

  it('sortiert Strings mit localeCompare (asc)', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    s.onSort('titel') // asc
    const result = s.sortiere(daten)
    expect(result.map((d) => d.titel)).toEqual(['Akkuschrauber', 'Bohrer', 'Schraube'])
  })

  it('sortiert Strings mit localeCompare (desc)', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    s.onSort('titel') // asc
    s.onSort('titel') // desc
    const result = s.sortiere(daten)
    expect(result.map((d) => d.titel)).toEqual(['Schraube', 'Bohrer', 'Akkuschrauber'])
  })

  it('sortiert Zahlen numerisch, nicht lexikographisch', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    s.onSort('bestand') // asc
    const result = s.sortiere(daten)
    expect(result.map((d) => d.bestand)).toEqual([1, 5, 100])
  })

  it('null und undefined landen immer am Ende (asc und desc)', () => {
    interface Item {
      id: string
      wert: number | null | undefined
    }
    const items: Item[] = [
      { id: 'a', wert: 3 },
      { id: 'b', wert: null },
      { id: 'c', wert: 1 },
      { id: 'd', wert: undefined },
      { id: 'e', wert: 2 },
    ]
    const s = useTableSort<Item, 'wert'>({ getValue: (i) => i.wert })
    s.onSort('wert') // asc
    expect(s.sortiere(items).map((i) => i.id)).toEqual(['c', 'e', 'a', 'b', 'd'])

    s.onSort('wert') // desc
    expect(s.sortiere(items).map((i) => i.id)).toEqual(['a', 'e', 'c', 'b', 'd'])
  })

  it('sortiert Booleans konsistent (false < true)', () => {
    interface Item {
      id: string
      aktiv: boolean
    }
    const items: Item[] = [
      { id: 'a', aktiv: true },
      { id: 'b', aktiv: false },
      { id: 'c', aktiv: true },
      { id: 'd', aktiv: false },
    ]
    const s = useTableSort<Item, 'aktiv'>({ getValue: (i) => i.aktiv })
    s.onSort('aktiv') // asc
    expect(s.sortiere(items).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c'])

    s.onSort('aktiv') // desc
    expect(s.sortiere(items).map((i) => i.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('defaultKey + defaultDir wird beim Erstellen uebernommen', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      defaultKey: 'bestand',
      defaultDir: 'desc',
      getValue: (a, k) => a[k],
    })
    expect(s.sortKey.value).toBe('bestand')
    expect(s.sortDir.value).toBe('desc')
    expect(s.istAktiv.value).toBe(true)
    const result = s.sortiere(daten)
    expect(result.map((d) => d.bestand)).toEqual([100, 5, 1])
  })

  it('sortiere mutiert das Input-Array nicht', () => {
    const s = useTableSort<Artikel, 'titel' | 'typ' | 'bestand'>({
      getValue: (a, k) => a[k],
    })
    s.onSort('titel') // asc
    const original = daten.map((d) => d.id)
    s.sortiere(daten)
    expect(daten.map((d) => d.id)).toEqual(original)
  })
})
