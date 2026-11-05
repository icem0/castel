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
  it('accepts a real calendar date DD.MM.YYYY', () => {
    expect(pruefeInventurStichtag('04.11.2026')).toBeNull()
    expect(pruefeInventurStichtag('01.01.2026')).toBeNull()
    expect(pruefeInventurStichtag('31.12.2026')).toBeNull()
    expect(pruefeInventurStichtag('29.02.2024')).toBeNull()
  })

  it('accepts the empty value: it clears the setting (not set)', () => {
    expect(pruefeInventurStichtag('')).toBeNull()
  })

  it('rejects an incomplete day/month/year (the value that poisoned the outbox)', () => {
    expect(pruefeInventurStichtag('00.11.2026')).toMatch(/Tag muss zwischen 1 und 31 liegen/)
    expect(pruefeInventurStichtag('11.00.2026')).toMatch(/Monat muss zwischen 1 und 12 liegen/)
    expect(pruefeInventurStichtag('11.11.0000')).toMatch(/Jahr muss zwischen 1 und 9999 liegen/)
  })

  it('rejects anything that is not DD.MM.YYYY', () => {
    expect(pruefeInventurStichtag('2026-11-04')).toMatch(/Format DD.MM.YYYY/)
    expect(pruefeInventurStichtag('4.11.2026')).toMatch(/Format DD.MM.YYYY/)
    expect(pruefeInventurStichtag('11-04')).toMatch(/Format DD.MM.YYYY/)
    expect(pruefeInventurStichtag('11.04')).toMatch(/Format DD.MM.YYYY/)
    expect(pruefeInventurStichtag('-11')).toMatch(/Format DD.MM.YYYY/)
    expect(pruefeInventurStichtag('garbage')).toMatch(/Format DD.MM.YYYY/)
  })

  it('rejects impossible day/month/year combinations', () => {
    expect(pruefeInventurStichtag('30.02.2026')).toMatch(/kein gültiges Kalenderdatum/)
    expect(pruefeInventurStichtag('31.04.2026')).toMatch(/kein gültiges Kalenderdatum/)
    expect(pruefeInventurStichtag('01.13.2026')).toMatch(/Monat muss zwischen 1 und 12 liegen/)
    expect(pruefeInventurStichtag('32.11.2026')).toMatch(/Tag muss zwischen 1 und 31 liegen/)
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
