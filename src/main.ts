import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { i18n, type AppLocale } from './i18n'
import { useSettingsStore, type Sprache } from './stores/settings'
import { useAuthStore } from './stores/auth'
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(i18n)
app.mount('#app')

// Locale aus Settings-Store nachziehen. Da die Settings-Store-Werte
// asynchron via Dexie liveQuery geladen werden, setzen wir einen Watcher,
// der die i18n-Locale spiegelt.
const settings = useSettingsStore()
settings.start()
watch(
  () => settings.settings.sprache,
  (sprache: Sprache) => {
    const next: AppLocale = sprache === 'en' ? 'en-US' : 'de-DE'
    if (i18n.global.locale.value !== next) {
      i18n.global.locale.value = next
    }
  },
  { immediate: true },
)

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
