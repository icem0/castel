// Unit tests for the inventory setting validators.
//
// Regression background: the PWA used to build the cut-off date from two
// separate number inputs. Leaving the day empty produced `11-00`, the server
// rejected every push of that op (`VALIDATION: Tag muss zwischen 1 und 31
// liegen`) and the poisoned entry haunted the outbox. Two rules follow from
// that: an incomplete value must stay invalid, and an empty value must be
// accepted because it is the only way to clear the setting ("not set").

import { describe, expect, it } from 'vitest'
import { pruefeInventurStichtag, pruefeInventurVorlaufTage } from '../inventur.js'

describe('pruefeInventurStichtag', () => {
  it('accepts a real calendar date MM-TT', () => {
    expect(pruefeInventurStichtag('11-04')).toBeNull()
    expect(pruefeInventurStichtag('01-01')).toBeNull()
    expect(pruefeInventurStichtag('12-31')).toBeNull()
    expect(pruefeInventurStichtag('02-29')).toBeNull()
  })

  it('accepts the empty value: it clears the setting (not set)', () => {
    expect(pruefeInventurStichtag('')).toBeNull()
  })

  it('rejects an incomplete day (the value that poisoned the outbox)', () => {
    expect(pruefeInventurStichtag('11-00')).toMatch(/Tag muss zwischen 1 und 31 liegen/)
    expect(pruefeInventurStichtag('00-11')).toMatch(/Monat muss zwischen 1 und 12 liegen/)
  })

  it('rejects anything that is not MM-TT', () => {
    expect(pruefeInventurStichtag('2026-11-04')).toMatch(/Format MM-TT/)
    expect(pruefeInventurStichtag('1-4')).toMatch(/Format MM-TT/)
    expect(pruefeInventurStichtag('11.04')).toMatch(/Format MM-TT/)
    expect(pruefeInventurStichtag('-11')).toMatch(/Format MM-TT/)
    expect(pruefeInventurStichtag('garbage')).toMatch(/Format MM-TT/)
  })

  it('rejects impossible day/month combinations', () => {
    expect(pruefeInventurStichtag('02-30')).toMatch(/kein gültiges Kalenderdatum/)
    expect(pruefeInventurStichtag('04-31')).toMatch(/kein gültiges Kalenderdatum/)
    expect(pruefeInventurStichtag('13-01')).toMatch(/Monat muss zwischen 1 und 12 liegen/)
    expect(pruefeInventurStichtag('11-32')).toMatch(/Tag muss zwischen 1 und 31 liegen/)
  })
})

describe('pruefeInventurVorlaufTage', () => {
  it('accepts whole numbers between 0 and 365', () => {
    expect(pruefeInventurVorlaufTage('0')).toBeNull()
    expect(pruefeInventurVorlaufTage('14')).toBeNull()
    expect(pruefeInventurVorlaufTage('365')).toBeNull()
  })

  it('rejects everything else (never writes a poisoned value)', () => {
    expect(pruefeInventurVorlaufTage('')).toMatch(/ganze Zahl/)
    expect(pruefeInventurVorlaufTage('NaN')).toMatch(/ganze Zahl/)
    expect(pruefeInventurVorlaufTage('-1')).toMatch(/ganze Zahl/)
    expect(pruefeInventurVorlaufTage('366')).toMatch(/ganze Zahl/)
    expect(pruefeInventurVorlaufTage('1.5')).toMatch(/ganze Zahl/)
  })
})
