// Tests der Rabatt-Logik: Listenpreis + Ø-Rabatt des Lieferanten -> EK.
//
// Einheit durchgaengig Cent (Ganzzahl) — wie `artikel.listenpreis` und
// `artikel.einkaufspreis`.

import { describe, expect, it } from 'vitest'
import {
  berechneEinkaufspreisCent,
  normalisiereRabattsatz,
  rabattsatzVon,
  RABATT_MAX_PROZENT,
  RABATT_MIN_PROZENT,
} from '../rabatt'

describe('normalisiereRabattsatz', () => {
  it('laesst gueltige Werte unveraendert', () => {
    expect(normalisiereRabattsatz(0)).toBe(0)
    expect(normalisiereRabattsatz(12.5)).toBe(12.5)
    expect(normalisiereRabattsatz(100)).toBe(100)
  })

  it('klemmt Werte ausserhalb 0…100 %', () => {
    expect(normalisiereRabattsatz(-5)).toBe(RABATT_MIN_PROZENT)
    expect(normalisiereRabattsatz(120)).toBe(RABATT_MAX_PROZENT)
  })

  it('behandelt ungueltige Eingaben als 0', () => {
    expect(normalisiereRabattsatz(null)).toBe(0)
    expect(normalisiereRabattsatz(undefined)).toBe(0)
    expect(normalisiereRabattsatz(Number.NaN)).toBe(0)
  })
})

describe('rabattsatzVon', () => {
  it('liefert den Satz des Lieferanten', () => {
    expect(rabattsatzVon({ rabattsatz: 20 })).toBe(20)
  })

  it('liefert null, wenn kein Rabatt hinterlegt ist', () => {
    expect(rabattsatzVon({ rabattsatz: 0 })).toBeNull()
    expect(rabattsatzVon(null)).toBeNull()
    expect(rabattsatzVon(undefined)).toBeNull()
  })
})

describe('berechneEinkaufspreisCent', () => {
  it('rechnet Listenpreis minus Rabatt', () => {
    // 100,00 EUR - 20 % = 80,00 EUR
    expect(berechneEinkaufspreisCent(10000, 20)).toBe(8000)
    // 249 Cent - 20 % = 199.2 -> 199 Cent (kaufmaennisch gerundet)
    expect(berechneEinkaufspreisCent(249, 20)).toBe(199)
  })

  it('arbeitet mit Nachkommastellen im Rabattsatz', () => {
    expect(berechneEinkaufspreisCent(10000, 12.5)).toBe(8750)
  })

  it('liefert null ohne Rabatt — der EK bleibt dann manuell', () => {
    expect(berechneEinkaufspreisCent(10000, 0)).toBeNull()
    expect(berechneEinkaufspreisCent(10000, null)).toBeNull()
  })

  it('liefert null ohne Listenpreis', () => {
    expect(berechneEinkaufspreisCent(null, 20)).toBeNull()
    expect(berechneEinkaufspreisCent(undefined, 20)).toBeNull()
  })

  it('liefert 0 bei 100 % Rabatt', () => {
    expect(berechneEinkaufspreisCent(10000, 100)).toBe(0)
  })
})
