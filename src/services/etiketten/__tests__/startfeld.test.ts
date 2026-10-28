// Tests der Startfeld-Hilfen (Normalisierung + lokale Speicherung).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  LS_STARTFELD,
  ladeStartFeld,
  ladeStartFelder,
  normalisiereStartFeld,
  speichereStartFeld,
} from '../startfeld'

describe('etiketten/startfeld', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('normalisiert die Eingabe auf eine ganze Zahl im erlaubten Bereich', () => {
    expect(normalisiereStartFeld(7, 21)).toBe(7)
    expect(normalisiereStartFeld('7', 21)).toBe(7)
    expect(normalisiereStartFeld(7.9, 21)).toBe(7)
    expect(normalisiereStartFeld(0, 21)).toBe(1)
    expect(normalisiereStartFeld(-3, 21)).toBe(1)
    expect(normalisiereStartFeld(99, 21)).toBe(21)
    expect(normalisiereStartFeld('', 21)).toBe(1)
    expect(normalisiereStartFeld(Number.NaN, 21)).toBe(1)
  })

  it('speichert und laedt das Startfeld je Bogen-Layout', () => {
    expect(ladeStartFeld('21er')).toBe(1)
    speichereStartFeld('21er', 7)
    speichereStartFeld('30er', 13)
    expect(ladeStartFeld('21er')).toBe(7)
    expect(ladeStartFeld('30er')).toBe(13)
    expect(ladeStartFeld('12er')).toBe(1)
  })

  it('verträgt kaputte localStorage-Inhalte', () => {
    localStorage.setItem(LS_STARTFELD, 'kein json')
    expect(ladeStartFelder()).toEqual({})
    localStorage.setItem(LS_STARTFELD, '[]')
    expect(ladeStartFelder()).toEqual({})
    localStorage.setItem(LS_STARTFELD, '{"21er":"x"}')
    expect(ladeStartFelder()).toEqual({})
  })
})
