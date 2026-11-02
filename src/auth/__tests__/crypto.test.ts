// Tests for the crypto helpers used by the offline auth cache.
//
// Core point: SubtleCrypto (PBKDF2) only exists in secure browser contexts
// (HTTPS / http://localhost). On http://<IP> crypto.subtle is undefined — the
// helpers must then throw a named error (WebCryptoFehltError) instead of
// "TypeError: Cannot read properties of undefined".

import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebCryptoFehltError, hasheText, verifiziereText, webCryptoVerfuegbar } from '../crypto'

function getRandomValuesStub(arr: Uint8Array): Uint8Array {
  for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 13) % 256
  return arr
}

const fakeSubtle = {
  importKey: async (_format: unknown, keyData: Uint8Array): Promise<{ bytes: Uint8Array }> => ({
    bytes: keyData,
  }),
  deriveBits: async (_algo: unknown, key: { bytes: Uint8Array }): Promise<ArrayBuffer> => {
    const out = new Uint8Array(32)
    for (let i = 0; i < out.length; i++) {
      out[i] = ((key.bytes[i % key.bytes.length] ?? 0) + i) % 256
    }
    return out.buffer
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('webCryptoVerfuegbar', () => {
  it('ist false, wenn crypto.subtle fehlt (plain HTTP auf einer IP)', () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub })
    expect(webCryptoVerfuegbar()).toBe(false)
  })

  it('ist true, wenn subtle vorhanden ist', () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub, subtle: fakeSubtle })
    expect(webCryptoVerfuegbar()).toBe(true)
  })
})

describe('hasheText ohne SubtleCrypto', () => {
  it('wirft einen benannten Fehler statt eines TypeError', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub })
    await expect(hasheText('geheim')).rejects.toBeInstanceOf(WebCryptoFehltError)
  })

  it('verifiziereText wirft denselben benannten Fehler', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub })
    await expect(verifiziereText('geheim', '00', '00', 1000)).rejects.toBeInstanceOf(
      WebCryptoFehltError,
    )
  })
})

describe('hasheText mit SubtleCrypto', () => {
  it('liefert Hash + Salt und verifiziert das Passwort', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub, subtle: fakeSubtle })
    const ergebnis = await hasheText('geheim')
    expect(ergebnis.hash).toHaveLength(64)
    expect(ergebnis.salt).toHaveLength(128)
    await expect(
      verifiziereText('geheim', ergebnis.hash, ergebnis.salt, ergebnis.iterations),
    ).resolves.toBe(true)
    await expect(
      verifiziereText('falsch', ergebnis.hash, ergebnis.salt, ergebnis.iterations),
    ).resolves.toBe(false)
  })
})
