// Unit tests for the inventory cut-off date helpers.
//
// Regression background: the settings form concatenated inputs blindly into
// `DD.MM.YYYY`. An untouched field produced `00.11.2026`, the server rejected the op and
// the poisoned entry retried in the outbox. The helpers must therefore refuse
// incomplete and impossible dates and treat "all fields empty" as "clear the
// setting".

import { describe, expect, it } from 'vitest'
import {
  inventurStichtagAnzeige,
  inventurStichtagTeile,
  istKalendertag,
  parseInventurStichtag,
  stichtagAusTeilen,
} from '../inventur-stichtag'

describe('stichtagAusTeilen', () => {
  it('builds the canonical DD.MM.YYYY value', () => {
    expect(stichtagAusTeilen(15, 11, 2026)).toEqual({ status: 'gueltig', wert: '15.11.2026' })
    expect(stichtagAusTeilen(5, 3, 2026)).toEqual({ status: 'gueltig', wert: '05.03.2026' })
    expect(stichtagAusTeilen('31', '12', '2026')).toEqual({ status: 'gueltig', wert: '31.12.2026' })
  })

  it('reports all fields empty as "clear the setting"', () => {
    expect(stichtagAusTeilen('', '', '')).toEqual({ status: 'leer', wert: null })
    expect(stichtagAusTeilen(null, undefined, null)).toEqual({ status: 'leer', wert: null })
  })

  it('refuses a half-filled date instead of queueing poisoned values', () => {
    expect(stichtagAusTeilen(15, '', '')).toEqual({ status: 'unvollstaendig', wert: null })
    expect(stichtagAusTeilen('', 11, '')).toEqual({ status: 'unvollstaendig', wert: null })
    expect(stichtagAusTeilen('', '', 2026)).toEqual({ status: 'unvollstaendig', wert: null })
    expect(stichtagAusTeilen(15, null, 2026)).toEqual({ status: 'unvollstaendig', wert: null })
  })

  it('refuses values outside the calendar', () => {
    expect(stichtagAusTeilen(32, 11, 2026)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(15, 13, 2026)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(0, 0, 0)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(31, 2, 2026)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(30, 2, 2026)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(2.5, 10, 2026)?.status).toBe('ungueltig')
  })
})

describe('istKalendertag', () => {
  it('accepts real dates including 29 February', () => {
    expect(istKalendertag(1, 1, 2026)).toBe(true)
    expect(istKalendertag(31, 12, 2026)).toBe(true)
    expect(istKalendertag(29, 2, 2024)).toBe(true)
  })

  it('rejects impossible combinations', () => {
    expect(istKalendertag(30, 2, 2026)).toBe(false)
    expect(istKalendertag(31, 4, 2026)).toBe(false)
    expect(istKalendertag(0, 11, 2026)).toBe(false)
    expect(istKalendertag(11, 0, 2026)).toBe(false)
  })
})

describe('parseInventurStichtag', () => {
  it('keeps a valid stored value', () => {
    expect(parseInventurStichtag('15.11.2026')).toBe('15.11.2026')
    expect(parseInventurStichtag(' 05.03.2026 ')).toBe('05.03.2026')
  })

  it('pads a one-digit day/month to the canonical form the server stores', () => {
    expect(parseInventurStichtag('5.3.2026')).toBe('05.03.2026')
  })

  it('drops empty and legacy-poisoned values', () => {
    expect(parseInventurStichtag('')).toBeNull()
    expect(parseInventurStichtag(null)).toBeNull()
    expect(parseInventurStichtag(undefined)).toBeNull()
    expect(parseInventurStichtag('11-00')).toBeNull()
    expect(parseInventurStichtag('00-11')).toBeNull()
    expect(parseInventurStichtag('2026-11-15')).toBeNull()
    expect(parseInventurStichtag('11.15')).toBeNull()
    expect(parseInventurStichtag('11.11.2026')).toBe('11.11.2026')
  })
})

describe('inventurStichtagTeile / inventurStichtagAnzeige', () => {
  it('splits a stored value into day, month and year', () => {
    expect(inventurStichtagTeile('15.11.2026')).toEqual({ tag: 15, monat: 11, jahr: 2026 })
    expect(inventurStichtagTeile('11-00')).toBeNull()
  })

  it('renders the date the way users read it', () => {
    expect(inventurStichtagAnzeige('15.11.2026')).toBe('15.11.2026')
    expect(inventurStichtagAnzeige('11-00')).toBeNull()
  })
})
