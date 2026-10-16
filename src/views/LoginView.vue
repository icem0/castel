<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'
import { version, commit, branch, buildDate } from '../version'
import { useDevMode } from '../composables/useDevMode'
import { readDevResetMarker, clearDevResetMarker } from '../services/dev-mode-bootstrap'
import { fuehreSetupDurch } from '../auth/users'
import { ApiError } from '../auth/api'
import { authFehlerText } from '../auth/messages'

const router = useRouter()
const auth = useAuthStore()
const settings = useSettingsStore()
const { t } = useI18n()
const { active: devModeActive, tooltip: devModeTooltip } = useDevMode()

// Wenn beim Bootstrap ein IndexedDB-Reset stattgefunden hat, zeigen wir
// hier einen kurzen, dezenten Hinweis. Wird beim ersten Render einmal
// gelesen und gleich wieder geloescht, damit er nach Login + Reload
// nicht erneut erscheint.
const devResetHinweis = ref<string | null>(null)
const devResetMarker = readDevResetMarker()
if (devResetMarker) {
  const zeit = new Date(devResetMarker.at).toLocaleTimeString()
  devResetHinweis.value = `Lokale Datenbank um ${zeit} zur\u00FCckgesetzt (DEV_MODE).`
  clearDevResetMarker()
}

type Modus = 'laden' | 'setup' | 'login'

const modus = ref<Modus>('laden')

// --- Login-Felder ---
const email = ref('')
const passwort = ref('')
const fehler = ref('')
const laufend = ref(false)

// --- Setup-Felder ---
const setupAnzeigename = ref('')
const setupEmail = ref('')
const setupPasswort = ref('')
const setupPasswortBestaetigen = ref('')
const setupFehler = ref('')
const setupLaufend = ref(false)

// Mappt den Server-User-State auf den Anzeige-Modus.
// null = unknown (z. B. offline) → Login-Modus, User koennte noch
//   per Offline-Fallback reinkommen, Fehlermeldung wird separat gesetzt.
// true = Server hat User → Login-Modus.
// false = Server meldet setupRequired → Setup-Modus (sofort sichtbar).
function modusAusState(state: boolean | null): Modus {
  return state === false ? 'setup' : 'login'
}

async function ladeSetupStatus(): Promise<void> {
  // Wenn der State schon bekannt ist (App-Boot-Check in main.ts oder
  // vorheriger Logout), direkt den Modus ableiten — kein 'laden'-Flash.
  if (auth.serverHatUser !== null) {
    modus.value = modusAusState(auth.serverHatUser)
  } else {
    modus.value = 'laden'
  }

  // Prueft setup-status via Auth-Store. Bei Netzwerk-Fehler bleibt
  // serverHatUser auf seinem letzten Wert (typischerweise null) und
  // wir landen im Login-Modus mit Fehlermeldung — kein Setup-Mode bei
  // blossem Offline-Status.
  const result = await auth.pruefeServerUserState()
  if (result === null) {
    modus.value = 'login'
    fehler.value = t('auth.error.serverUnreachableHint')
    return
  }
  modus.value = modusAusState(result)
}

onMounted(() => {
  void ladeSetupStatus()
})

async function anmelden(): Promise<void> {
  fehler.value = ''
  if (!email.value.trim() || !passwort.value) {
    fehler.value = t('auth.error.credentialsRequired')
    return
  }
  laufend.value = true
  try {
    await auth.anmelden(email.value, passwort.value, { offlineFallback: true })
    if (auth.mussPasswortAendern) {
      void router.push('/passwort-aendern')
    } else {
      void router.push('/')
    }
  } catch (e) {
    // AuthError wird via authFehlerText in die aktive Locale uebersetzt.
    // Fuer den Sonderfall ApiError (nur direkt vom Server, z. B. wenn der
    // Auth-Store noch nicht angepasst ist) greifen wir auf die Server-
    // Message zurueck — sie ist i. d. R. bereits deutsch und lesbar.
    if (e instanceof ApiError) {
      fehler.value = e.message || t('auth.error.serverUnreachable')
    } else {
      fehler.value = authFehlerText(e)
    }
  } finally {
    laufend.value = false
  }
}

async function setupAbschliessen(): Promise<void> {
  setupFehler.value = ''

  if (!setupAnzeigename.value.trim()) {
    setupFehler.value = t('view.settings.benutzer') + ' erforderlich'
    return
  }
  if (!setupEmail.value.trim()) {
    setupFehler.value = t('auth.error.emailRequired')
    return
  }
  if (setupPasswort.value.length < 8) {
    setupFehler.value = 'Passwort muss mindestens 8 Zeichen haben.'
    return
  }
  if (setupPasswort.value !== setupPasswortBestaetigen.value) {
    setupFehler.value = 'Passwörter stimmen nicht überein.'
    return
  }

  setupLaufend.value = true
  try {
    await fuehreSetupDurch({
      anzeigename: setupAnzeigename.value.trim(),
      email: setupEmail.value.trim(),
      passwort: setupPasswort.value,
    })
    // Server hat den User angelegt — jetzt regulär einloggen.
    await auth.anmelden(setupEmail.value.trim(), setupPasswort.value, { offlineFallback: false })
    void router.push('/')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'SETUP_DONE') {
      // In der Zwischenzeit hat jemand anderes den Setup gemacht.
      setupFehler.value = 'Setup ist bereits abgeschlossen. Bitte anmelden.'
      modus.value = 'login'
      email.value = setupEmail.value.trim()
      return
    }
    setupFehler.value = authFehlerText(e)
  } finally {
    setupLaufend.value = false
  }
}

function zeigeInfo(): void {
  alert('Bitte einen Admin darum, dein Passwort zurückzusetzen (über die Benutzer-Verwaltung).')
}

const versionLabel = `v${version} · ${commit}`
const buildDateFormatiert = new Date(buildDate).toLocaleString()
const repoUrl = 'https://github.com/icem0/castel'
const versionOffen = ref(false)
const copyStatus = ref<'idle' | 'ok' | 'fehler'>('idle')
let copyResetTimer: ReturnType<typeof setTimeout> | null = null

// Einzeiliger Build-String fuer Copy/Paste in Bug-Reports o. ae.
// Format: castel v0.1.0 (commit f0ad4fe, branch main, built 14.10.2026 12:55:22) · MIT · https://github.com/icem0/castel
const versionString = `castel v${version} (commit ${commit}, branch ${branch}, built ${buildDateFormatiert}) · MIT · ${repoUrl}`

function toggleVersion(): void {
  versionOffen.value = !versionOffen.value
}
function closeVersion(): void {
  versionOffen.value = false
}

async function copyVersion(): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(versionString)
    } else {
      // Fallback fuer aelteres Browser/WebView ohne Clipboard-API.
      const ta = document.createElement('textarea')
      ta.value = versionString
      ta.setAttribute('readonly', '')
      ta.style.position = 'absolute'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (!ok) throw new Error('execCommand(copy) fehlgeschlagen')
    }
    copyStatus.value = 'ok'
  } catch {
    copyStatus.value = 'fehler'
  } finally {
    if (copyResetTimer !== null) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => {
      copyStatus.value = 'idle'
    }, 2000)
  }
}
</script>

<template>
  <section class="login">
    <div
      v-if="devModeActive"
      class="dev-badge"
      :title="devModeTooltip"
      aria-label="Development-Modus aktiv"
    >
      DEV MODE
    </div>

    <p v-if="devResetHinweis" class="dev-reset-hinweis" role="status">
      {{ devResetHinweis }}
    </p>

    <div class="card login-card">
      <div class="brand">
        <img src="/castel-logo.png" alt="" width="48" height="48" />
        <h1>
          {{
            settings.settings.companyName ? `${settings.settings.companyName} @ castel` : 'castel'
          }}
        </h1>
      </div>

      <!-- Lade-Zustand -->
      <template v-if="modus === 'laden'">
        <p class="hint">Wird geladen …</p>
      </template>

      <!-- Setup-Formular: erster User -->
      <template v-else-if="modus === 'setup'">
        <p class="hint">
          Noch kein Benutzer vorhanden. Lege den ersten Account an, danach läuft der Login normal.
        </p>

        <form
          class="form"
          :aria-busy="setupLaufend || undefined"
          @submit.prevent="setupAbschliessen"
        >
          <label>
            <span>Anzeigename</span>
            <input
              v-model="setupAnzeigename"
              name="anzeigename"
              type="text"
              autocomplete="name"
              maxlength="120"
              required
              autofocus
            />
          </label>
          <label>
            <span>E-Mail (Login)</span>
            <input
              v-model="setupEmail"
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              required
            />
          </label>
          <label>
            <span>Passwort</span>
            <input
              v-model="setupPasswort"
              name="password"
              type="password"
              autocomplete="new-password"
              minlength="8"
              required
            />
          </label>
          <label>
            <span>Passwort bestätigen</span>
            <input
              v-model="setupPasswortBestaetigen"
              name="password-confirm"
              type="password"
              autocomplete="new-password"
              minlength="8"
              required
            />
          </label>
          <p v-if="setupFehler" class="fehler" role="alert">{{ setupFehler }}</p>

          <div class="form-actions">
            <button type="submit" class="primary" :disabled="setupLaufend">
              {{ setupLaufend ? 'Wird angelegt …' : 'Account anlegen' }}
            </button>
          </div>
        </form>
      </template>

      <!-- Login-Formular -->
      <template v-else>
        <p class="hint">Bitte mit E-Mail und Passwort anmelden.</p>

        <form class="form" :aria-busy="laufend || undefined" @submit.prevent="anmelden">
          <label>
            <span>E-Mail</span>
            <input
              v-model="email"
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              required
              autofocus
            />
          </label>
          <label>
            <span>Passwort</span>
            <input
              v-model="passwort"
              name="password"
              type="password"
              autocomplete="current-password"
              required
            />
          </label>
          <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>

          <div class="form-actions">
            <button type="submit" class="primary" :disabled="laufend">
              {{ laufend ? 'Anmelden …' : 'Anmelden' }}
            </button>
          </div>
        </form>

        <p class="hint">
          <a href="javascript:void(0)" @click="zeigeInfo">Passwort vergessen?</a>
        </p>
      </template>
    </div>

    <button
      type="button"
      class="version-badge"
      :title="`Build ${commit}`"
      @click.stop="toggleVersion"
    >
      {{ versionLabel }}
    </button>

    <div v-if="versionOffen" class="version-panel" role="dialog" @click.stop>
      <h2>Build-Info</h2>
      <dl class="meta">
        <div>
          <dt>Version</dt>
          <dd>v{{ version }}</dd>
        </div>
        <div>
          <dt>Commit</dt>
          <dd>{{ commit }}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{{ branch }}</dd>
        </div>
        <div>
          <dt>Build-Datum</dt>
          <dd>{{ buildDateFormatiert }}</dd>
        </div>
      </dl>
      <p class="version-footer">
        by
        <a :href="repoUrl" target="_blank" rel="noopener noreferrer" class="version-footer-link"
          >icem0</a
        >
        ·
        <a :href="repoUrl" target="_blank" rel="noopener noreferrer" class="version-footer-link"
          >github.com/icem0/castel</a
        >
        · MIT-Lizenz
      </p>
      <div class="version-actions">
        <button
          type="button"
          class="copy-btn"
          :class="`state-${copyStatus}`"
          :title="copyStatus === 'ok' ? 'Kopiert' : versionString"
          :aria-label="
            copyStatus === 'ok' ? 'Kopiert' : 'Build-Info in die Zwischenablage kopieren'
          "
          @click="copyVersion"
        >
          <svg
            v-if="copyStatus === 'idle'"
            class="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <svg
            v-else-if="copyStatus === 'ok'"
            class="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <svg
            v-else
            class="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </button>
        <button type="button" @click="closeVersion">Schließen</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  background: var(--bg-app);
}

.dev-badge {
  position: fixed;
  top: 0.75rem;
  right: 0.75rem;
  background: #ff7a00;
  color: #1a0a00;
  padding: 0.3rem 0.7rem;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  cursor: help;
  box-shadow: 0 0 0 2px rgba(255, 122, 0, 0.25);
  z-index: 60;
  user-select: none;
}

.dev-reset-hinweis {
  position: fixed;
  top: 2.7rem;
  left: 0.75rem;
  right: 0.75rem;
  max-width: 22rem;
  background: rgba(255, 122, 0, 0.12);
  color: #ffb86b;
  border: 1px solid rgba(255, 122, 0, 0.4);
  padding: 0.4rem 0.7rem;
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  font-family: var(--mono);
  z-index: 60;
  margin: 0;
}

.login-card {
  width: 100%;
  max-width: 380px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.brand h1 {
  margin: 0;
  font-size: 1.4rem;
  color: var(--text-strong);
}

.hint {
  color: var(--text-muted);
  font-size: 0.85rem;
  margin: 0.75rem 0 0;
  text-align: center;
}

.version-badge {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  background: var(--bg-input);
  color: var(--text-muted);
  border: 1px solid var(--border-strong);
  padding: 0.3rem 0.55rem;
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
}

.version-badge:hover {
  background: var(--bg-card);
  color: var(--text-strong);
  border-color: var(--accent-border);
}

.version-panel {
  position: fixed;
  bottom: 3rem;
  right: 1rem;
  left: 1rem;
  width: auto;
  max-width: 22rem;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 1rem 1.1rem;
  box-shadow: var(--shadow);
  z-index: 50;
}

.version-panel h2 {
  margin: 0 0 0.6rem;
  font-size: 1rem;
  color: var(--text-strong);
}

.version-panel .meta {
  display: grid;
  gap: 0.4rem;
  margin: 0 0 0.8rem;
}

.version-panel .meta dt {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-bottom: 0.1rem;
}

.version-panel dd {
  margin: 0;
  font-family: var(--mono);
  font-size: 0.85rem;
  color: var(--text-strong);
}

.version-panel .version-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.version-panel .version-footer {
  margin: 0 0 0.75rem;
  font-size: 0.78rem;
  color: var(--text-muted);
  text-align: center;
}

.version-panel .version-footer-link {
  color: var(--accent);
  text-decoration: none;
}

.version-panel .version-footer-link:hover {
  text-decoration: underline;
}

.version-panel .version-actions button {
  flex: 1 1 auto;
  padding: 0.45rem 0.7rem;
  font-size: 0.8rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
}

.version-panel .version-actions button:hover {
  background: var(--bg-card);
  border-color: var(--accent-border);
  color: var(--text-strong);
}

.version-panel .version-actions .copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  font-family: var(--mono);
  color: var(--text-muted);
}

.version-panel .version-actions .copy-btn:hover {
  color: var(--text-strong);
}

.version-panel .version-actions .copy-btn .icon {
  width: 1.05rem;
  height: 1.05rem;
  display: block;
}

.version-panel .version-actions .copy-btn.state-ok {
  color: var(--accent);
  border-color: var(--accent-border);
}

.version-panel .version-actions .copy-btn.state-fehler {
  color: #e35d6a;
  border-color: #e35d6a;
}
</style>
