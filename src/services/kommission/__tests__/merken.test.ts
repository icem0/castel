// Tests fuer die Merk-Logik der letzten Kommission (1 h, pro User).

import { afterEach, describe, expect, it } from 'vitest'
import {
  kommissionMerken,
  kommissionVergessen,
  letzteKommission,
  LS_KOMMISSION_ZULETZT,
  MERKDAUER_MS,
} from '../merken'

describe('kommissionMerken / letzteKommission', () => {
  afterEach(() => {
    kommissionVergessen()
    localStorage.removeItem(LS_KOMMISSION_ZULETZT)
  })

  it('merkt die Kommission und liefert sie sofort zurueck', () => {
    kommissionMerken('user-1', 'Projekt Mueller')
    expect(letzteKommission('user-1')).toBe('Projekt Mueller')
  })

  it('verwaehrt nach Ablauf der Stunde', () => {
    const start = Date.now()
    kommissionMerken('user-1', 'Alt', start)
    expect(letzteKommission('user-1', start + MERKDAUER_MS - 1000)).toBe('Alt')
    expect(letzteKommission('user-1', start + MERKDAUER_MS + 1000)).toBeNull()
  })

  it('verlaengert bei jeder Buchung (Sliding Window)', () => {
    const start = Date.now()
    kommissionMerken('user-1', 'Frisch', start)
    kommissionMerken('user-1', 'Frisch', start + MERKDAUER_MS - 1000)
    expect(letzteKommission('user-1', start + MERKDAUER_MS + 500)).toBe('Frisch')
  })

  it('User-wechsel auf demselben Geraet sieht die Merkung nicht', () => {
    kommissionMerken('user-1', 'Geheim')
    expect(letzteKommission('user-2')).toBeNull()
  })

  it('leerer Name ueberschreibt nichts', () => {
    kommissionMerken('user-1', 'Original')
    kommissionMerken('user-1', '   ')
    expect(letzteKommission('user-1')).toBe('Original')
  })

  it('vertraegt kaputte localStorage-Inhalte', () => {
    localStorage.setItem(LS_KOMMISSION_ZULETZT, 'kein json')
    expect(letzteKommission('user-1')).toBeNull()
    localStorage.setItem(LS_KOMMISSION_ZULETZT, '[]')
    expect(letzteKommission('user-1')).toBeNull()
    localStorage.setItem(LS_KOMMISSION_ZULETZT, JSON.stringify({ userId: 'x' }))
    expect(letzteKommission('user-1')).toBeNull()
  })

  it('kommissionVergessen loescht die Merkung', () => {
    kommissionMerken('user-1', 'Weg')
    kommissionVergessen()
    expect(letzteKommission('user-1')).toBeNull()
  })
})
