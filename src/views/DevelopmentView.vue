<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { clearAppCacheAndReload } from '../services/sync/clear-cache'
import { holeAktiveUserliste, type UserDto } from '../auth/users'
import { resetLocalDbAndPull, wipeLocalDbWithoutPull } from '../services/sync/reset-local-db'
import {
  checkUpdate,
  fetchUpdateState,
  requestUpdate,
  type UpdateCheck,
  type UpdateState,
} from '../services/admin/update'
import {
  collectReseedPlan,
  reseedServer,
  ReseedGuardError,
  type ReseedPlan,
} from '../services/sync/reseed-server'

const { t } = useI18n()
const router = useRouter()

type ResetPhase = 'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'

/** Grace period to show the wipe/pull result before the page reloads. */
const RELOAD_DELAY_MS = 3_000
const RELOAD_SEK = RELOAD_DELAY_MS / 1000

const cachePhase = ref<ResetPhase>('idle')
const cacheFehler = ref<string | null>(null)
const dbPhase = ref<ResetPhase>('idle')
const dbFehler = ref<string | null>(null)
const dbErfolg = ref<string | null>(null)
const wipePhase = ref<ResetPhase>('idle')
const wipeFehler = ref<string | null>(null)
const wipeErfolg = ref<string | null>(null)
const serverDbPhase = ref<ResetPhase>('idle')
const serverDbFehler = ref<string | null>(null)
const serverDbErfolg = ref<string | null>(null)
const reseedPhase = ref<ResetPhase>('idle')
const reseedFehler = ref<string | null>(null)
const reseedErfolg = ref<string | null>(null)
const reseedPlan = ref<ReseedPlan | null>(null)
const reseedGuardFehler = ref(false)

const updatePhase = ref<'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'>('idle')
const updateFehler = ref<string | null>(null)
const updateState = ref<UpdateState | null>(null)
/** Der Server ist während des Stack-Neustarts kurz nicht erreichbar. */
const updateServerAus = ref(false)
const updateCheck = ref<UpdateCheck | null>(null)
const updateCheckLaeuft = ref(false)
const updateCheckFehler = ref<string | null>(null)
/** Grund, warum der Server das Update nicht selbst starten konnte. */
const updateStartGrund = ref<string | null>(null)
const updateFallbackOffen = ref(false)
/** Zeigt die Webhook-Info-Karte (externes System kann Update ausloesen). */
const updateWebhookInfo = ref(false)
let updateTimer: ReturnType<typeof setInterval> | null = null

/** API-Basis-URL fuer den Webhook-Endpunkt. */
const apiBaseUrl = computed(() => getApiBaseUrl())
/** Curl-Beispiel fuer den Inbound-Webhook (Token-Placeholder bleibt offentlich). */
const webhookCurl = computed(() => {
  const base = apiBaseUrl.value
  const url = base ? `${base}/api/admin/update/webhook` : '<API-URL>/api/admin/update/webhook'
  const tokenHint = '$(grep -m1 UPDATE_WEBHOOK_TOKEN .env | cut -d= -f2-)'
  return `curl -X POST ${url} \\\n  -H "X-Deploy-Token: ${tokenHint}" \\\n  -H "Content-Type: application/json" \\\n  -d '{}'`
})

/** Anzeigename des aktuellen Schritts - unbekannte Schritte bleiben leer. */
const updateStepLabel = computed(() => {
  const step = updateState.value?.step
  if (!step) return null
  const key = `view.development.updateStep.${step}`
  const translated = t(key)
  return translated === key ? null : translated
})

type Geraet = {
  id: string
  userId: string
  email: string | null
  rolle: string | null
  fingerprint: { userAgent?: string; appVersion?: string; ip?: string }
  resetAm: string | null
  registriertAm: string
  zuletztGesehenAm: string
  /** Letzter Sync-Fehler (falls vorhanden). */
  lastSyncErrorAt: string | null
  lastSyncErrorCode: string | null
  lastSyncErrorMessage: string | null
}

type SyncErrorReport = {
  id: string
  deviceId: string
  userId: string
  userEmail: string | null
  userName: string | null
  occurredAt: string
  source: string
  code: string
  message: string
  httpStatus: number | null
  stack: string | null
  payload: unknown
  diagnostics: unknown
  createdAt: string
}

const geraetePhase = ref<'idle' | 'laufend' | 'fehler'>('idle')
const geraeteFehler = ref<string | null>(null)
const geraeteListe = ref<Geraet[]>([])
const geraeteUserListe = ref<UserDto[]>([])
const geraeteSelectedUser = ref<string>('')

// Aggregierte Sync-Fehler aller Geräte (Admin-Overblick).
const syncErrorAllePhase = ref<'idle' | 'laufend' | 'fehler'>('idle')
const syncErrorAlleFehler = ref<string | null>(null)
const syncErrorAlleListe = ref<SyncErrorReport[]>([])
const syncErrorAlleTotal = ref(0)
const syncErrorAlleLimit = ref(50)
const syncErrorAlleOffset = ref(0)

// Sync-Fehler-Report Bereich (ausklappbar unter der Geraetetabelle).
const syncErrorExpandedDeviceId = ref<string>('')
const syncErrorExpandedDeviceLabel = ref<string>('')
const syncErrorExpandedReports = ref<
  {
    id: string
    occurredAt: string
    source: string
    code: string
    message: string
    httpStatus: number | null
    stack: string | null
    payload: unknown
    diagnostics: unknown
    createdAt: string
  }[]
>([])
const syncErrorExpandedPhase = ref<'idle' | 'laufend' | 'fehler'>('idle')
const syncErrorExpandedFehler = ref<string | null>(null)

onMounted(() => {
  void ladeGeraete()
  void ladeSyncErrorAlle()
  void ladeUserListe()
  void updateCheckLaden()
})

function cacheFrageStarten(): void {
  cachePhase.value = 'bestaetigen'
  cacheFehler.value = null
}
function cacheAbbrechen(): void {
  cachePhase.value = 'idle'
  cacheFehler.value = null
}
async function cacheBestaetigen(): Promise<void> {
  cachePhase.value = 'laufend'
  cacheFehler.value = null
  try {
    await clearAppCacheAndReload()
    cachePhase.value = 'idle'
  } catch (e) {
    cacheFehler.value = e instanceof Error ? e.message : String(e)
    cachePhase.value = 'fehler'
  }
}

function dbFrageStarten(): void {
  dbPhase.value = 'bestaetigen'
  dbFehler.value = null
  dbErfolg.value = null
}
function dbAbbrechen(): void {
  dbPhase.value = 'idle'
  dbFehler.value = null
  dbErfolg.value = null
}
async function dbBestaetigen(): Promise<void> {
  dbPhase.value = 'laufend'
  dbFehler.value = null
  dbErfolg.value = null
  try {
    const ergebnis = await resetLocalDbAndPull({
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
    })
    dbErfolg.value = t('view.development.lokaleDBErgebnis', {
      db: ergebnis.deletedDb,
      artikel: ergebnis.pulled.artikel,
      standorte: ergebnis.pulled.standorte,
      commission: ergebnis.pulled.commission,
      buchungen: ergebnis.pulled.buchungen,
      einstellungen: ergebnis.pulled.einstellungen,
      mindestbestandEreignisse: ergebnis.pulled.mindestbestandEreignisse,
    })
    dbPhase.value = 'fertig'
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
  } catch (e) {
    dbFehler.value = e instanceof Error ? e.message : String(e)
    dbPhase.value = 'fehler'
  }
}

function wipeFrageStarten(): void {
  wipePhase.value = 'bestaetigen'
  wipeFehler.value = null
  wipeErfolg.value = null
}
function wipeAbbrechen(): void {
  wipePhase.value = 'idle'
  wipeFehler.value = null
  wipeErfolg.value = null
}
async function wipeBestaetigen(): Promise<void> {
  wipePhase.value = 'laufend'
  wipeFehler.value = null
  wipeErfolg.value = null
  try {
    // Deliberately no snapshot pull: the empty state stays visible until the
    // regular sync worker refills the DB after the reload.
    const ergebnis = await wipeLocalDbWithoutPull()
    wipeErfolg.value = t('view.development.nurLeerenErgebnis', { db: ergebnis.deletedDb })
    wipePhase.value = 'fertig'
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
  } catch (e) {
    wipeFehler.value = e instanceof Error ? e.message : String(e)
    wipePhase.value = 'fehler'
  }
}

function serverDbFrageStarten(): void {
  serverDbPhase.value = 'bestaetigen'
  serverDbFehler.value = null
}
function serverDbAbbrechen(): void {
  serverDbPhase.value = 'idle'
  serverDbFehler.value = null
  serverDbErfolg.value = null
}
async function serverDbBestaetigen(): Promise<void> {
  serverDbPhase.value = 'laufend'
  serverDbFehler.value = null
  serverDbErfolg.value = null
  try {
    await apiFetch('/api/admin/db/clear', { method: 'POST' })
    serverDbPhase.value = 'idle'
    serverDbErfolg.value = t('view.development.serverDbGeloescht')
    setTimeout(() => (serverDbErfolg.value = null), 4000)
  } catch (e) {
    serverDbFehler.value = e instanceof Error ? e.message : String(e)
    serverDbPhase.value = 'fehler'
  }
}

async function ladeGeraete(): Promise<void> {
  geraetePhase.value = 'laufend'
  geraeteFehler.value = null
  try {
    const data = await apiFetch<{ geraete: Geraet[] }>('/api/admin/geraete')
    geraeteListe.value = data.geraete
    geraetePhase.value = 'idle'
  } catch (e) {
    geraeteFehler.value = e instanceof Error ? e.message : String(e)
    geraetePhase.value = 'fehler'
  }
}

async function ladeSyncErrorAlle(): Promise<void> {
  syncErrorAllePhase.value = 'laufend'
  syncErrorAlleFehler.value = null
  try {
    const data = await apiFetch<{
      items: SyncErrorReport[]
      limit: number
      offset: number
      total: number
    }>(
      `/api/admin/sync-error-reports?limit=${syncErrorAlleLimit.value}&offset=${syncErrorAlleOffset.value}`,
    )
    syncErrorAlleListe.value = data.items
    syncErrorAlleTotal.value = data.total
    syncErrorAllePhase.value = 'idle'
  } catch (e) {
    syncErrorAlleFehler.value = e instanceof Error ? e.message : String(e)
    syncErrorAllePhase.value = 'fehler'
  }
}

async function ladeSyncErrorReports(deviceId: string, deviceLabel: string): Promise<void> {
  // Wenn dasselbe Geraet schon erweitert ist, wieder einklappen.
  if (syncErrorExpandedDeviceId.value === deviceId && syncErrorExpandedReports.value.length > 0) {
    syncErrorExpandedDeviceId.value = ''
    syncErrorExpandedDeviceLabel.value = ''
    syncErrorExpandedReports.value = []
    syncErrorExpandedPhase.value = 'idle'
    syncErrorExpandedFehler.value = null
    return
  }
  syncErrorExpandedDeviceId.value = deviceId
  syncErrorExpandedDeviceLabel.value = deviceLabel
  syncErrorExpandedReports.value = []
  syncErrorExpandedPhase.value = 'laufend'
  syncErrorExpandedFehler.value = null
  try {
    const data = await apiFetch<{ reports: unknown[] }>(
      `/api/admin/geraete/${encodeURIComponent(deviceId)}/sync-error-reports`,
    )
    syncErrorExpandedReports.value = data.reports as {
      id: string
      occurredAt: string
      source: string
      code: string
      message: string
      httpStatus: number | null
      stack: string | null
      payload: unknown
      diagnostics: unknown
      createdAt: string
    }[]
    syncErrorExpandedPhase.value = 'idle'
  } catch (e) {
    syncErrorExpandedFehler.value = e instanceof Error ? e.message : String(e)
    syncErrorExpandedPhase.value = 'fehler'
  }
}

async function ladeUserListe(): Promise<void> {
  try {
    geraeteUserListe.value = await holeAktiveUserliste()
  } catch {
    // User-Liste ist optional fuer die Massen-Aktion.
  }
}

async function setzeGeraetReset(deviceId: string, setzen: boolean): Promise<void> {
  try {
    await apiFetch<{ matched: number }>(
      `/api/admin/geraete/${encodeURIComponent(deviceId)}/reset`,
      { method: 'POST', body: { reset: setzen } },
    )
    geraeteFehler.value = null
    await ladeGeraete()
  } catch (e) {
    geraeteFehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function setzeUserReset(userId: string, setzen: boolean): Promise<void> {
  try {
    await apiFetch<{ matched: number }>(
      `/api/admin/geraete/user/${encodeURIComponent(userId)}/reset`,
      { method: 'POST', body: { reset: setzen } },
    )
    geraeteFehler.value = null
    await ladeGeraete()
  } catch (e) {
    geraeteFehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function reseedFrageStarten(): Promise<void> {
  reseedPhase.value = 'laufend'
  reseedFehler.value = null
  reseedErfolg.value = null
  reseedGuardFehler.value = false
  try {
    reseedPlan.value = await collectReseedPlan()
    reseedPhase.value = 'bestaetigen'
  } catch (e) {
    reseedFehler.value = e instanceof Error ? e.message : String(e)
    reseedPhase.value = 'fehler'
  }
}
function reseedAbbrechen(): void {
  reseedPhase.value = 'idle'
  reseedFehler.value = null
  reseedErfolg.value = null
  reseedGuardFehler.value = false
}
async function reseedBestaetigen(force: boolean): Promise<void> {
  reseedPhase.value = 'laufend'
  reseedFehler.value = null
  try {
    const ergebnis = await reseedServer({
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
      force,
    })
    reseedErfolg.value = t('view.development.reseedErgebnis', {
      artikel: ergebnis.queued.artikel,
      hersteller: ergebnis.queued.hersteller,
      standorte: ergebnis.queued.standorte,
      kommission: ergebnis.queued.kommission,
      buchungen: ergebnis.queued.buchungen,
      einstellungen: ergebnis.queued.einstellungen,
      pendingLeft: ergebnis.pendingLeft,
      quarantinedLeft: ergebnis.quarantinedLeft,
    })
    reseedPhase.value = 'fertig'
    setTimeout(() => {
      reseedErfolg.value = null
      reseedPhase.value = 'idle'
    }, 15_000)
  } catch (e) {
    if (e instanceof ReseedGuardError) {
      // Guard tripped: offer the explicit force path in the confirm dialog.
      reseedGuardFehler.value = true
      reseedFehler.value = e.message
      reseedPhase.value = 'bestaetigen'
      return
    }
    reseedFehler.value = e instanceof Error ? e.message : String(e)
    reseedPhase.value = 'fehler'
  }
}

async function updateCheckLaden(): Promise<void> {
  updateCheckLaeuft.value = true
  updateCheckFehler.value = null
  try {
    updateCheck.value = await checkUpdate()
  } catch (e) {
    updateCheckFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    updateCheckLaeuft.value = false
  }
}

async function updateFrageStarten(): Promise<void> {
  updatePhase.value = 'bestaetigen'
  updateFehler.value = null
  updateServerAus.value = false
  updateStartGrund.value = null
}
function updateAbbrechen(): void {
  updatePhase.value = 'idle'
  updateFehler.value = null
  updateServerAus.value = false
  updateStartGrund.value = null
  updatePollingStoppen()
}
function updatePollingStoppen(): void {
  if (updateTimer !== null) {
    clearInterval(updateTimer)
    updateTimer = null
  }
}
async function updateBestaetigen(): Promise<void> {
  updatePhase.value = 'laufend'
  updateFehler.value = null
  updateServerAus.value = false
  updateStartGrund.value = null
  try {
    const result = await requestUpdate()
    updateState.value = result.state
    if (!result.started) {
      // Der Server konnte den Updater nicht starten (z. B. kein Docker-Socket).
      // Der Marker steht trotzdem - der Befehl unten bleibt als Fallback.
      updateStartGrund.value = result.reason ?? 'UNKNOWN'
      updateFallbackOffen.value = true
      updatePhase.value = 'fehler'
      updateFehler.value = t('view.development.updateStartFehler')
      return
    }
  } catch (e) {
    updateFehler.value = e instanceof Error ? e.message : String(e)
    updatePhase.value = 'fehler'
    return
  }
  await updateStatusLaden()
  updatePollingStarten()
}
function updatePollingStarten(): void {
  updatePollingStoppen()
  updateTimer = setInterval(() => {
    void updateStatusLaden()
  }, 3000)
}
async function updateStatusLaden(): Promise<void> {
  try {
    const state = await fetchUpdateState()
    updateState.value = state
    updateServerAus.value = false
    if (state.phase === 'done') {
      updatePhase.value = 'fertig'
      updatePollingStoppen()
    } else if (state.phase === 'failed') {
      updatePhase.value = 'fehler'
      updateFehler.value = state.message
      updatePollingStoppen()
    } else {
      updatePhase.value = 'laufend'
    }
  } catch (e) {
    // Waehrend des Neustarts ist der API-Container kurz weg. Das ist kein
    // Fehler - der Poller wartet einfach weiter.
    updateServerAus.value = true
    if (updatePhase.value === 'laufend') return
    updateFehler.value = e instanceof Error ? e.message : String(e)
    updatePhase.value = 'fehler'
  }
}

onBeforeUnmount(() => {
  updatePollingStoppen()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.development.h1') }}</h1>
      <p class="hint">{{ t('view.development.intro') }}</p>
    </header>

    <h2>{{ t('view.development.lokalerCache') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.lokalerCacheHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="cachePhase === 'laufend'"
          @click="cacheFrageStarten"
        >
          {{
            cachePhase === 'laufend'
              ? t('view.development.leert')
              : t('view.development.cacheLeeren')
          }}
        </button>
      </div>
    </div>

    <div v-if="cachePhase !== 'idle'" class="confirm" role="alertdialog">
      <p>
        <strong>{{ t('view.development.cacheFrage') }}</strong>
      </p>
      <p class="hint">{{ t('view.development.cacheDetail') }}</p>
      <p v-if="cachePhase === 'fehler' && cacheFehler" class="wert-fehler">{{ cacheFehler }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="cachePhase === 'laufend'"
          @click="cacheBestaetigen"
        >
          {{ cachePhase === 'laufend' ? t('view.development.leert') : t('view.common.ja') }}
        </button>
        <button type="button" :disabled="cachePhase === 'laufend'" @click="cacheAbbrechen">
          {{ t('view.common.abbrechen') }}
        </button>
      </div>
    </div>

    <h2>{{ t('view.development.lokaleDB') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.lokaleDBHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="dbPhase === 'laufend' || dbPhase === 'fertig'"
          @click="dbFrageStarten"
        >
          {{
            dbPhase === 'laufend'
              ? t('view.development.loeschtUndNeuLaden')
              : dbPhase === 'fertig'
                ? t('view.development.dbFertig')
                : t('view.development.lokaleDBLoeschen')
          }}
        </button>
      </div>
    </div>

    <div v-if="dbPhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="dbPhase === 'fertig'">
        <p class="hint hint-ok">{{ dbErfolg }}</p>
        <p class="hint">{{ t('view.development.neuladenIn', { sek: RELOAD_SEK }) }}</p>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.development.lokaleDBFrage') }}</strong>
        </p>
        <p class="hint">{{ t('view.development.lokaleDBDetail') }}</p>
        <p class="hint">{{ t('view.development.lokaleDBWarnung') }}</p>
        <p v-if="dbPhase === 'fehler' && dbFehler" class="wert-fehler">{{ dbFehler }}</p>
        <p v-if="dbPhase === 'fehler'" class="hint">{{ t('view.development.neustartHinweis') }}</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="dbPhase === 'laufend'"
            @click="dbBestaetigen"
          >
            {{
              dbPhase === 'laufend'
                ? t('view.development.loeschtUndNeuLaden')
                : t('view.development.jaLoeschen')
            }}
          </button>
          <button type="button" :disabled="dbPhase === 'laufend'" @click="dbAbbrechen">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>

    <h2>{{ t('view.development.nurLeeren') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.nurLeerenHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="wipePhase === 'laufend' || wipePhase === 'fertig'"
          @click="wipeFrageStarten"
        >
          {{
            wipePhase === 'laufend'
              ? t('view.development.loeschtOhneSnapshot')
              : wipePhase === 'fertig'
                ? t('view.development.wipeFertig')
                : t('view.development.nurLeerenBtn')
          }}
        </button>
      </div>
    </div>

    <div v-if="wipePhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="wipePhase === 'fertig'">
        <p class="hint hint-ok">{{ wipeErfolg }}</p>
        <p class="hint">{{ t('view.development.neuladenIn', { sek: RELOAD_SEK }) }}</p>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.development.nurLeerenFrage') }}</strong>
        </p>
        <p class="hint">{{ t('view.development.nurLeerenDetail') }}</p>
        <p class="hint">{{ t('view.development.nurLeerenWarnung') }}</p>
        <p v-if="wipePhase === 'fehler' && wipeFehler" class="wert-fehler">{{ wipeFehler }}</p>
        <p v-if="wipePhase === 'fehler'" class="hint">
          {{ t('view.development.neustartHinweis') }}
        </p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="wipePhase === 'laufend'"
            @click="wipeBestaetigen"
          >
            {{
              wipePhase === 'laufend'
                ? t('view.development.loeschtOhneSnapshot')
                : t('view.development.jaNurLeeren')
            }}
          </button>
          <button type="button" :disabled="wipePhase === 'laufend'" @click="wipeAbbrechen">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>

    <h2>{{ t('view.development.serverDB') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.serverDBHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="serverDbPhase === 'laufend'"
          @click="serverDbFrageStarten"
        >
          {{
            serverDbPhase === 'laufend'
              ? t('view.development.leertServer')
              : t('view.development.serverDBLeeren')
          }}
        </button>
      </div>
    </div>

    <div v-if="serverDbPhase !== 'idle'" class="confirm" role="alertdialog">
      <p>
        <strong>{{ t('view.development.serverDBFrage') }}</strong>
      </p>
      <p class="hint">{{ t('view.development.serverDBDetail') }}</p>
      <p class="hint">{{ t('view.development.serverDBWarnung') }}</p>
      <p v-if="serverDbPhase === 'fehler' && serverDbFehler" class="wert-fehler">
        {{ serverDbFehler }}
      </p>
      <p v-if="serverDbErfolg" class="hint hint-ok">{{ serverDbErfolg }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="serverDbPhase === 'laufend'"
          @click="serverDbBestaetigen"
        >
          {{
            serverDbPhase === 'laufend'
              ? t('view.development.leertServer')
              : t('view.development.jaServerLoeschen')
          }}
        </button>
        <button type="button" :disabled="serverDbPhase === 'laufend'" @click="serverDbAbbrechen">
          {{ t('view.common.abbrechen') }}
        </button>
      </div>
    </div>

    <h2>{{ t('view.development.bulkTitel') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.bulkHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="primary"
          @click="router.push({ name: 'einstellungen-entwicklung-buchungen-loeschen' })"
        >
          {{ t('view.development.bulkOffeneSeite') }}
        </button>
      </div>
      <p class="hint">{{ t('view.development.bulkOffeneSeiteHint') }}</p>
    </div>

    <h2>{{ t('view.development.reseedServer') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.reseedServerHint') }}</p>
      <div class="actions">
        <button
          type="button"
          :disabled="reseedPhase === 'laufend' || reseedPhase === 'fertig'"
          @click="reseedFrageStarten"
        >
          {{
            reseedPhase === 'laufend'
              ? t('view.development.reseedLaedt')
              : reseedPhase === 'fertig'
                ? t('view.development.reseedFertig')
                : t('view.development.reseedBtn')
          }}
        </button>
      </div>
    </div>

    <div v-if="reseedPhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="reseedPhase === 'fertig'">
        <p class="hint hint-ok">{{ reseedErfolg }}</p>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.development.reseedFrage') }}</strong>
        </p>
        <p v-if="reseedPlan" class="hint">
          {{
            t('view.development.reseedDetail', {
              artikel: reseedPlan.artikel,
              hersteller: reseedPlan.hersteller,
              standorte: reseedPlan.standorte,
              kommission: reseedPlan.kommission,
              buchungen: reseedPlan.buchungen,
              einstellungen: reseedPlan.einstellungen,
            })
          }}
        </p>
        <p class="hint">{{ t('view.development.reseedWarnung') }}</p>
        <p v-if="reseedPhase === 'fehler' && reseedFehler" class="wert-fehler">
          {{ reseedFehler }}
        </p>
        <div class="actions">
          <button
            type="button"
            :disabled="reseedPhase === 'laufend'"
            @click="reseedBestaetigen(false)"
          >
            {{
              reseedPhase === 'laufend'
                ? t('view.development.reseedLaedt')
                : t('view.development.reseedBtnJa')
            }}
          </button>
          <button
            v-if="reseedGuardFehler"
            type="button"
            class="danger"
            :disabled="reseedPhase === 'laufend'"
            @click="reseedBestaetigen(true)"
          >
            {{ t('view.development.reseedForceBtn') }}
          </button>
          <button type="button" :disabled="reseedPhase === 'laufend'" @click="reseedAbbrechen">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>

    <h2>{{ t('view.development.geräte') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.geräteHint') }}</p>
      <div class="actions" style="margin-bottom: 0.8rem">
        <button type="button" :disabled="geraetePhase === 'laufend'" @click="ladeGeraete">
          {{ geraetePhase === 'laufend' ? 'Lade…' : t('view.development.geräteLaden') }}
        </button>
        <p v-if="geraeteFehler" class="wert-fehler">{{ geraeteFehler }}</p>
      </div>
      <table v-if="geraeteListe.length > 0" class="tabelle">
        <thead>
          <tr>
            <th>{{ t('view.development.geräteSpalteGerät') }}</th>
            <th>{{ t('view.development.geräteSpalteUser') }}</th>
            <th>{{ t('view.development.geräteSpalteFingerabdruck') }}</th>
            <th>{{ t('view.development.geräteSpalteRegistriert') }}</th>
            <th>{{ t('view.development.geräteSpalteZuletzt') }}</th>
            <th>{{ t('view.development.geräteSpalteReset') }}</th>
            <th>{{ t('view.development.geräteSpalteSyncFehler') }}</th>
            <th style="width: 11rem">{{ t('view.development.geräteSpalteAktionen') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in geraeteListe" :key="g.id">
            <td>
              <code style="font-size: 0.85rem">{{ g.id.slice(0, 8) }}…</code>
            </td>
            <td>{{ g.email ?? '—' }} ({{ g.rolle ?? '—' }})</td>
            <td>
              <span v-if="g.fingerprint.appVersion" class="hint"
                >v{{ g.fingerprint.appVersion }}</span
              >
              <span v-if="g.fingerprint.userAgent" class="hint"
                >{{ g.fingerprint.userAgent.slice(0, 30) }}…</span
              >
            </td>
            <td>{{ g.registriertAm.slice(0, 16) }}</td>
            <td>{{ g.zuletztGesehenAm.slice(0, 16) }}</td>
            <td>
              <span :class="g.resetAm ? 'wert-fehler' : 'hint-ok'">{{
                g.resetAm ? 'gesetzt' : 'aus'
              }}</span>
            </td>
            <td>
              <button
                v-if="g.lastSyncErrorAt"
                type="button"
                :disabled="geraetePhase === 'laufend'"
                class="small"
                :class="g.lastSyncErrorAt ? 'wert-fehler' : ''"
                @click="ladeSyncErrorReports(g.id, g.email ?? g.id)"
              >
                {{
                  t('view.development.geräteSyncFehlerAnzeigen', {
                    code: g.lastSyncErrorCode ?? '—',
                  })
                }}
              </button>
              <span v-else class="hint">—</span>
            </td>
            <td>
              <button
                type="button"
                :disabled="geraetePhase === 'laufend'"
                class="danger small"
                @click="setzeGeraetReset(g.id, !g.resetAm)"
              >
                {{
                  g.resetAm
                    ? t('view.development.geräteZurücksetzenAufheben')
                    : t('view.development.geräteZurücksetzenSetzen')
                }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="geraetePhase === 'idle' && geraeteListe.length === 0" class="hint">
        {{ t('view.development.geräteKeine') }}
      </p>
    </div>

    <h2>{{ t('view.development.geräteAlle') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.geräteAlleHint') }}</p>
      <div class="actions" style="gap: 0.5rem; align-items: start">
        <select
          v-model="geraeteSelectedUser"
          :disabled="geraetePhase === 'laufend' || geraeteUserListe.length === 0"
        >
          <option value="">{{ t('view.development.geräteUserWaehlen') }}</option>
          <option v-for="u in geraeteUserListe" :key="u.id" :value="u.id">
            {{ u.anzeigename || u.email }} ({{ u.email }})
          </option>
        </select>
        <button
          type="button"
          class="danger small"
          :disabled="
            geraetePhase === 'laufend' || geraeteUserListe.length === 0 || !geraeteSelectedUser
          "
          @click="setzeUserReset(geraeteSelectedUser, true)"
        >
          {{ t('view.development.geräteAlleSetzen') }}
        </button>
        <button
          type="button"
          class="small"
          :disabled="
            geraetePhase === 'laufend' || geraeteUserListe.length === 0 || !geraeteSelectedUser
          "
          @click="setzeUserReset(geraeteSelectedUser, false)"
        >
          {{ t('view.development.geräteAlleAufheben') }}
        </button>
        <p v-if="geraeteFehler" class="wert-fehler">{{ geraeteFehler }}</p>
      </div>
    </div>

    <h2>{{ t('view.development.syncErrorAlleTitel') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.development.syncErrorAlleHint') }}</p>
      <div class="actions" style="margin-bottom: 0.8rem; gap: 0.5rem; align-items: start">
        <button
          type="button"
          :disabled="syncErrorAllePhase === 'laufend'"
          @click="ladeSyncErrorAlle"
        >
          {{
            syncErrorAllePhase === 'laufend'
              ? t('view.development.syncErrorAlleLaedt')
              : t('view.development.syncErrorAlleLaden')
          }}
        </button>
        <p v-if="syncErrorAlleFehler" class="wert-fehler">{{ syncErrorAlleFehler }}</p>
        <p v-if="syncErrorAllePhase === 'idle'" class="hint">
          {{
            t('view.development.syncErrorAlleAnzahl', {
              anzahl: syncErrorAlleListe.length,
              total: syncErrorAlleTotal,
            })
          }}
        </p>
      </div>

      <table v-if="syncErrorAlleListe.length > 0" class="tabelle">
        <thead>
          <tr>
            <th>{{ t('view.development.syncErrorAlleSpalteZeit') }}</th>
            <th>{{ t('view.development.syncErrorAlleSpalteGerät') }}</th>
            <th>{{ t('view.development.syncErrorAlleSpalteUser') }}</th>
            <th>{{ t('view.development.syncErrorAlleSpalteCode') }}</th>
            <th>{{ t('view.development.syncErrorAlleSpalteHTTP') }}</th>
            <th>{{ t('view.development.syncErrorAlleSpalteNachricht') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in syncErrorAlleListe" :key="r.id">
            <td class="hint">{{ (r.occurredAt ?? '').slice(0, 16) }}</td>
            <td class="hint">
              <code style="font-size: 0.8rem">{{ r.deviceId.slice(0, 8) }}…</code>
            </td>
            <td class="hint">{{ r.userName ?? r.userEmail ?? r.userId }}</td>
            <td class="wert-fehler">{{ r.code }}</td>
            <td class="hint">{{ r.httpStatus ?? '—' }}</td>
            <td
              class="hint"
              style="
                max-width: 40rem;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              "
            >
              {{ r.message }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="syncErrorAllePhase === 'idle' && syncErrorAlleListe.length === 0" class="hint">
        {{ t('view.development.syncErrorAlleKeine') }}
      </p>
    </div>

    <h2>{{ t('view.development.update') }}</h2>
    <button
      type="button"
      class="small"
      :class="{ aktiv: updateWebhookInfo }"
      @click="updateWebhookInfo = !updateWebhookInfo"
    >
      {{ t('view.development.updateWebhookInfo') }}
    </button>
    <div class="card">
      <p class="hint">{{ t('view.development.updateHint') }}</p>

      <!-- Versions-Check gegen GHCR -->
      <div class="update-check">
        <span v-if="updateCheckLaeuft" class="hint">
          {{ t('view.development.updateCheckLaeuft') }}
        </span>
        <template v-else-if="updateCheck">
          <p class="hint">
            {{
              t('view.development.updateCheckVersion', {
                current: updateCheck.current ?? t('view.development.updateUnbekannt'),
                latest: updateCheck.latest ?? t('view.development.updateUnbekannt'),
              })
            }}
          </p>
          <p v-if="updateCheck.updateAvailable === true" class="hint hint-ok">
            {{ t('view.development.updateCheckAvailable', { latest: updateCheck.latest ?? '' }) }}
          </p>
          <p v-else-if="updateCheck.updateAvailable === false" class="hint">
            {{ t('view.development.updateCheckUpToDate') }}
          </p>
          <p v-if="updateCheck.error" class="hint">
            {{ t('view.development.updateCheckFehler', { error: updateCheck.error }) }}
          </p>
          <p v-if="updateCheck.canSelfUpdate === false" class="hint hint-danger">
            {{ t('view.development.updateNoSelfUpdate') }}
            <span v-if="updateCheck.selfUpdateReason">
              ({{
                t('view.development.updateNoSelfUpdateGrund', {
                  grund: updateCheck.selfUpdateReason,
                })
              }})
            </span>
          </p>
        </template>
        <p v-if="updateCheckFehler" class="wert-fehler">{{ updateCheckFehler }}</p>
        <div class="actions">
          <button
            type="button"
            class="small"
            :disabled="updateCheckLaeuft"
            @click="updateCheckLaden"
          >
            {{ t('view.development.updateCheckBtn') }}
          </button>
        </div>
      </div>

      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="updatePhase === 'laufend'"
          @click="updateFrageStarten"
        >
          {{
            updatePhase === 'laufend'
              ? t('view.development.updateLaeuft')
              : updatePhase === 'fertig'
                ? t('view.development.updateFertig')
                : t('view.development.updateBtn')
          }}
        </button>
      </div>

      <!-- Status -->
      <div v-if="updateState" class="update-status">
        <p>
          <strong>{{ t(`view.development.updatePhase.${updateState.phase}`) }}</strong>
          <span v-if="updateStepLabel" class="hint">— {{ updateStepLabel }}</span>
        </p>
        <p v-if="updateState.host" class="hint">
          {{ t('view.development.updateHost', { host: updateState.host }) }}
        </p>
        <p v-if="updateState.versionBefore && updateState.versionAfter" class="hint">
          {{
            t('view.development.updateVersion', {
              before: updateState.versionBefore,
              after: updateState.versionAfter,
            })
          }}
        </p>
        <p v-if="updateState.message" class="hint">{{ updateState.message }}</p>
        <p v-if="updateServerAus" class="hint">{{ t('view.development.updateServerAus') }}</p>
        <p v-if="updateFehler" class="wert-fehler">{{ updateFehler }}</p>
        <details v-if="updateState.log" class="update-log">
          <summary>{{ t('view.development.updateLog') }}</summary>
          <pre>{{ updateState.log }}</pre>
        </details>
      </div>
    </div>

    <!-- Fallback: nur wenn der Server das Update nicht selbst starten kann -->
    <div v-if="updateFallbackOffen" class="card update-anleitung">
      <h3>{{ t('view.development.updateFallbackTitel') }}</h3>
      <p class="hint">{{ t('view.development.updateFallbackText') }}</p>
      <pre>{{ t('view.development.updateAnleitungBefehl') }}</pre>
      <p v-if="updateStartGrund" class="hint">
        {{ t('view.development.updateStartGrund', { grund: updateStartGrund }) }}
      </p>
    </div>

    <!-- Webhook-Info: externes System kann Update auf diesem Server ausloesen -->
    <div v-if="updateWebhookInfo" class="card update-anleitung">
      <h3>{{ t('view.development.updateWebhookTitel') }}</h3>
      <p class="hint">{{ t('view.development.updateWebhookText') }}</p>
      <pre>{{ webhookCurl }}</pre>
      <p class="hint">{{ t('view.development.updateWebhookHeader') }}</p>
      <p class="hint">{{ t('view.development.updateWebhookHinweis') }}</p>
      <p class="hint">{{ t('view.development.updateWebhookFlow') }}</p>
      <p class="hint">{{ t('view.development.updateWebhookErrors') }}</p>
      <p class="hint">{{ t('view.development.updateWebhookSelf') }}</p>
      <p class="hint">{{ t('view.development.updateWebhookExternal') }}</p>
    </div>

    <div v-if="updatePhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="updatePhase === 'fertig'">
        <p class="hint hint-ok">{{ t('view.development.updateFertigText') }}</p>
        <p class="hint">{{ t('view.development.updateNachHinweis') }}</p>
        <div class="actions">
          <button type="button" @click="updateAbbrechen">
            {{ t('view.common.schliessen') }}
          </button>
        </div>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.development.updateFrage') }}</strong>
        </p>
        <p class="hint">{{ t('view.development.updateDetail') }}</p>
        <p class="hint hint-danger">{{ t('view.development.updateWarnung') }}</p>
        <p v-if="updatePhase === 'fehler' && updateFehler" class="wert-fehler">
          {{ updateFehler }}
        </p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="updatePhase === 'laufend'"
            @click="updateBestaetigen"
          >
            {{
              updatePhase === 'laufend'
                ? t('view.development.updateLaeuft')
                : t('view.development.updateBestaetigen')
            }}
          </button>
          <button type="button" :disabled="updatePhase === 'laufend'" @click="updateAbbrechen">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>

    <!-- Sync-Fehler-Report ausklappbar (ganz unten, alle Details) -->
    <div v-if="syncErrorExpandedDeviceId" class="card sync-error-card">
      <div class="sync-error-header" @click="syncErrorExpandedDeviceId = ''">
        <strong>{{
          t('view.development.syncErrorModalTitel', { geraet: syncErrorExpandedDeviceLabel })
        }}</strong>
        <span class="hint">({{ syncErrorExpandedDeviceLabel }})</span>
      </div>
      <p class="hint">{{ t('view.development.syncErrorModalHint') }}</p>

      <div
        v-if="syncErrorExpandedPhase === 'fehler' && syncErrorExpandedFehler"
        class="wert-fehler"
      >
        {{ syncErrorExpandedFehler }}
      </div>

      <div v-if="syncErrorExpandedPhase === 'laufend'" class="hint">
        {{ t('view.development.syncErrorLade') }}
      </div>

      <table
        v-if="syncErrorExpandedReports.length > 0 && syncErrorExpandedPhase === 'idle'"
        class="tabelle"
        style="margin-top: 0.5rem"
      >
        <thead>
          <tr>
            <th>{{ t('view.development.syncErrorSpalteZeit') }}</th>
            <th>{{ t('view.development.syncErrorSpalteQuelle') }}</th>
            <th>{{ t('view.development.syncErrorSpalteCode') }}</th>
            <th>{{ t('view.development.syncErrorSpalteHTTP') }}</th>
            <th>{{ t('view.development.syncErrorSpalteNachricht') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in syncErrorExpandedReports" :key="r.id">
            <td class="hint">{{ (r.occurredAt ?? '').slice(0, 16) }}</td>
            <td class="hint">{{ r.source }}</td>
            <td class="wert-fehler">{{ r.code }}</td>
            <td class="hint">{{ r.httpStatus ?? '—' }}</td>
            <td
              class="hint"
              style="
                max-width: 40rem;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              "
            >
              {{ r.message }}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Stack Trace -->
      <div
        v-if="syncErrorExpandedReports.length > 0 && syncErrorExpandedPhase === 'idle'"
        style="margin-top: 1rem"
      >
        <h3>{{ t('view.development.syncErrorStack') }}</h3>
        <pre
          v-for="r in syncErrorExpandedReports"
          :key="r.id + '-stack'"
          style="
            background: var(--bg-input);
            padding: 0.5rem;
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
            overflow-x: auto;
            white-space: pre-wrap;
          "
          >{{ r.stack ?? t('view.development.syncErrorKeinStack') }}</pre>
      </div>

      <!-- Payload -->
      <div
        v-if="syncErrorExpandedReports.length > 0 && syncErrorExpandedPhase === 'idle'"
        style="margin-top: 1rem"
      >
        <h3>{{ t('view.development.syncErrorPayload') }}</h3>
        <pre
          v-for="r in syncErrorExpandedReports"
          :key="r.id + '-payload'"
          style="
            background: var(--bg-input);
            padding: 0.5rem;
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
            overflow-x: auto;
            white-space: pre-wrap;
          "
          >{{
            r.payload !== null && r.payload !== undefined
              ? JSON.stringify(r.payload, null, 2)
              : t('view.development.syncErrorKeinPayload')
          }}</pre>
      </div>

      <!-- Diagnostics -->
      <div
        v-if="syncErrorExpandedReports.length > 0 && syncErrorExpandedPhase === 'idle'"
        style="margin-top: 1rem"
      >
        <h3>{{ t('view.development.syncErrorDiagnostics') }}</h3>
        <pre
          v-for="r in syncErrorExpandedReports"
          :key="r.id + '-diag'"
          style="
            background: var(--bg-input);
            padding: 0.5rem;
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
            overflow-x: auto;
            white-space: pre-wrap;
          "
          >{{
            r.diagnostics !== null && r.diagnostics !== undefined
              ? JSON.stringify(r.diagnostics, null, 2)
              : t('view.development.syncErrorKeineDiagnostics')
          }}</pre>
      </div>

      <div
        v-if="syncErrorExpandedReports.length === 0 && syncErrorExpandedPhase === 'idle'"
        class="hint"
      >
        {{ t('view.development.syncErrorKeine') }}
      </div>

      <div class="actions" style="margin-top: 0.75rem">
        <button
          type="button"
          :disabled="syncErrorExpandedPhase === 'laufend'"
          @click="syncErrorExpandedDeviceId = ''"
        >
          {{ t('view.common.schliessen') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.confirm {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.confirm p {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.confirm .hint {
  color: var(--text-muted);
  font-size: 0.78rem !important;
}
.hint-ok {
  color: var(--success);
  font-weight: 600;
}
.wert-fehler {
  color: var(--danger);
  font-weight: 600;
}
.sync-error-card {
  margin-top: 1rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.sync-error-header {
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.sync-error-header:hover {
  text-decoration: underline;
}
.update-status {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.update-status p {
  margin: 0 0 0.35rem;
}
.update-log {
  margin-top: 0.5rem;
}
.update-log summary {
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--text-muted);
}
.update-log pre {
  margin-top: 0.5rem;
  padding: 0.5rem;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  white-space: pre-wrap;
  overflow-x: auto;
}
.update-anleitung h3 {
  margin-top: 0;
}
.update-anleitung h4 {
  margin: 1rem 0 0.25rem;
  font-size: 0.9rem;
}
.update-anleitung pre {
  margin: 0.35rem 0 0;
  padding: 0.5rem;
  background: var(--bg-input);
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  white-space: pre-wrap;
  overflow-x: auto;
}
.update-anleitung-liste {
  margin: 0.35rem 0 0;
  padding-left: 1.2rem;
}
.update-anleitung-liste li {
  margin-bottom: 0.35rem;
}
button.aktiv {
  background: var(--primary);
  color: var(--text-on-primary);
}
</style>
