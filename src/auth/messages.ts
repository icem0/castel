// Maps AuthError.code to a localised message.
//
// vue-i18n's `t()` is a free function (i18n.global.t), so we don't need a
// component context — keep this helper framework-agnostic and easy to
// test. Fallback chain:
//   1. auth.error.<i18nKey>  — translated message in the active locale
//   2. error.message         — German fallback shipped with the error
//   3. error.code            — last resort, lets us spot missing translations
//
// We intentionally do NOT leak raw `e.message` from non-AuthError values
// (e.g. "Failed to fetch", "getaddrinfo ENOTFOUND db") — they are mapped
// to the generic `auth.error.network` bucket instead.

import { i18n } from '../i18n'
import { AuthError, isAuthError, type AuthErrorCode } from './errors'

const I18N_KEYS: Record<AuthErrorCode, string> = {
  'auth.email.required': 'auth.error.emailRequired',
  'auth.password.required': 'auth.error.passwordRequired',
  'auth.server.unreachable': 'auth.error.serverUnreachable',
  'auth.offline.no_cache': 'auth.error.offlineNoCache',
  'auth.cache.lost': 'auth.error.cacheLost',
  'auth.jwt.missing': 'auth.error.jwtMissing',
  'auth.jwt.expired': 'auth.error.jwtExpired',
  'auth.network': 'auth.error.network',
  'auth.unknown': 'auth.error.serverUnreachable',
}

export function authFehlerText(e: unknown): string {
  if (isAuthError(e)) {
    const key = I18N_KEYS[e.code]
    const translated = i18n.global.t(key)
    if (translated && translated !== key) return translated
    return e.message
  }
  // Anything that is NOT an AuthError reaching the UI is a programming
  // error or an unhandled network blip. Show a generic message in the
  // active locale rather than leaking a Node/DNS error string.
  return i18n.global.t('auth.error.network')
}

export function authFehlerTextFuerCode(code: AuthErrorCode): string {
  const key = I18N_KEYS[code]
  const translated = i18n.global.t(key)
  if (translated && translated !== key) return translated
  // Build a deterministic fallback so the UI always has *some* text.
  return new AuthError(code, code).message
}
