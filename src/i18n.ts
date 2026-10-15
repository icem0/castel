// vue-i18n-Initialisierung.
// Default: de-DE. Wird in main.ts mit createI18n() erzeugt und die App
// reagiert auf den Settings-Store (sprache), um die Locale zur Laufzeit umzuschalten.

import { createI18n } from 'vue-i18n'
import de from './locales/de-DE'
import en from './locales/en-US'

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
