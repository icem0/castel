// Tests for the AuthError → i18n mapping used by the login flow.
//
// The auth store throws AuthError with a stable `code`. The view translates
// that code into a localised message via authFehlerText(). These tests
// guarantee that:
//   - all known codes resolve to a non-empty translated string
//   - the active locale (de-DE / en-US) is respected
//   - raw fetch / DNS error strings (e.g. "Failed to fetch",
//     "getaddrinfo ENOTFOUND db") are NOT leaked to the user

import { describe, it, expect } from 'vitest'
import { i18n } from '../../i18n'
import { AuthError, isAuthError, type AuthErrorCode } from '../errors'
import { authFehlerText, authFehlerTextFuerCode } from '../messages'

const ALL_CODES: AuthErrorCode[] = [
  'auth.email.required',
  'auth.password.required',
  'auth.server.unreachable',
  'auth.offline.no_cache',
  'auth.cache.lost',
  'auth.jwt.missing',
  'auth.jwt.expired',
  'auth.network',
  'auth.unknown',
]

function setLocale(loc: 'de-DE' | 'en-US'): void {
  i18n.global.locale.value = loc
}

describe('AuthError', () => {
  it('exposes its code', () => {
    const e = new AuthError('auth.jwt.expired', 'JWT abgelaufen')
    expect(e.code).toBe('auth.jwt.expired')
    expect(e.message).toBe('JWT abgelaufen')
    expect(e.name).toBe('AuthError')
    expect(isAuthError(e)).toBe(true)
  })

  it('isAuthError returns false for non-AuthError values', () => {
    expect(isAuthError(null)).toBe(false)
    expect(isAuthError(new Error('boom'))).toBe(false)
    expect(isAuthError('boom')).toBe(false)
    expect(isAuthError({ message: 'boom' })).toBe(false)
  })
})

describe('authFehlerText / authFehlerTextFuerCode (de-DE)', () => {
  it('translates every known code to a German sentence', () => {
    setLocale('de-DE')
    for (const code of ALL_CODES) {
      const text = authFehlerTextFuerCode(code)
      expect(text).toBeTruthy()
      expect(text).not.toBe(code)
      // Sanity: nothing technical like "ENOTFOUND" should leak here.
      expect(text.toLowerCase()).not.toContain('enotfound')
      expect(text.toLowerCase()).not.toContain('getaddrinfo')
    }
  })

  it('maps AuthError instances to the active locale', () => {
    setLocale('de-DE')
    const text = authFehlerText(new AuthError('auth.offline.no_cache', 'fallback'))
    expect(text).toMatch(/Offline-Login nicht möglich/)
    expect(text.toLowerCase()).not.toContain('enotfound')
  })
})

describe('authFehlerText / authFehlerTextFuerCode (en-US)', () => {
  it('translates every known code to an English sentence', () => {
    setLocale('en-US')
    for (const code of ALL_CODES) {
      const text = authFehlerTextFuerCode(code)
      expect(text).toBeTruthy()
      expect(text).not.toBe(code)
      expect(text.toLowerCase()).not.toContain('enotfound')
      expect(text.toLowerCase()).not.toContain('getaddrinfo')
    }
  })

  it('maps AuthError instances to English when locale is en-US', () => {
    setLocale('en-US')
    const text = authFehlerText(new AuthError('auth.jwt.expired', 'fallback'))
    expect(text.toLowerCase()).toContain('session expired')
  })
})

describe('authFehlerText (sanitisation)', () => {
  it('does not leak raw fetch errors to the user', () => {
    setLocale('de-DE')
    // TypeError thrown by the browser when fetch() fails, e.g. after a
    // "getaddrinfo ENOTFOUND db" inside the API container's reverse proxy.
    const t = new TypeError('Failed to fetch')
    const text = authFehlerText(t)
    expect(text.toLowerCase()).not.toContain('failed to fetch')
    // The German network message should be shown instead.
    expect(text.toLowerCase()).toMatch(/server nicht erreichbar/)
  })

  it('does not leak raw Node-style DNS strings', () => {
    setLocale('en-US')
    const e = new Error('getaddrinfo ENOTFOUND db')
    const text = authFehlerText(e)
    expect(text.toLowerCase()).not.toContain('enotfound')
    expect(text.toLowerCase()).not.toContain('getaddrinfo')
    expect(text.toLowerCase()).toMatch(/server unreachable/)
  })

  it('returns a sensible string for unknown error shapes', () => {
    setLocale('de-DE')
    expect(authFehlerText(undefined)).toMatch(/server nicht erreichbar/i)
    expect(authFehlerText('boom')).toMatch(/server nicht erreichbar/i)
  })
})
