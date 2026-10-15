// useTableSort — generischer Sortier-State fuer tabellarische Listen.
//
// Klick-Zyklus pro Spalte: off -> asc -> desc -> off.
// Wechsel auf eine andere Spalte startet bei 'asc'.
//
// In-Memory-State, pro Aufruf (= pro View) isoliert. Kein Persistieren
// in localStorage / IndexedDB: nach Route-Wechsel gilt der Default.

import { ref, type Ref, type ComputedRef, computed } from 'vue'

export type SortDir = 'asc' | 'desc' | 'off'

export interface UseTableSortOptions<T, K extends string> {
  defaultKey?: K
  defaultDir?: Exclude<SortDir, 'off'>
  getValue: (item: T, key: K) => unknown
}

export interface UseTableSortResult<T, K extends string> {
  sortKey: Ref<K | null>
  sortDir: Ref<SortDir>
  onSort: (key: K) => void
  sortiere: (items: readonly T[]) => T[]
  istAktiv: ComputedRef<boolean>
}

const NAECHSTER_DIR: Record<SortDir, SortDir> = {
  off: 'asc',
  asc: 'desc',
  desc: 'off',
}

export function useTableSort<T, K extends string>(
  opts: UseTableSortOptions<T, K>,
): UseTableSortResult<T, K> {
  const sortKey = ref<K | null>(null) as Ref<K | null>
  const sortDir = ref<SortDir>('off')

  if (opts.defaultKey) {
    sortKey.value = opts.defaultKey
    sortDir.value = opts.defaultDir ?? 'asc'
  }

  function onSort(key: K): void {
    if (sortKey.value !== key) {
      sortKey.value = key
      sortDir.value = 'asc'
      return
    }
    sortDir.value = NAECHSTER_DIR[sortDir.value]
    if (sortDir.value === 'off') {
      sortKey.value = null
    }
  }

  function vergleiche(a: unknown, b: unknown, asc: boolean): number {
    // null / undefined immer ans Ende, egal ob asc oder desc.
    const aLeer = a === null || a === undefined
    const bLeer = b === null || b === undefined
    if (aLeer && bLeer) return 0
    if (aLeer) return 1
    if (bLeer) return -1

    let cmp = 0
    if (typeof a === 'number' && typeof b === 'number') {
      cmp = a - b
    } else if (typeof a === 'boolean' && typeof b === 'boolean') {
      cmp = a === b ? 0 : a ? 1 : -1
    } else {
      const sa = String(a)
      const sb = String(b)
      cmp = sa.localeCompare(sb, undefined, { sensitivity: 'base', numeric: true })
    }
    return asc ? cmp : -cmp
  }

  function sortiere(items: readonly T[]): T[] {
    if (sortDir.value === 'off' || sortKey.value === null) {
      return items.slice()
    }
    const key = sortKey.value
    const asc = sortDir.value === 'asc'
    return items
      .slice()
      .sort((a, b) => vergleiche(opts.getValue(a, key), opts.getValue(b, key), asc))
  }

  const istAktiv = computed(() => sortKey.value !== null && sortDir.value !== 'off')

  return { sortKey, sortDir, onSort, sortiere, istAktiv }
}
