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
