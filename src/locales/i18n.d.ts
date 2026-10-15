// Erweitert vue-i18n um typsichere Übersetzungsschlüssel.
// Liefert Auto-Completion und verhindert Tippfehler in `t('view.artikel.h1')`.

import type de from './de-DE'

export type LocaleMessageSchema = typeof de

declare module 'vue-i18n' {
  // Aktiviert typsichere Schlüssel im Composition-API-Stil (`useI18n`).
  // Das interface ist absichtlich leer; vue-i18n deklariert es als leere Basis.
  /* eslint-disable @typescript-eslint/no-empty-object-type */
  export interface DefineLocaleMessageSchema extends LocaleMessageSchema {}
  /* eslint-enable @typescript-eslint/no-empty-object-type */
}
