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
 * Die globale `t()`-Funktion gegen Message-Kompilierfehler härten.
 *
 * vue-i18n kompiliert Nachrichten lazy beim ersten Zugriff. Enthält eine
 * Nachricht ein ungültiges Platzhalter-Token (z. B. durch vom Server oder
 * aus IndexedDB stammende Daten mit einem fehlerhaften `{…}`), wirft
 * `@intlify/message-compiler` eine `SyntaxError` (Code 2 =
 * `INVALID_TOKEN_IN_PLACEHOLDER`). Das würde die rendernende Komponente
 * und damit die gesamte App zum Absturz bringen.
 *
 * `useI18n()` ohne Scope liefert `i18n.global` (Scope `global`), daher
 * decken ein einziger Wrapper hier alle Komponenten- und
 * `i18n.global.t()`-Aufrufe ab (inkl. `src/auth/messages.ts`).
 *
 * Im Fehlerfall wird der Schlüssel als Fallback zurückgegeben und der
 * Vorfall protokolliert, sodass der auslösende Schlüssel diagnostiziert
 * werden kann.
 */
const gl = i18n.global
const _t = gl.t as (...args: unknown[]) => unknown
gl.t = ((key: unknown, ...rest: unknown[]): string => {
  try {
    return _t(key, ...rest) as string
  } catch (e) {
    if (e instanceof SyntaxError && (e as { code?: number }).code === 2) {
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
