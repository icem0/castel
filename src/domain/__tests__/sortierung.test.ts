import { describe, expect, it } from 'vitest'
import { sortiereNachName, vergleicheNachName } from '../sortierung'

describe('sortierung', () => {
  it('sorts German names alphabetically and case-insensitively', () => {
    const items = [{ name: 'Zange' }, { name: 'apfel' }, { name: 'Öl' }, { name: 'Bohrer' }]
    expect(sortiereNachName(items, (i) => i.name).map((i) => i.name)).toEqual([
      'apfel',
      'Bohrer',
      'Öl',
      'Zange',
    ])
  })

  it('sorts numeric suffixes naturally', () => {
    const items = [{ name: 'Regal 10' }, { name: 'Regal 2' }, { name: 'Regal 1' }]
    expect(sortiereNachName(items, (i) => i.name).map((i) => i.name)).toEqual([
      'Regal 1',
      'Regal 2',
      'Regal 10',
    ])
  })

  it('does not mutate the input array', () => {
    const items = [{ name: 'B' }, { name: 'A' }]
    sortiereNachName(items, (i) => i.name)
    expect(items.map((i) => i.name)).toEqual(['B', 'A'])
  })

  it('compares umlauts as base letters', () => {
    expect(vergleicheNachName('Öl', 'Ol')).toBe(0)
  })
})
