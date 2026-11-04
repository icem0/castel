// Unit tests for the inventory cut-off date helpers.
//
// Regression background: the settings form concatenated two number inputs into
// `MM-TT` without checking them. An untouched day produced `11-00`, the server
// rejected the op (`VALIDATION: Tag muss zwischen 1 und 31 liegen`) and the
// poisoned entry retried in the outbox. The helpers must therefore refuse
// incomplete and impossible dates and treat "both empty" as "clear the
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
  it('builds the canonical MM-TT value', () => {
    expect(stichtagAusTeilen(11, 15)).toEqual({ status: 'gueltig', wert: '11-15' })
    expect(stichtagAusTeilen(3, 5)).toEqual({ status: 'gueltig', wert: '03-05' })
    expect(stichtagAusTeilen('12', '31')).toEqual({ status: 'gueltig', wert: '12-31' })
  })

  it('reports both fields empty as "clear the setting"', () => {
    expect(stichtagAusTeilen('', '')).toEqual({ status: 'leer', wert: null })
    expect(stichtagAusTeilen(null, undefined)).toEqual({ status: 'leer', wert: null })
  })

  it('refuses a half-filled date instead of queueing 11-00', () => {
    expect(stichtagAusTeilen(11, '')).toEqual({ status: 'unvollstaendig', wert: null })
    expect(stichtagAusTeilen('', 15)).toEqual({ status: 'unvollstaendig', wert: null })
    expect(stichtagAusTeilen(11, null)).toEqual({ status: 'unvollstaendig', wert: null })
  })

  it('refuses values outside the calendar', () => {
    expect(stichtagAusTeilen(13, 1)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(11, 32)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(0, 0)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(11, 31)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(2, 30)?.status).toBe('ungueltig')
    expect(stichtagAusTeilen(2.5, 10)?.status).toBe('ungueltig')
  })
})

describe('istKalendertag', () => {
  it('accepts real dates including 29 February', () => {
    expect(istKalendertag(1, 1)).toBe(true)
    expect(istKalendertag(12, 31)).toBe(true)
    expect(istKalendertag(2, 29)).toBe(true)
  })

  it('rejects impossible combinations', () => {
    expect(istKalendertag(2, 30)).toBe(false)
    expect(istKalendertag(4, 31)).toBe(false)
    expect(istKalendertag(11, 0)).toBe(false)
    expect(istKalendertag(0, 11)).toBe(false)
  })
})

describe('parseInventurStichtag', () => {
  it('keeps a valid stored value', () => {
    expect(parseInventurStichtag('11-15')).toBe('11-15')
    expect(parseInventurStichtag(' 03-05 ')).toBe('03-05')
  })

  it('pads a one-digit month/day to the canonical form the server stores', () => {
    expect(parseInventurStichtag('3-5')).toBe('03-05')
  })

  it('drops empty and legacy-poisoned values', () => {
    expect(parseInventurStichtag('')).toBeNull()
    expect(parseInventurStichtag(null)).toBeNull()
    expect(parseInventurStichtag(undefined)).toBeNull()
    expect(parseInventurStichtag('11-00')).toBeNull()
    expect(parseInventurStichtag('00-11')).toBeNull()
    expect(parseInventurStichtag('2026-11-15')).toBeNull()
    expect(parseInventurStichtag('11.15')).toBeNull()
  })
})

describe('inventurStichtagTeile / inventurStichtagAnzeige', () => {
  it('splits a stored value into month and day', () => {
    expect(inventurStichtagTeile('11-15')).toEqual({ monat: 11, tag: 15 })
    expect(inventurStichtagTeile('11-00')).toBeNull()
  })

  it('renders the date the way users read it', () => {
    expect(inventurStichtagAnzeige('11-05')).toBe('05.11.')
    expect(inventurStichtagAnzeige('11-00')).toBeNull()
  })
})
