// vue-i18n-Initialisierung.
// Default: de-DE. Die Locale folgt der per-User-Einstellung `sprache`
// (siehe `bindSpracheAnLocale`).

import { watch } from 'vue'
import { createI18n } from 'vue-i18n'
import de from './locales/de-DE'
import en from './locales/en-US'
import type { Sprache } from './stores/settings'

export type AppLocale = 'de-DE' | 'en-US'

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'de-DE' as AppLocale,
  fallbackLocale: 'de-DE' as AppLocale,
  messages: {
    'de-DE': de,
    'en-US': en,
  },
})

/**
 * Hardens the global `t()` against message-compiler failures.
 *
 * vue-i18n compiles messages lazily on first access. A message with an invalid
 * placeholder token (e.g. a non-ASCII name such as `{übersprungen}` — the
 * message compiler only accepts `[a-zA-Z_][a-zA-Z0-9_]*`) makes
 * `@intlify/message-compiler` raise a compile error. That would take down the
 * rendering component, i.e. the whole app.
 *
 * `useI18n()` without a scope returns `i18n.global` (scope `global`), so this
 * single wrapper covers every component call and every `i18n.global.t()` call
 * (incl. `src/auth/messages.ts` and the inventory export service).
 *
 * `@intlify/core-base` re-throws the compile error as a plain `SyntaxError`
 * prefixed with "Message compilation error:" and WITHOUT the compiler's `code`,
 * so matching on `code === 2` alone silently never fires (vue-i18n 11). Match
 * both shapes and return the key as fallback, logging the offending key.
 */
const gl = i18n.global
const NACHRICHTEN_FEHLER =
  /message compilation error|invalid token in placeholder|unterminated single quote|unknown escape sequence/i
const _t = gl.t as (...args: unknown[]) => unknown
gl.t = ((key: unknown, ...rest: unknown[]): string => {
  try {
    return _t(key, ...rest) as string
  } catch (e) {
    const code = (e as { code?: unknown })?.code
    const isCompileError =
      e instanceof SyntaxError &&
      (typeof code === 'number' || NACHRICHTEN_FEHLER.test((e as Error).message))
    if (isCompileError) {
      console.warn('[i18n] message compilation failed for key', key, '->', (e as Error).message)
      return String(key)
    }
    throw e
  }
}) as typeof gl.t

/** Map the short per-user language value onto an i18n locale. */
export function spracheZuLocale(sprache: Sprache): AppLocale {
  return sprache === 'en' ? 'en-US' : 'de-DE'
}

/**
 * Mirror the per-user language setting into the i18n locale.
 *
 * The language is a client-side concern: as soon as the settings store
 * reports a new value (the store is refreshed via Dexie liveQuery, so this
 * happens right after the local write), the whole UI switches language.
 * The server is not involved.
 */
export function bindSpracheAnLocale(sprache: () => Sprache): void {
  watch(
    sprache,
    (wert: Sprache) => {
      const next = spracheZuLocale(wert)
      if (i18n.global.locale.value !== next) {
        i18n.global.locale.value = next
      }
    },
    { immediate: true },
  )
}
