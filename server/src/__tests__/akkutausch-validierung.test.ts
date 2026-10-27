// Tests für die serverseitige Validierung der globalen Einstellung
// `akkuTypen` (Akkutausch: konfigurierte Akku-Größen).
//
// Kernpunkte:
//   * Der Wert ist ein JSON-Array mit den Akku-Größen.
//   * Kaputter JSON-Wert / kaputte Einträge werden abgelehnt, nicht gespeichert.
//   * Überlappende Kapazitätsbereiche sind ungültig.

import { describe, expect, it } from 'vitest'
import { parseAkkuTypenWert, pruefeTypen } from '../domain/akkutausch.js'

function typ(
  overrides: Partial<{ id: string; kapazitaetAh: number; von: number; bis: number }> = {},
) {
  return {
    id: 't1',
    kapazitaetAh: 1.2,
    von: 1.0,
    bis: 1.9,
    artikelId: null,
    ...overrides,
  }
}

describe('parseAkkuTypenWert', () => {
  it('akzeptiert eine gültige Liste', () => {
    const wert = JSON.stringify([typ()])
    const ergebnis = parseAkkuTypenWert(wert)
    expect(ergebnis.fehler).toEqual([])
    expect(ergebnis.typen).toHaveLength(1)
    expect(ergebnis.typen[0]?.id).toBe('t1')
  })

  it('lehnt kaputtes JSON ab', () => {
    expect(parseAkkuTypenWert('{kein json').fehler.length).toBeGreaterThan(0)
  })

  it('lehnt Werte ab, die keine Liste sind', () => {
    expect(parseAkkuTypenWert('{"a":1}').fehler.length).toBeGreaterThan(0)
  })

  it('lehnt Einträge ohne ID ab', () => {
    const wert = JSON.stringify([typ({ id: '' })])
    expect(parseAkkuTypenWert(wert).fehler.length).toBeGreaterThan(0)
  })

  it('lehnt Einträge mit ungültiger Kapazität ab', () => {
    const wert = JSON.stringify([{ id: 't1', kapazitaetAh: 'x', von: 1, bis: 2 }])
    expect(parseAkkuTypenWert(wert).fehler.length).toBeGreaterThan(0)
  })

  it('lehnt überlappende Bereiche ab', () => {
    const wert = JSON.stringify([
      typ({ id: 't1', von: 1, bis: 2, kapazitaetAh: 1.5 }),
      typ({ id: 't2', von: 1.5, bis: 2.5, kapazitaetAh: 2 }),
    ])
    const ergebnis = parseAkkuTypenWert(wert)
    expect(ergebnis.fehler.length).toBeGreaterThan(0)
    expect(ergebnis.fehler.join(' ')).toContain('überschneidet')
  })

  it('erlaubt angrenzende Bereiche', () => {
    const wert = JSON.stringify([
      typ({ id: 't1', von: 1, bis: 1.9, kapazitaetAh: 1.2 }),
      typ({ id: 't2', von: 2, bis: 2.9, kapazitaetAh: 2.5 }),
    ])
    expect(parseAkkuTypenWert(wert).fehler).toEqual([])
  })

  it('lehnt eine Nennkapazität außerhalb des Bereichs ab', () => {
    const wert = JSON.stringify([typ({ von: 1, bis: 1.9, kapazitaetAh: 5 })])
    expect(parseAkkuTypenWert(wert).fehler.length).toBeGreaterThan(0)
  })
})

describe('pruefeTypen (Server)', () => {
  it('akzeptiert gültige Bereiche', () => {
    expect(pruefeTypen([typ()])).toEqual([])
  })

  it('meldet ungültige Bereiche', () => {
    const fehler = pruefeTypen([typ({ von: 3, bis: 1 })])
    expect(fehler[0]?.code).toBe('ungueltiger_bereich')
  })
})
