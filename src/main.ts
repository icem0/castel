import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { bindSpracheAnLocale, i18n } from './i18n'
import { useSettingsStore } from './stores/settings'
import { useAuthStore } from './stores/auth'
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
app.mount('#app')

// Mirror the settings store into the i18n locale. The store values are
// loaded asynchronously via Dexie liveQuery, so the watcher follows the
// per-user setting `sprache` — the UI switches to the chosen language
// right away (purely client-side, the server is not involved).
const settings = useSettingsStore()
settings.start()
bindSpracheAnLocale(() => settings.settings.sprache)

// Auth: gespeichertes JWT aus localStorage wiederherstellen und
// asynchron pruefen, ob der Server ueberhaupt User hat. Bei Offline
// schlaegt der Check fehl und serverHatUser bleibt null/unknown —
// die LoginView faellt dann auf Login-Modus zurueck und ermoeglicht
// Offline-Login mit gecachten Credentials.
const auth = useAuthStore()
auth.init()
void auth.pruefeServerUserState()

// PWA-Service-Worker registrieren.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({ immediate: true })
    })
    .catch((e) => {
      console.warn('Service-Worker-Registrierung fehlgeschlagen:', e)
    })
}
