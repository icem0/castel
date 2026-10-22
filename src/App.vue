<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watchEffect, computed, watch } from 'vue'
import { RouterLink, useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from './stores/settings'
import { useStandortStore } from './stores/standort'
import { useArtikelStore } from './stores/artikel'
import { useBuchungStore } from './stores/buchung'
import { useProjektStore } from './stores/projekt'
import { useAuditStore } from './stores/audit'
import { useAuthStore } from './stores/auth'
import { useSyncStore } from './stores/sync'
import { getApiBaseUrl } from './auth/api'

import { zaehleAbweichungen } from './services/sync/worker'
import { version, commit, branch, buildDate } from './version'
import OnboardingTutorial from './components/OnboardingTutorial.vue'
import MindestbestandGlocke from './views/components/MindestbestandGlocke.vue'

// Responsive Layout-Umschaltung: <html data-layout="mobile|desktop">.
// CSS nutzt das, um Bottom-Nav, FAB und Mobile-spezifische Helfer zu zeigen/verbergen.
const layoutModus = ref<'mobile' | 'desktop'>('desktop')

function aktualisiereLayout(): void {
  const istSchmal = window.matchMedia('(max-width: 720px)').matches
  layoutModus.value = istSchmal ? 'mobile' : 'desktop'
  document.documentElement.setAttribute('data-layout', layoutModus.value)
}

let mql: MediaQueryList | null = null
function onMqlChange(): void {
  aktualisiereLayout()
}

const { t } = useI18n()
const router = useRouter()
const route = useRoute()

const settings = useSettingsStore()
const standort = useStandortStore()
const artikel = useArtikelStore()
const buchung = useBuchungStore()
const projekt = useProjektStore()
const audit = useAuditStore()
const auth = useAuthStore()
const sync = useSyncStore()
// Public-Routen zeigen kein Header-Layout.
const istPublicRoute = computed(() => route.meta.public === true)

const online = ref(navigator.onLine)
function onOnline(): void {
  online.value = true
}
function onOffline(): void {
  online.value = false
}

const versionOffen = ref(false)
function toggleVersion(): void {
  versionOffen.value = !versionOffen.value
}
function closeVersion(): void {
  versionOffen.value = false
}

function onDocumentClick(e: MouseEvent): void {
  if (!versionOffen.value && !syncPanelOffen.value) return
  const ziel = e.target as HTMLElement | null
  if (!ziel) return
  if (versionOffen.value && !ziel.closest('.version-badge, .version-panel')) closeVersion()
  if (syncPanelOffen.value && !ziel.closest('.sync-indicator, .sync-panel')) closeSyncPanel()
}

const themeUmschalter = ref<'dark' | 'light' | 'auto'>(
  (localStorage.getItem('theme') as 'dark' | 'light' | 'auto' | null) ?? 'dark',
)
watchEffect(() => {
  const wert = themeUmschalter.value
  localStorage.setItem('theme', wert)
  const root = document.documentElement
  if (wert === 'dark') {
    root.setAttribute('data-theme', 'dark')
  } else if (wert === 'light') {
    root.setAttribute('data-theme', 'light')
  } else {
    root.removeAttribute('data-theme')
  }
})

onMounted(() => {
  // Stores nur dann starten, wenn eine Session existiert. Das verhindert
  // data-leaks zwischen Login-Versuchen.
  if (auth.istAngemeldet) {
    settings.start()
    standort.start()
    artikel.start()
    buchung.start()
    projekt.start()
    audit.start()
  }
  aktualisiereLayout()
  mql = window.matchMedia('(max-width: 720px)')
  mql.addEventListener('change', onMqlChange)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('click', onDocumentClick)
})

onBeforeUnmount(() => {
  settings.stop()
  standort.stop()
  artikel.stop()
  buchung.stop()
  projekt.stop()
  audit.stop()
  if (mql) mql.removeEventListener('change', onMqlChange)
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  window.removeEventListener('click', onDocumentClick)
})

// Wenn sich der Login-Status ändert, Stores entsprechend starten/stoppen.
watchEffect(() => {
  if (auth.istAngemeldet) {
    settings.start()
    standort.start()
    artikel.start()
    buchung.start()
    projekt.start()
    audit.start()
    sync.start({
      apiBase: getApiBaseUrl(),
      getToken: () => (auth.session?.jwtExpiresAt ? localStorage.getItem('castel.auth.jwt') : null),
      intervalSek: 30,
      onAuthRevoked: () => {
        // Token ist abgelaufen / ungültig. Auth-Store leeren, der Router
        // schickt uns dann automatisch auf die Login-View.
        void auth.abmelden()
        if (router.currentRoute.value.name !== 'login') {
          void router.push({
            name: 'login',
            query: { redirect: router.currentRoute.value.fullPath },
          })
        }
      },
    })
  } else {
    settings.stop()
    standort.stop()
    artikel.stop()
    buchung.stop()
    projekt.stop()
    audit.stop()
    sync.stop()
  }
})

// ---------- Onboarding-Tutorial ----------
// Wird nur einmal pro Geräte+User-Lifecycle gezeigt — und zwar NUR
// für Erstnutzer (`settings.settings.firstLoginDone === false`).
//
// Zwei Gates, BEIDE müssen passen, damit das Modal aufgeht:
//
//  1. Erstnutzer-Gate (`firstLoginDone`): ist die per-User-Zeile
//     `[firstLoginDone, <userId>] = 'true'` gesetzt, zeigen wir das
//     Modal NIE mehr automatisch. Das ist die zuverlässige Bremse gegen
//     das "blitzt kurz auf und ist wieder weg"-Symptom: selbst wenn die
//     lokale DB die `onboardingSeen=true`-Zeile noch nicht hat (Sync
//     hängt, IndexedDB leer, Offline-Modus), bleibt das Modal zu.
//
//  2. Server-Bestätigung: bei Erstnutzern warten wir zusätzlich auf
//     den ersten Sync-Lauf (oder eine Frist), bevor wir das Modal
//     zeigen. Damit kann ein gerade laufender Pull noch eine
//     `onboardingSeen=true`-Zeile nachliefern.
//
// Nach dem ersten Modal-Aufruf — egal ob der User es akzeptiert, später
// schließt oder einfach wegnavigiert — schreiben wir `firstLoginDone =
// true` (per-User, cross-device-sync). Damit ist die Erstnutzer-Phase
// beendet und das Modal kommt nie wieder automatisch. Über /info →
// "Tutorial erneut zeigen" kann der User es jederzeit manuell öffnen;
// das schreibt NUR `onboardingSeen=false`, nicht `firstLoginDone`.
//
// Verhalten nach F5/Refresh: das Modal öffnet frühestens 1,5s nach
// dem ersten Trigger. In dieser Zeit hat der Server-Pull Zeit, eine
// eventuelle `firstLoginDone=true` oder `onboardingSeen=true`-Zeile
// nachzuliefern. Wenn die ankommt, killt sie den Verzögerungs-Timer
// und das Modal bleibt zu. Wenn nicht, ist der User wirklich Erstnutzer
// und wir zeigen das Modal.
const tutorialOffen = ref(false)
let tutorialTriggeredFor: string | null = null
let firstLoginDoneMarkerGeschrieben: string | null = null
const ONBOARDING_VERZOEGERUNG_MS = 1500
let verzoegerungsTimer: ReturnType<typeof setTimeout> | null = null

function clearVerzoegerungsTimer(): void {
  if (verzoegerungsTimer !== null) {
    clearTimeout(verzoegerungsTimer)
    verzoegerungsTimer = null
  }
}

function starteVerzoegerungsTimer(): void {
  if (verzoegerungsTimer !== null) return
  if (tutorialTriggeredFor === auth.userId) return
  console.log('[onboarding] starteVerzoegerungsTimer: 1,5s warten', {
    istAngemeldet: auth.istAngemeldet,
    userId: auth.userId,
    geladen: settings.geladen,
    onboardingSeen: settings.settings.onboardingSeen,
    firstLoginDone: settings.settings.firstLoginDone,
  })
  verzoegerungsTimer = setTimeout(() => {
    verzoegerungsTimer = null
    console.log('[onboarding] Timer abgelaufen, pruefeUndOeffneTutorial()')
    pruefeUndOeffneTutorial()
  }, ONBOARDING_VERZOEGERUNG_MS)
}

// Öffnet das Modal, falls ALLE Gates passen. Idempotent: ein bereits
// getriggerter User wird nicht nochmal getriggert.
function pruefeUndOeffneTutorial(): void {
  const userId = auth.userId
  if (!auth.istAngemeldet) {
    console.log('[onboarding] pruefe: NICHT angemeldet, skip')
    return
  }
  if (settings.geladen !== true) {
    console.log('[onboarding] pruefe: settings.geladen !== true, skip')
    return
  }
  if (settings.settings.firstLoginDone === true) {
    console.log('[onboarding] pruefe: firstLoginDone=true, blockiere')
    clearVerzoegerungsTimer()
    tutorialOffen.value = false
    return
  }
  if (settings.settings.onboardingSeen === true) {
    console.log('[onboarding] pruefe: onboardingSeen=true, blockiere')
    clearVerzoegerungsTimer()
    markiereFirstLoginDone(userId)
    return
  }
  if (tutorialTriggeredFor === userId) {
    console.log('[onboarding] pruefe: schon fuer diesen user getriggert, skip')
    return
  }
  console.log('[onboarding] pruefe: ALLE Gates passen, oeffne Modal', {
    userId,
    firstLoginDone: settings.settings.firstLoginDone,
    onboardingSeen: settings.settings.onboardingSeen,
  })
  tutorialTriggeredFor = userId
  // Erst das Modal öffnen, DANN den Marker schreiben. Wuerden wir den
  // Marker zuerst schreiben, feuert Watcher #1 sofort (firstLoginDone=true)
  // und setzt tutorialOffen wieder auf false — das Modal blinkt auf und
  // ist sofort weg, bevor der User es sieht.
  tutorialOffen.value = true
  markiereFirstLoginDone(userId)
}

function markiereFirstLoginDone(userId: string | null): void {
  if (userId === null) return
  if (firstLoginDoneMarkerGeschrieben === userId) return
  firstLoginDoneMarkerGeschrieben = userId
  void settings.setFirstLoginDone(true).catch(() => {
    // bewusst ignorieren
  })
}

watch(
  () => ({
    istAngemeldet: auth.istAngemeldet,
    userId: auth.userId,
    geladen: settings.geladen,
    gesehen: settings.settings.onboardingSeen,
    firstLoginDone: settings.settings.firstLoginDone,
  }),
  ({ istAngemeldet, userId, firstLoginDone, gesehen }) => {
    console.log('[onboarding] Watcher #1 (settings) feuert', {
      istAngemeldet,
      userId: auth.userId,
      geladen: settings.geladen,
      gesehen,
      firstLoginDone,
    })
    if (!istAngemeldet) {
      tutorialOffen.value = false
      tutorialTriggeredFor = null
      firstLoginDoneMarkerGeschrieben = null
      clearVerzoegerungsTimer()
      return
    }
    if (firstLoginDone === true || gesehen === true) {
      // Nicht schliessen, wenn wir gerade dieses Modal fuer diesen User
      // oeffnen (das Flag wird erst nach dem Oeffnen geschrieben).
      if (tutorialTriggeredFor === userId) return
      console.log('[onboarding] Watcher #1: blockiere (Flag true)')
      clearVerzoegerungsTimer()
      tutorialOffen.value = false
      return
    }
    if (settings.geladen === true) {
      starteVerzoegerungsTimer()
    }
  },
  { immediate: true },
)

// Sync-Status-Watcher: sobald der erste Pull durch ist (oder
// definitiv keiner mehr kommt), starten wir ggf. den Verzögerungs-Timer
// für die Modal-Anzeige. Der Timer gibt dem Pull + der Eventual-Check
// Zeit, sich zu beruhigen.
watch(
  () => ({
    status: sync.status.status,
    letzterSync: sync.status.lastSyncAt,
  }),
  ({ status, letzterSync }) => {
    console.log('[onboarding] Watcher #2 (sync) feuert', {
      status,
      letzterSync,
    })
    const syncBereit =
      letzterSync !== null ||
      status === 'offline' ||
      status === 'origin-unavailable' ||
      status === 'error'
    if (!syncBereit) return
    if (settings.geladen === true && auth.istAngemeldet) {
      starteVerzoegerungsTimer()
    }
  },
  { immediate: true },
)

function abmelden(): void {
  auth.abmelden()
  void router.push('/login')
}

const versionLabel = `v${version} · ${commit}`
const buildDateFormatiert = new Date(buildDate).toLocaleString()
const repoUrl = 'https://github.com/icem0/castel'
const versionString = `castel v${version} (commit ${commit}, branch ${branch}, built ${buildDateFormatiert}) · MIT · ${repoUrl}`

const copyStatus = ref<'idle' | 'ok' | 'fehler'>('idle')
const copyErrorStatus = ref<'idle' | 'ok' | 'fehler'>('idle')
let copyResetTimer: ReturnType<typeof setTimeout> | null = null
let copyErrorResetTimer: ReturnType<typeof setTimeout> | null = null

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
  } else {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'absolute'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (!ok) throw new Error('execCommand(copy) fehlgeschlagen')
  }
}

async function copyVersion(): Promise<void> {
  try {
    await copyToClipboard(versionString)
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

function buildErrorText(): string {
  const f = sync.status.lastFailure
  const parts: string[] = []
  if (sync.status.lastError) parts.push(`Letzter Fehler: ${sync.status.lastError}`)
  if (f) {
    parts.push(`Diagnose: ${f.message}`)
    if (f.source) parts.push(`Schritt: ${f.source}`)
    if (f.status !== null) parts.push(`HTTP: ${f.status}`)
    if (f.code) parts.push(`Code: ${f.code}`)
    if (f.rejectedItems > 0) parts.push(`Abgelehnt: ${f.rejectedItems}`)
    for (const e of f.sampleErrors) {
      if (e.stack) parts.push(`Stack: ${e.stack}`)
      if (e.payload !== undefined) parts.push(`Payload: ${JSON.stringify(e.payload)}`)
    }
  }
  return parts.join('\n') + `\n\nVersion: v${version}`
}

async function copyError(): Promise<void> {
  try {
    const text = buildErrorText()
    await copyToClipboard(text)
    copyErrorStatus.value = 'ok'
  } catch {
    copyErrorStatus.value = 'fehler'
  } finally {
    if (copyErrorResetTimer !== null) clearTimeout(copyErrorResetTimer)
    copyErrorResetTimer = setTimeout(() => {
      copyErrorStatus.value = 'idle'
    }, 2000)
  }
}

// ---------- DB-Sync Indikator ----------

const syncPanelOffen = ref(false)
const syncDetail = ref<'none' | 'fetching' | 'ready' | 'error'>('none')

function toggleSyncPanel(): void {
  syncPanelOffen.value = !syncPanelOffen.value
  if (syncPanelOffen.value) void ladeSyncDetail()
}

function closeSyncPanel(): void {
  syncPanelOffen.value = false
}

async function ladeSyncDetail(): Promise<void> {
  syncDetail.value = 'fetching'
  try {
    await sync.refresh(getApiBaseUrl(), () => localStorage.getItem('castel.auth.jwt'))
    syncDetail.value = 'ready'
  } catch {
    syncDetail.value = 'error'
  }
}

async function manuellSync(): Promise<void> {
  await sync.syncNow(getApiBaseUrl(), () => localStorage.getItem('castel.auth.jwt'))
  await ladeSyncDetail()
}

const syncZustand = computed<
  | 'offline'
  | 'error'
  | 'syncing'
  | 'diverged'
  | 'pending'
  | 'stale'
  | 'synced'
  | 'origin-unavailable'
>(() => {
  const st = sync.status
  if (!online.value) return 'offline'
  if (st.status === 'origin-unavailable') return 'origin-unavailable'
  if (st.status === 'error') return 'error'
  if (st.status === 'syncing') return 'syncing'
  if (st.pending > 0) return 'pending'
  const diff = zaehleAbweichungen(st.localCounts, st.serverCounts)
  if (diff > 0) return 'diverged'
  if (st.lastSyncAt) {
    const alterMs = Date.now() - new Date(st.lastSyncAt).getTime()
    if (alterMs > 5 * 60_000) return 'stale'
  }
  return 'synced'
})

const syncZustandLabel = computed((): string => {
  switch (syncZustand.value) {
    case 'offline':
      return 'Offline'
    case 'origin-unavailable':
      return 'Server nicht erreichbar'
    case 'error':
      return 'Sync-Fehler'
    case 'syncing':
      return 'Synchronisiere…'
    case 'pending':
      return `${sync.status.pending} ausstehend`
    case 'diverged':
      return 'DBs divergieren'
    case 'stale':
      return 'Sync veraltet'
    case 'synced':
      return 'DBs synchron'
  }
  return ''
})

const syncZustandTitel = computed(() => {
  const basis = `DB-Sync: ${syncZustandLabel.value}`
  if (sync.status.lastError) return `${basis} — ${lastErrorMitVersion.value}`
  return basis
})

const lastErrorMitVersion = computed(() => {
  if (!sync.status.lastError) return null
  return `${sync.status.lastError} (v${version})`
})

function formatIso(iso: string | null): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '–'
  return d.toLocaleString()
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'push':
      return 'Push (Outbox → Server)'
    case 'snapshot':
      return 'Pull (Snapshot laden)'
    case 'status':
      return 'Status (Server-Counts)'
    case 'network':
      return 'Netzwerk'
    default:
      return source
  }
}

function hasStuckItems(
  failure:
    | {
        stuckItems: Array<unknown>
      }
    | null
    | undefined,
): boolean {
  return !!failure && failure.stuckItems.length > 0
}

/**
 * Formatiert ein Diagnose-Payload für die `<pre>`-Anzeige. Große Objekte
 * kürzen wir, damit der Diagnose-Block nicht ausufert.
 */
function formatPayload(p: unknown): string {
  try {
    const s = JSON.stringify(p, null, 2)
    if (s.length > 4000) return s.slice(0, 4000) + '\n… (gekürzt)'
    return s
  } catch {
    return String(p)
  }
}

function formatRelativ(iso: string | null): string {
  if (!iso) return 'nie'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'gerade eben'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s her`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min her`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h her`
  const t = Math.floor(h / 24)
  return `${t} d her`
}
</script>

<template>
  <!-- Public Routes (Login, Passwort vergessen, First-Run-Setup): kein Header. -->
  <template v-if="istPublicRoute">
    <RouterView />
  </template>

  <!-- Geschützte Routes: Header + Sidebar-Indikatoren -->
  <div v-else class="app-shell">
    <div v-if="!online" class="offline-banner" role="status" aria-live="polite">
      <span class="dot"></span>
      Offline – Daten werden lokal gespeichert und sind verfügbar.
    </div>
    <header class="app-header">
      <div class="brand">
        <img src="/castel-logo.png" alt="" class="brand-logo" width="32" height="32" />
        <strong>{{
          settings.settings.companyName
            ? `${settings.settings.companyName} @ castel`
            : t('app.title')
        }}</strong>
      </div>
      <nav>
        <RouterLink to="/">{{ t('app.nav.dashboard') }}</RouterLink>
        <RouterLink to="/artikel">{{ t('app.nav.artikel') }}</RouterLink>
        <RouterLink to="/buchungen">{{ t('app.nav.buchungen') }}</RouterLink>
        <RouterLink to="/scan" class="scan-link">{{ t('app.nav.scan') }}</RouterLink>
      </nav>
      <div class="header-right">
        <RouterLink
          to="/einstellungen"
          class="settings-link"
          :title="t('app.nav.einstellungen')"
          :aria-label="t('app.nav.einstellungen')"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
            />
          </svg>
        </RouterLink>
        <div v-if="auth.session" class="user-chip" :title="`Angemeldet als ${auth.session.email}`">
          <span class="user-role">{{ auth.rolle ?? 'user' }}</span>
          <span class="user-email">{{ auth.session.email }}</span>
          <button type="button" class="logout-btn" title="Abmelden" @click="abmelden">⏻</button>
        </div>
        <button
          type="button"
          class="theme-toggle"
          :title="`Theme: ${themeUmschalter}`"
          @click="
            themeUmschalter =
              themeUmschalter === 'dark' ? 'light' : themeUmschalter === 'light' ? 'auto' : 'dark'
          "
        >
          {{ themeUmschalter === 'dark' ? '🌙' : themeUmschalter === 'light' ? '☀️' : '🖥️' }}
        </button>
        <button
          type="button"
          class="version-badge"
          :title="`Build ${commit}`"
          @click.stop="toggleVersion"
        >
          {{ versionLabel }}
        </button>
        <MindestbestandGlocke />
        <button
          type="button"
          class="sync-indicator"
          :class="`state-${syncZustand}`"
          :title="syncZustandTitel"
          @click.stop="toggleSyncPanel"
        >
          <span class="sync-dot" :class="`state-${syncZustand}`" aria-hidden="true"></span>
          <span class="sync-label">DB-Sync</span>
          <span
            v-if="sync.status.pending > 0"
            class="sync-indicator-badge"
            :title="`${sync.status.pending} ausstehend`"
          >
            {{ sync.status.pending }}
          </span>
        </button>
      </div>
    </header>
    <main>
      <RouterView />
    </main>

    <!-- Onboarding-Tutorial (Modal). Wird pro User genau einmal nach dem
         ersten Login automatisch geöffnet, solange der per-User-Marker
         `onboardingSeen` nicht gesetzt ist. -->
    <OnboardingTutorial :offen="tutorialOffen" @schliessen="tutorialOffen = false" />

    <!-- Mobile Bottom-Nav + FAB-Scanner.
         Erscheint nur, wenn data-layout="mobile" gesetzt ist (siehe CSS). -->
    <nav v-if="auth.istAngemeldet" class="bottom-nav" aria-label="Hauptnavigation">
      <RouterLink to="/" exact-active-class="active">
        <span class="bn-icon" aria-hidden="true">⌂</span>
        <span class="bn-label">{{ t('app.nav.dashboard') }}</span>
      </RouterLink>
      <RouterLink to="/artikel" active-class="active">
        <span class="bn-icon" aria-hidden="true">▦</span>
        <span class="bn-label">{{ t('app.nav.artikel') }}</span>
      </RouterLink>
      <RouterLink to="/scan" class="bn-fab" aria-label="Barcode-Scanner öffnen">
        <span class="bn-fab-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
            ></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
        </span>
        <span class="bn-label">Scan</span>
      </RouterLink>
      <RouterLink to="/buchungen" active-class="active">
        <span class="bn-icon" aria-hidden="true">⇄</span>
        <span class="bn-label">{{ t('app.nav.buchungen') }}</span>
      </RouterLink>
    </nav>

    <div v-if="versionOffen" class="version-panel" role="dialog">
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
      <p class="hint">
        Zum Reproduzieren:
        <code>git checkout {{ commit }}</code>
      </p>
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

    <div v-if="syncPanelOffen" class="sync-panel" role="dialog" aria-label="DB-Sync-Status">
      <header class="sync-panel-header">
        <h2>
          <span class="sync-dot" :class="`state-${syncZustand}`" aria-hidden="true"></span>
          DB-Sync
        </h2>
        <span class="sync-panel-state" :class="`state-${syncZustand}`">{{ syncZustandLabel }}</span>
      </header>

      <dl class="meta">
        <div>
          <dt>Letzter Sync</dt>
          <dd>
            {{ formatIso(sync.status.lastSyncAt) }}
            <span class="relativ">({{ formatRelativ(sync.status.lastSyncAt) }})</span>
          </dd>
        </div>
        <div>
          <dt>Server-Zeit</dt>
          <dd>{{ formatIso(sync.status.serverTime) }}</dd>
        </div>
        <div>
          <dt>Ausstehende Ops</dt>
          <dd>
            <span :class="sync.status.pending > 0 ? 'wert-warn' : 'wert-ok'">
              {{ sync.status.pending }}
            </span>
          </dd>
        </div>
        <div v-if="sync.status.lastError" class="flex items-center gap-2">
          <dt>Letzter Fehler</dt>
          <dd class="wert-fehler">{{ lastErrorMitVersion }}</dd>
          <button
            type="button"
            class="sync-diag-copy"
            :title="copyErrorStatus === 'ok' ? 'Kopiert' : 'Fehler in die Zwischenablage kopieren'"
            :aria-label="
              copyErrorStatus === 'ok' ? 'Kopiert' : 'Sync-Fehler in die Zwischenablage kopieren'
            "
            @click="copyError"
          >
            <svg
              v-if="copyErrorStatus === 'idle'"
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
              v-else-if="copyErrorStatus === 'ok'"
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
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
        </div>
      </dl>

      <div v-if="sync.status.lastFailure" class="sync-diag-block wert-fehler" role="alert">
        <strong>Diagnose</strong>
        <div class="flex items-center gap-2">
          <p v-if="sync.status.lastFailure.message" class="sync-diag-message">
            {{ sync.status.lastFailure.message }}
          </p>
          <button
            type="button"
            class="sync-diag-copy"
            :title="
              copyErrorStatus === 'ok' ? 'Kopiert' : 'Diagnose in die Zwischenablage kopieren'
            "
            :aria-label="
              copyErrorStatus === 'ok' ? 'Kopiert' : 'Sync-Diagnose in die Zwischenablage kopieren'
            "
            @click="copyError"
          >
            <svg
              v-if="copyErrorStatus === 'idle'"
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
              v-else-if="copyErrorStatus === 'ok'"
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
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
        </div>
        <dl class="sync-diag">
          <template v-if="sync.status.lastFailure.source">
            <dt>Schritt</dt>
            <dd>{{ sourceLabel(sync.status.lastFailure.source) }}</dd>
          </template>
          <template v-if="sync.status.lastFailure.status !== null">
            <dt>HTTP</dt>
            <dd>{{ sync.status.lastFailure.status }}</dd>
          </template>
          <template v-if="sync.status.lastFailure.code">
            <dt>Code</dt>
            <dd>{{ sync.status.lastFailure.code }}</dd>
          </template>
          <template v-if="sync.status.lastFailure.retryAfterMs">
            <dt>Retry-After</dt>
            <dd>{{ Math.round(sync.status.lastFailure.retryAfterMs / 1000) }}s</dd>
          </template>
          <template v-if="sync.status.lastFailure.rejectedItems > 0">
            <dt>Abgelehnt</dt>
            <dd>
              {{ sync.status.lastFailure.rejectedItems }} von
              {{ sync.status.pending + sync.status.lastFailure.rejectedItems }}
            </dd>
          </template>
          <template v-if="sync.status.nextRetryAt">
            <dt>Nächster Versuch</dt>
            <dd>{{ formatIso(sync.status.nextRetryAt) }}</dd>
          </template>
        </dl>
        <details v-if="hasStuckItems(sync.status.lastFailure)" class="sync-diag-details">
          <summary>
            Hängende Items ({{ sync.status.lastFailure!.stuckItems.length }} angezeigt)
          </summary>
          <ul class="sync-diag-list">
            <li v-for="it in sync.status.lastFailure!.stuckItems" :key="it.outboxId">
              <code class="mono">{{ it.entity }}/{{ it.op }}</code>
              <span class="muted"> {{ it.payloadId.slice(0, 8) }}… </span>
              <span class="wert-warn"> Versuch {{ it.attempts }}: {{ it.lastError }} </span>
            </li>
          </ul>
        </details>
        <details
          v-if="sync.status.lastFailure && sync.status.lastFailure.sampleErrors.length > 0"
          class="sync-diag-details"
        >
          <summary>Server-Antwort (Beispiele, max. 3)</summary>
          <ul class="sync-diag-list">
            <li v-for="(e, idx) in sync.status.lastFailure.sampleErrors" :key="idx">
              <code class="mono">{{ e.code }}</code>
              <span>{{ e.message }}</span>
              <span class="muted"> {{ e.id.slice(0, 8) }}… </span>
              <template v-if="e.code === 'INTERNAL'">
                <details v-if="e.stack" class="sync-diag-sub">
                  <summary>Stack</summary>
                  <pre class="mono sync-diag-pre">{{ e.stack }}</pre>
                </details>
                <details v-if="e.payload !== undefined" class="sync-diag-sub">
                  <summary>Payload (eingegangen)</summary>
                  <pre class="mono sync-diag-pre">{{ formatPayload(e.payload) }}</pre>
                </details>
              </template>
              <template v-else-if="typeof e.currentBestand === 'number'">
                <span class="wert-warn"> aktueller Bestand: {{ e.currentBestand }} </span>
              </template>
            </li>
          </ul>
        </details>
      </div>

      <h3>Datensätze</h3>
      <table class="sync-counts">
        <thead>
          <tr>
            <th>Tabelle</th>
            <th>Lokal</th>
            <th>Server</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in [
              {
                name: 'Artikel',
                local: sync.status.localCounts?.artikel,
                server: sync.status.serverCounts?.artikel,
              },
              {
                name: 'Standorte',
                local: sync.status.localCounts?.standorte,
                server: sync.status.serverCounts?.standorte,
              },
              {
                name: 'Kommissionen',
                local: sync.status.localCounts?.commission,
                server: sync.status.serverCounts?.commission,
              },
              {
                name: 'Buchungen',
                local: sync.status.localCounts?.buchungen,
                server: sync.status.serverCounts?.buchungen,
              },
            ]"
            :key="row.name"
          >
            <td>{{ row.name }}</td>
            <td>{{ row.local ?? '–' }}</td>
            <td>{{ row.server ?? '–' }}</td>
            <td
              :class="
                row.local != null && row.server != null && row.local !== row.server
                  ? 'wert-warn'
                  : 'wert-ok'
              "
            >
              {{
                row.local != null && row.server != null
                  ? (row.server - row.local > 0 ? '+' : '') + (row.server - row.local)
                  : '–'
              }}
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="syncDetail === 'fetching'" class="hint">Aktualisiere Status…</p>
      <p v-else-if="syncDetail === 'error'" class="hint wert-fehler">
        Konnte Server-Status nicht abrufen.
      </p>
      <p v-else-if="syncZustand === 'origin-unavailable'" class="hint wert-fehler">
        Server liefert 5xx (z. B. Cloudflare 502) — Origin ist nicht erreichbar.
        <span v-if="sync.status.nextRetryAt">
          Nächster automatischer Versuch um {{ formatIso(sync.status.nextRetryAt) }}.
        </span>
      </p>
      <p
        v-else-if="
          sync.status.localCounts &&
          sync.status.serverCounts &&
          zaehleAbweichungen(sync.status.localCounts, sync.status.serverCounts) === 0 &&
          sync.status.pending === 0
        "
        class="hint wert-ok"
      >
        Beide Datenbanken sind konsistent.
      </p>
      <p v-else-if="syncZustand === 'diverged'" class="hint wert-warn">
        Counts weichen ab — ein Sync holt fehlende Datensätze bzw. pusht lokale Änderungen.
      </p>
      <p v-else-if="sync.status.pending > 0" class="hint wert-warn">
        Lokale Änderungen warten auf den Push zum Server.
      </p>

      <div class="sync-panel-actions">
        <button
          type="button"
          class="primary"
          :disabled="sync.triggering || !online"
          @click="manuellSync"
        >
          {{ sync.triggering ? 'Synchronisiere…' : 'Jetzt synchronisieren' }}
        </button>
        <button type="button" @click="closeSyncPanel">Schließen</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: var(--app-vh, 100vh);
  display: flex;
  flex-direction: column;
}

.offline-banner {
  background: var(--warning);
  color: #1a1206;
  text-align: center;
  padding: 0.45rem 1rem;
  font-size: 0.85rem;
  font-weight: 500;
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: center;
}
.offline-banner .dot {
  width: 0.6rem;
  height: 0.6rem;
  background: #1a1206;
  border-radius: 50%;
  display: inline-block;
}

.app-header {
  display: flex;
  gap: 1.25rem;
  align-items: center;
  padding: 0.7rem 1.25rem;
  /* Im Android-Fullscreen (kein Browser-Chrome, kein Statusleiste) laeuft die
     WebView bis an den oberen Display-Rand. max() haelt den normalen Padding,
     env() schiebt den Header bei Cutout/Statusleiste nach unten. */
  padding-top: max(0.7rem, env(safe-area-inset-top, 0px));
  border-bottom: 1px solid var(--border);
  background: var(--bg-header);
  position: sticky;
  top: 0;
  z-index: 10;
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.brand strong {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
}

.app-header nav {
  display: flex;
  gap: 0.25rem;
  flex: 1;
}

.app-header nav a {
  color: var(--text-muted);
  padding: 0.4rem 0.7rem;
  border-radius: var(--radius-sm);
  font-weight: 500;
  font-size: 0.92rem;
  text-decoration: none;
  transition:
    background 0.15s,
    color 0.15s;
}

.app-header nav a:hover {
  background: rgba(99, 102, 241, 0.06);
  color: var(--text-strong);
  text-decoration: none;
}

.app-header nav a.router-link-active {
  background: var(--accent-bg);
  color: var(--accent);
}

.app-header nav a.scan-link {
  background: var(--accent-bg);
  color: var(--accent);
  margin-left: 0.5rem;
}

.app-header nav a.scan-link:hover {
  background: var(--accent-hover);
  text-decoration: none;
}

.app-header nav a.scan-link.router-link-active {
  background: var(--accent);
  color: white;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.settings-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: var(--radius-sm);
  color: var(--text);
  background: transparent;
  transition:
    background 0.15s,
    color 0.15s;
  text-decoration: none;
}

.settings-link:hover {
  background: rgba(99, 102, 241, 0.06);
  color: var(--text-strong);
  text-decoration: none;
}

.settings-link.router-link-active {
  background: var(--accent-bg);
  color: var(--accent);
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.2rem 0.4rem 0.2rem 0.5rem;
  font-size: 0.78rem;
}

.user-role {
  background: var(--accent-bg);
  color: var(--accent);
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.7rem;
}

.user-email {
  color: var(--text-strong);
  font-weight: 500;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logout-btn {
  background: transparent;
  border: none;
  padding: 0.15rem 0.4rem;
  font-size: 1rem;
  cursor: pointer;
  border-radius: 999px;
  line-height: 1;
}
.logout-btn:hover {
  background: rgba(248, 113, 113, 0.15);
  color: var(--danger);
}

.theme-toggle {
  padding: 0.3rem 0.5rem;
  font-size: 1rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.sync-indicator {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--bg-input);
  color: var(--text-muted);
  border: 1px solid var(--border-strong);
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-sm);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.sync-indicator:hover {
  background: var(--bg-card);
  color: var(--text-strong);
  border-color: var(--accent-border);
}

.sync-dot {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  display: inline-block;
  background: var(--text-muted);
  position: relative;
}
.sync-dot.state-synced {
  background: var(--success);
  box-shadow:
    0 0 0 4px rgba(74, 222, 128, 0.25),
    0 0 14px 4px rgba(74, 222, 128, 0.55);
}
.sync-dot.state-syncing {
  background: #fbbf24;
  box-shadow:
    0 0 0 4px rgba(251, 191, 36, 0.28),
    0 0 14px 4px rgba(251, 191, 36, 0.55);
  animation: syncPulse 1.2s ease-in-out infinite;
}
.sync-dot.state-pending,
.sync-dot.state-stale,
.sync-dot.state-diverged {
  background: #f59e0b;
  box-shadow:
    0 0 0 4px rgba(245, 158, 11, 0.28),
    0 0 14px 4px rgba(245, 158, 11, 0.55);
  animation: syncPulse 1.2s ease-in-out infinite;
}
.sync-dot.state-offline,
.sync-dot.state-error,
.sync-dot.state-origin-unavailable {
  background: var(--danger);
  box-shadow:
    0 0 0 4px rgba(248, 113, 113, 0.3),
    0 0 14px 4px rgba(248, 113, 113, 0.6);
}

.sync-indicator.state-synced {
  border-color: rgba(74, 222, 128, 0.5);
  background: rgba(74, 222, 128, 0.08);
  color: var(--text-strong);
}
.sync-indicator.state-syncing {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(251, 191, 36, 0.1);
  color: var(--text-strong);
}
.sync-indicator.state-pending,
.sync-indicator.state-stale,
.sync-indicator.state-diverged {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.1);
  color: var(--text-strong);
}
.sync-indicator.state-offline,
.sync-indicator.state-error,
.sync-indicator.state-origin-unavailable {
  border-color: rgba(248, 113, 113, 0.6);
  background: rgba(248, 113, 113, 0.12);
  color: var(--text-strong);
}

.sync-indicator-badge {
  background: #f59e0b;
  color: #1a1206;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  min-width: 1.5rem;
  text-align: center;
}

@keyframes syncPulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.18);
    opacity: 0.85;
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.sync-panel {
  position: fixed;
  top: 4rem;
  right: 1rem;
  width: min(34rem, 96vw);
  max-height: calc(var(--app-vh, 100vh) - 5rem);
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 1rem 1.25rem;
  box-shadow: var(--shadow-pop);
  z-index: 1000;
}
.sync-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.sync-panel-header h2 {
  margin: 0;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.sync-panel-state {
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-muted);
}
.sync-panel-state.state-synced {
  background: rgba(74, 222, 128, 0.18);
  color: var(--success);
}
.sync-panel-state.state-syncing {
  background: var(--accent-bg);
  color: var(--accent);
}
.sync-panel-state.state-pending,
.sync-panel-state.state-stale,
.sync-panel-state.state-diverged {
  background: rgba(245, 158, 11, 0.18);
  color: #b45309;
}
.sync-panel-state.state-offline,
.sync-panel-state.state-error,
.sync-panel-state.state-origin-unavailable {
  background: rgba(248, 113, 113, 0.18);
  color: var(--danger);
}

.sync-panel h3 {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin: 0.75rem 0 0.4rem;
}

.sync-panel .meta {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.sync-panel .meta > div {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.sync-panel .meta dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.sync-panel .meta dd {
  font-family: var(--mono);
  font-size: 0.85rem;
  margin: 0;
  overflow-wrap: anywhere;
}
.sync-panel .meta .relativ {
  font-family: inherit;
  color: var(--text-muted);
  font-size: 0.75rem;
  margin-left: 0.4rem;
}

.wert-ok {
  color: var(--success);
  font-weight: 600;
}
.wert-warn {
  color: #b45309;
  font-weight: 600;
}
.wert-fehler {
  color: var(--danger);
  font-weight: 600;
}

.sync-counts {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  margin-bottom: 0.5rem;
  table-layout: fixed;
}
.sync-counts th,
.sync-counts td {
  text-align: left;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.sync-counts th:nth-child(1),
.sync-counts td:nth-child(1) {
  width: 40%;
}
.sync-counts th:nth-child(2),
.sync-counts td:nth-child(2),
.sync-counts th:nth-child(3),
.sync-counts td:nth-child(3) {
  width: 22%;
  text-align: right;
}
.sync-counts th:nth-child(4),
.sync-counts td:nth-child(4) {
  width: 16%;
  text-align: right;
}
.sync-counts th {
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.sync-counts td {
  font-family: var(--mono);
}

.sync-diag {
  margin: 0.35rem 0 0 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.15rem 0.6rem;
  font-size: 0.82rem;
}
.sync-diag-block {
  margin-top: 0.6rem;
  padding: 0.5rem 0.6rem;
  background: rgba(248, 113, 113, 0.08);
  border-left: 3px solid var(--danger);
  border-radius: 0.25rem;
  font-size: 0.85rem;
}
.sync-diag-block strong {
  display: block;
  margin-bottom: 0.25rem;
}
.sync-diag-message {
  margin: 0.2rem 0 0.35rem;
  font-size: 0.82rem;
  font-family: var(--mono);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.sync-diag dt {
  color: var(--text-muted);
}
.sync-diag dd {
  margin: 0;
  font-family: var(--mono);
}
.sync-diag-details {
  margin-top: 0.4rem;
  font-size: 0.82rem;
}
.sync-diag-details summary {
  cursor: pointer;
  color: var(--text-muted);
  user-select: none;
}
.sync-diag-list {
  list-style: none;
  margin: 0.35rem 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.sync-diag-list li {
  display: block;
  font-size: 0.8rem;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.sync-diag-list .mono,
.sync-diag-list code {
  display: inline-block;
  margin-right: 0.3rem;
  word-break: break-all;
}
.sync-diag-list .mono {
  font-family: var(--mono);
  background: rgba(255, 255, 255, 0.05);
  padding: 0 0.3rem;
  border-radius: 0.2rem;
}
.sync-diag-list .muted {
  color: var(--text-muted);
}
.sync-diag-list .wert-warn {
  color: var(--text-strong);
  font-family: var(--mono);
}
.sync-diag-sub {
  margin: 0.25rem 0 0 0.5rem;
  font-size: 0.78rem;
}
.sync-diag-sub summary {
  cursor: pointer;
  color: var(--text-muted);
}
.sync-diag-pre {
  margin: 0.25rem 0 0 0;
  padding: 0.4rem 0.6rem;
  background: rgba(0, 0, 0, 0.35);
  color: var(--text);
  font-size: 0.75rem;
  line-height: 1.35;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 18rem;
}

.sync-panel .hint {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin: 0.5rem 0;
}

.sync-panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
.sync-panel-actions button {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}
.sync-panel-actions button.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.sync-panel-actions button.primary:hover:not(:disabled) {
  filter: brightness(1.08);
}
.sync-panel-actions button.danger {
  background: var(--danger);
  color: white;
  border-color: var(--danger);
}
.sync-panel-actions button.danger:hover:not(:disabled) {
  filter: brightness(1.08);
}
.sync-panel-actions button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sync-cache-confirm {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.sync-cache-confirm p {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.sync-cache-confirm-detail {
  color: var(--text-muted);
  font-size: 0.78rem !important;
}

.version-badge {
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
  top: 4rem;
  right: 1rem;
  width: 22rem;
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 1rem 1.25rem;
  box-shadow: var(--shadow-pop);
  z-index: 1000;
}

.version-panel h2 {
  margin: 0 0 0.75rem;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.version-panel .meta {
  grid-template-columns: 1fr;
  gap: 0.4rem 0;
  margin-bottom: 0.75rem;
}

.version-panel .meta dt {
  font-size: 0.72rem;
}

.version-panel dd {
  font-family: var(--mono);
  font-size: 0.85rem;
}

.version-panel code {
  background: var(--bg-input);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 0.8rem;
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

.version-panel .version-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
}

.version-panel .version-actions button {
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

.sync-diag-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  font-family: var(--mono);
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 0.25rem;
  cursor: pointer;
  flex-shrink: 0;
}

.sync-diag-copy:hover {
  color: var(--text-strong);
  border-color: var(--text-muted);
}

.sync-diag-copy .icon {
  width: 0.95rem;
  height: 0.95rem;
  display: block;
}

.sync-diag-copy.state-ok {
  color: var(--accent);
  border-color: var(--accent-border);
}

.sync-diag-copy.state-fehler {
  color: #e35d6a;
  border-color: #e35d6a;
}

main {
  flex: 1;
}

/* ============================================================
   Mobile Bottom-Nav
   ============================================================ */
.bottom-nav {
  display: none;
}

:root[data-layout='mobile'] .app-header {
  /* Auf Mobile nur Brand + Theme + Sync — Rest wandert in Bottom-Nav/Profil. */
  padding: 0.6rem 0.85rem;
  padding-top: max(0.6rem, env(safe-area-inset-top, 0px));
}
:root[data-layout='mobile'] .app-header nav {
  display: none;
}
:root[data-layout='mobile'] .user-chip .user-email {
  display: none;
}
:root[data-layout='mobile'] .version-badge {
  display: none;
}

:root[data-layout='mobile'] .sync-panel,
:root[data-layout='mobile'] .version-panel {
  left: 1rem;
  right: 1rem;
  width: auto;
}

:root[data-layout='mobile'] .bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  align-items: stretch;
  background: var(--bg-card);
  border-top: 1px solid var(--border);
  padding: 0.35rem 0.25rem calc(0.35rem + env(safe-area-inset-bottom));
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.18);
}
:root[data-layout='mobile'] .bottom-nav a {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  text-decoration: none;
  color: var(--text-muted);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.25rem;
  font-size: 0.72rem;
  font-weight: 500;
  min-height: 2.75rem;
}
:root[data-layout='mobile'] .bottom-nav a.active {
  color: var(--accent);
}
:root[data-layout='mobile'] .bottom-nav a .bn-icon {
  font-size: 1.15rem;
  line-height: 1;
}
:root[data-layout='mobile'] .bottom-nav a.bn-fab {
  background: var(--accent);
  color: white;
  margin: -0.85rem 0.25rem 0;
  border-radius: 1rem;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
  position: relative;
}
:root[data-layout='mobile'] .bottom-nav a.bn-fab .bn-fab-icon {
  width: 1.65rem;
  height: 1.65rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
:root[data-layout='mobile'] .bottom-nav a.bn-fab svg {
  width: 100%;
  height: 100%;
  stroke: white;
  fill: none;
}
:root[data-layout='mobile'] .bottom-nav a.bn-fab:hover {
  background: var(--accent-hover);
  text-decoration: none;
  color: white;
}

@media (max-width: 720px) {
  .app-header {
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    padding-top: max(0.6rem, env(safe-area-inset-top, 0px));
  }
  .app-header nav {
    order: 3;
    flex-basis: 100%;
    justify-content: center;
    flex-wrap: wrap;
  }
  .brand {
    flex: 1;
  }
  /* Sync-Panel: auf Mobile schmaler, sonst rutscht es aus dem Viewport. */
  .sync-panel {
    width: calc(100vw - 1rem);
    right: 0.5rem;
    left: 0.5rem;
    max-width: none;
  }
  /* Mindestbestand-Dropdown: bleibt Drop-Down-Logik, schmaler Rand. */
  .mindestbestand-dropdown {
    right: -0.5rem;
  }
  .user-email {
    display: none;
  }
}
</style>
