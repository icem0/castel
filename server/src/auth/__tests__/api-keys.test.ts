import { describe, expect, it } from 'vitest'
import {
  apiKeyAusRequest,
  generateApiKey,
  hashApiKey,
  hashesGleich,
  normalisiereScopes,
  scopeErlaubt,
  siehtAusWieApiKey,
} from '../api-keys.js'

function requestWithHeaders(headers: Record<string, string>) {
  return { headers } as never
}

describe('api-keys', () => {
  it('generates a prefixed key and stores only the hash', () => {
    const key = generateApiKey()
    expect(key.plaintext).toMatch(/^castel_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}$/)
    expect(key.prefix).toMatch(/^castel_[0-9a-f]{8}$/)
    expect(key.hash).toBe(hashApiKey(key.plaintext))
    expect(key.hash).toHaveLength(64)
    expect(key.plaintext).not.toContain(key.hash)
  })

  it('generates unique keys', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.plaintext).not.toBe(b.plaintext)
    expect(a.hash).not.toBe(b.hash)
  })

  it('recognises the key format', () => {
    expect(siehtAusWieApiKey(generateApiKey().plaintext)).toBe(true)
    expect(siehtAusWieApiKey('castel_short')).toBe(false)
    expect(siehtAusWieApiKey('nope')).toBe(false)
  })

  it('reads Bearer and X-API-Key headers', () => {
    const key = generateApiKey().plaintext
    expect(apiKeyAusRequest(requestWithHeaders({ authorization: `Bearer ${key}` }))).toBe(key)
    expect(apiKeyAusRequest(requestWithHeaders({ authorization: `bearer ${key}` }))).toBe(key)
    expect(apiKeyAusRequest(requestWithHeaders({ 'x-api-key': key }))).toBe(key)
  })

  it('rejects missing, malformed and query-style keys', () => {
    expect(apiKeyAusRequest(requestWithHeaders({}))).toBeNull()
    expect(apiKeyAusRequest(requestWithHeaders({ authorization: 'Bearer nope' }))).toBeNull()
    expect(apiKeyAusRequest(requestWithHeaders({ 'x-api-key': 'nope' }))).toBeNull()
  })

  it('normalises scopes and rejects unknown values', () => {
    expect(normalisiereScopes(['read', 'write', 'read'])).toEqual(['read', 'write'])
    expect(normalisiereScopes([])).toEqual([])
    expect(normalisiereScopes(['read', 'root'])).toBeNull()
    expect(normalisiereScopes('read')).toBeNull()
    expect(normalisiereScopes([1])).toBeNull()
  })

  it('admin implies read and write, write does not imply read', () => {
    expect(scopeErlaubt(['read'], 'read')).toBe(true)
    expect(scopeErlaubt(['read'], 'write')).toBe(false)
    expect(scopeErlaubt(['write'], 'read')).toBe(false)
    expect(scopeErlaubt(['write'], 'write')).toBe(true)
    expect(scopeErlaubt(['admin'], 'read')).toBe(true)
    expect(scopeErlaubt(['admin'], 'write')).toBe(true)
    expect(scopeErlaubt(['admin'], 'admin')).toBe(true)
    expect(scopeErlaubt(['read', 'write'], 'admin')).toBe(false)
  })

  it('compares hashes without leaking length differences', () => {
    const hash = hashApiKey('a')
    expect(hashesGleich(hash, hash)).toBe(true)
    expect(hashesGleich(hash, hashApiKey('b'))).toBe(false)
    expect(hashesGleich(hash, 'short')).toBe(false)
  })
})
