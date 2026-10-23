import { describe, expect, it } from 'vitest'
import { centZuEuro, euroZuCent, formatiereCent } from '../geld'

describe('geld', () => {
  it('converts cents to euros and back', () => {
    expect(centZuEuro(1234)).toBe(12.34)
    expect(euroZuCent(12.34)).toBe(1234)
    expect(euroZuCent(12.345)).toBe(1235)
    expect(euroZuCent(null)).toBeNull()
    expect(centZuEuro(undefined)).toBeNull()
  })

  it('formats cents as currency', () => {
    expect(formatiereCent(1234, 'de-DE')).toMatch(/12[.,]34/)
    expect(formatiereCent(null, 'de-DE')).toBe('—')
  })
})
