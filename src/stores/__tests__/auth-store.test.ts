// Tests for the auth store login flow in HTTP mode (without HTTPS).
//
// Regression (self-hosting on a LAN IP): the server answered 200, but the
// client broke with "Cannot read properties of undefined (reading
// 'importKey')" — crypto.subtle only exists in secure browser contexts. The
// login must not fail on that:
//   * without the opt-in → clear AuthError 'auth.insecure_context'
//   * with the opt-in    → login succeeds, only the offline cache is skipped

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))

vi.mock('../../auth/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../auth/api')>()
  return { ...original, apiFetch: apiFetchMock }
})

vi.mock('../../services/sync/worker', () => ({ checkDeviceReset: vi.fn() }))

import { useAuthStore } from '../auth'
import { credLesen } from '../../auth/session'

function getRandomValuesStub(arr: Uint8Array): Uint8Array {
  for (let i = 0; i < arr.length; i++) arr[i] = (i * 7 + 13) % 256
  return arr
}

const fakeSubtle = {
  importKey: async (): Promise<unknown> => ({ key: true }),
  deriveBits: async (): Promise<ArrayBuffer> => new Uint8Array(32).fill(7).buffer,
}

function jwtToken(): string {
  const payload = btoa(
    JSON.stringify({
      sub: 'u1',
      email: 'a@b.de',
      rolle: 'admin',
      rollen: ['admin'],
      berechtigungen: ['artikel.lesen', 'einkaufspreis', 'benutzer.verwalten'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signatur`
}

const LOGIN_ANTWORT = {
  token: jwtToken(),
  user: {
    id: 'u1',
    email: 'a@b.de',
    anzeigename: 'Test',
    rolle: 'admin' as const,
    rollen: ['admin'],
    berechtigungen: ['artikel.lesen', 'einkaufspreis', 'benutzer.verwalten'],
    mustChangePassword: false,
  },
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  apiFetchMock.mockReset()
  apiFetchMock.mockResolvedValue(LOGIN_ANTWORT)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anmelden im HTTP-Modus (kein Web Crypto)', () => {
  it('lehnt den Login ab, solange ALLOW_INSECURE_HTTP nicht gesetzt ist', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub })
    const store = useAuthStore()
    await expect(store.anmelden('a@b.de', 'geheim123')).rejects.toMatchObject({
      code: 'auth.insecure_context',
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('meldet sich an, wenn ALLOW_INSECURE_HTTP=true gesetzt ist', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub })
    vi.stubGlobal('__CASTEL_ALLOW_INSECURE_HTTP__', 'true')
    const store = useAuthStore()
    await expect(store.anmelden('a@b.de', 'geheim123')).resolves.toBeUndefined()
    expect(store.istAngemeldet).toBe(true)
    expect(store.userId).toBe('u1')
    // Without SubtleCrypto there is no PBKDF2 cache — the login still
    // succeeds (the cache is optional).
    expect(credLesen('a@b.de')).toBeNull()
  })
})

describe('anmelden mit Web Crypto', () => {
  it('schreibt den Credential-Cache für den Offline-Login', async () => {
    vi.stubGlobal('crypto', { getRandomValues: getRandomValuesStub, subtle: fakeSubtle })
    const store = useAuthStore()
    await store.anmelden('a@b.de', 'geheim123')
    expect(store.istAngemeldet).toBe(true)
    expect(credLesen('a@b.de')).not.toBeNull()
  })
})
