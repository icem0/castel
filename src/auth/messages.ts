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
//
// ApiError is the exception: it means "the server DID answer, but with an
// error". "Server not reachable" would be doubly wrong there — the server was
// reachable, and the cause lives in the response. So for ApiError we show the
// server message or a code-specific text instead.

import { i18n } from '../i18n'
import { AuthError, isAuthError, type AuthErrorCode } from './errors'
import { ApiError, serverMeldung } from './api'

const I18N_KEYS: Record<AuthErrorCode, string> = {
  'auth.email.required': 'auth.error.emailRequired',
  'auth.password.required': 'auth.error.passwordRequired',
  'auth.server.unreachable': 'auth.error.serverUnreachable',
  'auth.offline.no_cache': 'auth.error.offlineNoCache',
  'auth.cache.lost': 'auth.error.cacheLost',
  'auth.jwt.missing': 'auth.error.jwtMissing',
  'auth.jwt.expired': 'auth.error.jwtExpired',
  'auth.network': 'auth.error.network',
  // Server hat den Passwort-Change explizit abgelehnt (z. B. "altes
  // Passwort falsch"). Die Message kommt vom Server, daher KEINE
  // i18n-Uebersetzung — nur AuthError.message wird durchgereicht.
  'auth.password.change_failed': 'auth.password.change_failed',
  // Runtime without HTTPS (no secure browser context): SubtleCrypto is
  // missing, and the login is refused until the operator enables HTTP mode
  // via ALLOW_INSECURE_HTTP.
  'auth.insecure_context': 'auth.error.insecureContext',
  // Server antwortet mit einem Auth-Fehler (z. B. 401 "falsches Passwort").
  // Message stammt direkt vom Server, daher KEINE i18n-Übersetzung —
  // AuthError.message wird durchgereicht.
  'auth.unknown': 'auth.unknown',
}

/**
 * Text for an ApiError — i.e. for a response where the server was actually
 * reachable. Known codes get a concrete text, everything else the server
 * message (or the HTTP status).
 */
export function apiFehlerText(e: ApiError): string {
  switch (e.code) {
    case 'VALIDATION':
      return i18n.global.t('auth.error.validation')
    case 'EMAIL_TAKEN':
      return i18n.global.t('auth.error.emailTaken')
    case 'RATE_LIMIT':
      return i18n.global.t('auth.error.rateLimit')
    default:
      break
  }
  const vomServer = serverMeldung(e)
  if (vomServer !== null) return vomServer
  return i18n.global.t('auth.error.apiFailed', { status: e.status })
}

export function authFehlerText(e: unknown): string {
  if (isAuthError(e)) {
    const key = I18N_KEYS[e.code]
    // Codes, deren Message direkt vom Server kommt (z. B. "Altes Passwort
    // falsch"): i18n-Lookup ueberspringen, einfach e.message anzeigen.
    // Das verhindert, dass ein generischer Auth-Bucket ("Server nicht
    // erreichbar") einen konkreten Server-Fehlertext ueberschreibt.
    if (key === e.code) return e.message
    const translated = i18n.global.t(key)
    if (translated && translated !== key) return translated
    return e.message
  }
  // The server did answer (with an error) — show the server's message,
  // NOT "server not reachable".
  if (e instanceof ApiError) return apiFehlerText(e)
  // Anything that is NOT an AuthError reaching the UI is a programming
  // error or an unhandled network blip. Show a generic message in the
  // active locale rather than leaking a Node/DNS error string.
  return i18n.global.t('auth.error.network')
}

export function authFehlerTextFuerCode(code: AuthErrorCode): string {
  const key = I18N_KEYS[code]
  // Codes, deren Message vom Server kommt (z. B. change_failed): kein
  // i18n-Lookup, einfach der Code-Slug als lesbarer Fallback.
  if (key === code) return code
  const translated = i18n.global.t(key)
  if (translated && translated !== key) return translated
  // Build a deterministic fallback so the UI always has *some* text.
  return new AuthError(code, code).message
}
