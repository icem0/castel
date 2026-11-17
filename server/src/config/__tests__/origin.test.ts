// Tests for the .env origin helpers.
//
// A deployer who types only the bare domain must never get a hard config error
// (`z.string().url()` used to reject a schemeless value and exit the process),
// so both normalisation branches are covered exhaustively.

import { describe, expect, it } from 'vitest'
import { isLanOrigin, normaliseOrigin } from '../origin.js'

describe('normaliseOrigin', () => {
  it('keeps an explicit scheme untouched', () => {
    expect(normaliseOrigin('https://castel.example.com')).toBe('https://castel.example.com')
    expect(normaliseOrigin('http://localhost:4280')).toBe('http://localhost:4280')
    expect(normaliseOrigin('http://192.168.1.10:4242')).toBe('http://192.168.1.10:4242')
  })

  it('assumes https for a bare domain', () => {
    expect(normaliseOrigin('castel.example.com')).toBe('https://castel.example.com')
    expect(normaliseOrigin('www.castel.example.com:8443')).toBe('https://www.castel.example.com:8443')
    expect(normaliseOrigin('  example.de  ')).toBe('https://example.de')
  })

  it('assumes http for dev/LAN origins', () => {
    expect(normaliseOrigin('localhost:4280')).toBe('http://localhost:4280')
    expect(normaliseOrigin('127.0.0.1:4280')).toBe('http://127.0.0.1:4280')
    expect(normaliseOrigin('192.168.1.10')).toBe('http://192.168.1.10')
  })

  it('drops a trailing slash (CORS matches exactly)', () => {
    expect(normaliseOrigin('https://castel.example.com/')).toBe('https://castel.example.com')
    expect(normaliseOrigin('castel.example.com/')).toBe('https://castel.example.com')
  })

  it('tolerates leading slashes and an empty value', () => {
    expect(normaliseOrigin('//castel.example.com')).toBe('https://castel.example.com')
    expect(normaliseOrigin('')).toBe('')
    expect(normaliseOrigin('   ')).toBe('')
  })

  it('leaves other schemes alone', () => {
    expect(normaliseOrigin('https://cdn.example.com/api')).toBe('https://cdn.example.com/api')
  })
})

describe('isLanOrigin', () => {
  it('ignores the scheme', () => {
    expect(isLanOrigin('http://localhost:4280')).toBe(true)
    expect(isLanOrigin('https://localhost:4280')).toBe(true)
  })

  it('recognises IP addresses with and without port', () => {
    expect(isLanOrigin('192.168.0.129')).toBe(true)
    expect(isLanOrigin('http://192.168.1.10:4242')).toBe(true)
  })

  it('rejects real domains', () => {
    expect(isLanOrigin('castel.example.com')).toBe(false)
    expect(isLanOrigin('https://2025.example.com')).toBe(false)
    expect(isLanOrigin('')).toBe(false)
  })
})
