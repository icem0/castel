import { describe, expect, it } from 'vitest'
import { stripEinkaufspreis } from '../sync/preise.js'

describe('stripEinkaufspreis', () => {
  const rows = [
    { id: 'a1', titel: 'Schraube', einkaufspreis: 1234 },
    { id: 'a2', titel: 'Mutter', einkaufspreis: null },
  ]

  it('keeps purchase prices for admins', () => {
    const result = stripEinkaufspreis(rows, true)
    expect(result[0]?.einkaufspreis).toBe(1234)
  })

  it('nulls purchase prices for non-admins without mutating input', () => {
    const result = stripEinkaufspreis(rows, false)
    expect(result.every((row) => row.einkaufspreis === null)).toBe(true)
    expect(rows[0]?.einkaufspreis).toBe(1234)
  })
})
