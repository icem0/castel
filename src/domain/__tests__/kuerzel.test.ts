import { describe, expect, it } from 'vitest'
import { kuerzelAusName } from '../kuerzel'

describe('kuerzelAusName', () => {
  it('uses first and last word for multi-word names', () => {
    expect(kuerzelAusName('Max Mustermann')).toBe('MM')
    expect(kuerzelAusName('Max van der Berg')).toBe('MB')
  })

  it('uses the first two letters for a single word', () => {
    expect(kuerzelAusName('Lager')).toBe('LA')
    expect(kuerzelAusName('A')).toBe('A')
  })

  it('trims and collapses whitespace', () => {
    expect(kuerzelAusName('  Max   Mustermann  ')).toBe('MM')
  })

  it('returns "?" for empty or missing names', () => {
    expect(kuerzelAusName('')).toBe('?')
    expect(kuerzelAusName('   ')).toBe('?')
    expect(kuerzelAusName(null)).toBe('?')
    expect(kuerzelAusName(undefined)).toBe('?')
  })

  it('uppercases lowercase input', () => {
    expect(kuerzelAusName('max mustermann')).toBe('MM')
  })
})
