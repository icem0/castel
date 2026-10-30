<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { clearAppCacheAndReload } from '../services/sync/clear-cache'
import { holeAktiveUserliste, type UserDto } from '../auth/users'
import { resetLocalDbAndPull, wipeLocalDbWithoutPull } from '../services/sync/reset-local-db'
import {
  collectReseedPlan,
  reseedServer,
  ReseedGuardError,
  type ReseedPlan,
} from '../services/sync/reseed-server'

const { t } = useI18n()

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

const geraetePhase = ref<'idle' | 'laufend' | 'fehler'>('idle')
const geraeteFehler = ref<string | null>(null)
const geraeteListe = ref<Geraet[]>([])
const geraeteUserListe = ref<UserDto[]>([])
const geraeteSelectedUser = ref<string>('')

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

type BulkBuchung = {
  id: string
  artikelId: string
  artikelTitel: string | null
  standortId: string
  standortName: string | null
  typ: string
  menge: number
  erstelltAm: string
  storno: boolean
  projekt: string | null
}

type BulkFilterOptions = {
  artikel: { id: string; titel: string }[]
  standorte: { id: string; name: string }[]
  typen: string[]
  projekte: string[]
}

const bulkFilter = reactive({
  artikelId: '',
  standortId: '',
  typ: '',
  datumVon: '',
  datumBis: '',
  storno: '',
  projekt: '',
})
const bulkBuchungen = ref<BulkBuchung[]>([])
const bulkOptionen = ref<BulkFilterOptions>({
  artikel: [],
  standorte: [],
  typen: [],
  projekte: [],
})
const bulkAuswahl = ref<string[]>([])
const bulkLadePhase = ref<'idle' | 'laufend' | 'fertig' | 'fehler'>('idle')
const bulkLadeFehler = ref<string | null>(null)
const bulkDeletePhase = ref<'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'>('idle')
const bulkDeleteFehler = ref<string | null>(null)
const bulkDeleteErfolg = ref<string | null>(null)
const bulkDeleteAnzahl = ref(0)

const bulkAlleAusgewaehlt = computed(
  () =>
    bulkBuchungen.value.length > 0 &&
    bulkBuchungen.value.every((b) => bulkAuswahl.value.includes(b.id)),
)

function bulkFilterBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (bulkFilter.artikelId) body.artikelId = bulkFilter.artikelId
  if (bulkFilter.standortId) body.standortId = bulkFilter.standortId
  if (bulkFilter.typ) body.typ = bulkFilter.typ
  if (bulkFilter.datumVon) body.datumVon = new Date(bulkFilter.datumVon).toISOString()
  if (bulkFilter.datumBis) body.datumBis = new Date(bulkFilter.datumBis).toISOString()
  if (bulkFilter.storno !== '') body.storno = bulkFilter.storno === 'true'
  if (bulkFilter.projekt) body.projekt = bulkFilter.projekt
  return body
}

async function bulkLaden(): Promise<void> {
  bulkLadePhase.value = 'laufend'
  bulkLadeFehler.value = null
  try {
    const res = await apiFetch<{
      buchungen: BulkBuchung[]
      filterOptions: BulkFilterOptions
    }>('/api/admin/buchungen/filter', { method: 'POST', body: bulkFilterBody() })
    bulkBuchungen.value = res.buchungen
    bulkOptionen.value = res.filterOptions
    bulkAuswahl.value = []
    bulkLadePhase.value = 'fertig'
  } catch (e) {
    bulkLadeFehler.value = e instanceof Error ? e.message : String(e)
    bulkLadePhase.value = 'fehler'
  }
}

function bulkAlleUmschalten(): void {
  bulkAuswahl.value = bulkAlleAusgewaehlt.value ? [] : bulkBuchungen.value.map((b) => b.id)
}

function bulkLoeschenFrage(): void {
  if (bulkAuswahl.value.length === 0) return
  bulkDeleteAnzahl.value = bulkAuswahl.value.length
  bulkDeletePhase.value = 'bestaetigen'
  bulkDeleteFehler.value = null
  bulkDeleteErfolg.value = null
}

function bulkLoeschenAbbrechen(): void {
  bulkDeletePhase.value = 'idle'
  bulkDeleteFehler.value = null
}

async function bulkLoeschenBestaetigen(): Promise<void> {
  bulkDeletePhase.value = 'laufend'
  bulkDeleteFehler.value = null
  try {
    const res = await apiFetch<{ deletedCount: number }>('/api/admin/buchungen/bulk-delete', {
      method: 'POST',
      body: { ids: bulkAuswahl.value, bestaetigt: true },
    })
    bulkDeleteErfolg.value = t('view.development.bulkLoeschErgebnis', {
      anzahl: res.deletedCount,
    })
    bulkAuswahl.value = []
    bulkDeletePhase.value = 'fertig'
    await bulkLaden()
  } catch (e) {
    bulkDeleteFehler.value = e instanceof Error ? e.message : String(e)
    bulkDeletePhase.value = 'fehler'
  }
}

function bulkTypLabel(typ: string): string {
  return t(`view.buchung.form.typen.${typ}`)
}

function formatBulkDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => {
  void bulkLaden()
  void ladeGeraete()
  void ladeUserListe()
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
      <div class="filter-bar">
        <select v-model="bulkFilter.artikelId" :aria-label="t('view.development.bulkArtikel')">
          <option value="">{{ t('view.development.bulkAlleArtikel') }}</option>
          <option v-for="a in bulkOptionen.artikel" :key="a.id" :value="a.id">
            {{ a.titel }}
          </option>
        </select>
        <select v-model="bulkFilter.standortId" :aria-label="t('view.development.bulkStandort')">
          <option value="">{{ t('view.development.bulkAlleStandorte') }}</option>
          <option v-for="s in bulkOptionen.standorte" :key="s.id" :value="s.id">
            {{ s.name }}
          </option>
        </select>
        <select v-model="bulkFilter.typ" :aria-label="t('view.development.bulkTyp')">
          <option value="">{{ t('view.development.bulkAlleTypen') }}</option>
          <option v-for="typ in bulkOptionen.typen" :key="typ" :value="typ">
            {{ bulkTypLabel(typ) }}
          </option>
        </select>
        <select v-model="bulkFilter.storno" :aria-label="t('view.development.bulkStorno')">
          <option value="">{{ t('view.development.bulkStornoAlle') }}</option>
          <option value="false">{{ t('view.development.bulkStornoNein') }}</option>
          <option value="true">{{ t('view.development.bulkStornoJa') }}</option>
        </select>
        <select v-model="bulkFilter.projekt" :aria-label="t('view.development.bulkProjekt')">
          <option value="">{{ t('view.development.bulkAlleProjekte') }}</option>
          <option v-for="p in bulkOptionen.projekte" :key="p" :value="p">{{ p }}</option>
        </select>
        <label class="bulk-datum">
          <span>{{ t('view.development.bulkVon') }}</span>
          <input v-model="bulkFilter.datumVon" type="datetime-local" />
        </label>
        <label class="bulk-datum">
          <span>{{ t('view.development.bulkBis') }}</span>
          <input v-model="bulkFilter.datumBis" type="datetime-local" />
        </label>
        <button type="button" :disabled="bulkLadePhase === 'laufend'" @click="bulkLaden">
          {{
            bulkLadePhase === 'laufend'
              ? t('view.development.bulkLaedt')
              : t('view.development.bulkLaden')
          }}
        </button>
      </div>

      <p v-if="bulkLadeFehler" class="wert-fehler">{{ bulkLadeFehler }}</p>
      <p v-if="bulkLadePhase === 'fertig' && bulkBuchungen.length === 0" class="hint">
        {{ t('view.development.bulkKeine') }}
      </p>

      <template v-if="bulkBuchungen.length > 0">
        <p class="hint">
          {{
            t('view.development.bulkGefunden', {
              anzahl: bulkBuchungen.length,
              ausgewaehlt: bulkAuswahl.length,
            })
          }}
        </p>
        <div class="actions">
          <button type="button" @click="bulkAlleUmschalten">
            {{
              bulkAlleAusgewaehlt
                ? t('view.development.bulkAuswahlAufheben')
                : t('view.development.bulkAlleAuswaehlen')
            }}
          </button>
          <button
            type="button"
            class="danger"
            :disabled="bulkAuswahl.length === 0"
            @click="bulkLoeschenFrage"
          >
            {{ t('view.development.bulkLoeschenBtn', { anzahl: bulkAuswahl.length }) }}
          </button>
        </div>
        <div class="bulk-tabelle">
          <table class="data">
            <thead>
              <tr>
                <th></th>
                <th>{{ t('view.development.bulkSpalteDatum') }}</th>
                <th>{{ t('view.development.bulkSpalteArtikel') }}</th>
                <th>{{ t('view.development.bulkSpalteStandort') }}</th>
                <th>{{ t('view.development.bulkSpalteTyp') }}</th>
                <th>{{ t('view.development.bulkSpalteMenge') }}</th>
                <th>{{ t('view.development.bulkSpalteProjekt') }}</th>
                <th>{{ t('view.development.bulkSpalteStorno') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in bulkBuchungen" :key="b.id">
                <td>
                  <input v-model="bulkAuswahl" type="checkbox" :value="b.id" />
                </td>
                <td>{{ formatBulkDatum(b.erstelltAm) }}</td>
                <td>{{ b.artikelTitel ?? b.artikelId }}</td>
                <td>{{ b.standortName ?? b.standortId }}</td>
                <td>{{ bulkTypLabel(b.typ) }}</td>
                <td class="num" :class="b.menge >= 0 ? 'num-plus' : 'num-minus'">
                  {{ b.menge }}
                </td>
                <td>{{ b.projekt ?? '—' }}</td>
                <td>{{ b.storno ? t('view.development.bulkStornoJa') : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <div v-if="bulkDeletePhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="bulkDeletePhase === 'fertig'">
        <p class="hint hint-ok">{{ bulkDeleteErfolg }}</p>
        <p class="hint hint-warn">{{ t('view.development.bulkGeisterWarnung') }}</p>
        <div class="actions">
          <button type="button" @click="bulkLoeschenAbbrechen">
            {{ t('view.development.bulkSchliessen') }}
          </button>
        </div>
      </template>
      <template v-else>
        <p>
          <strong>
            {{ t('view.development.bulkLoeschFrage', { anzahl: bulkDeleteAnzahl }) }}
          </strong>
        </p>
        <p class="hint">
          {{ t('view.development.bulkLoeschDetail', { anzahl: bulkDeleteAnzahl }) }}
        </p>
        <p class="hint hint-danger">{{ t('view.development.bulkLoeschWarnung') }}</p>
        <p v-if="bulkDeleteFehler" class="wert-fehler">{{ bulkDeleteFehler }}</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="bulkDeletePhase === 'laufend'"
            @click="bulkLoeschenBestaetigen"
          >
            {{
              bulkDeletePhase === 'laufend'
                ? t('view.development.bulkLoescht')
                : t('view.development.bulkLoeschBestaetigen')
            }}
          </button>
          <button
            type="button"
            :disabled="bulkDeletePhase === 'laufend'"
            @click="bulkLoeschenAbbrechen"
          >
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
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

    <!-- Sync-Fehler-Report ausklappbar unter der Geraetetabelle -->
    <div v-if="syncErrorExpandedDeviceId" class="card sync-error-card">
      <div class="sync-error-header" @click="syncErrorExpandedDeviceId = ''">
        <strong>{{
          t('view.development.syncErrorModalTitel', {
            gerät: syncErrorExpandedDeviceLabel,
          })
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

      <div v-if="syncErrorExpandedPhase === 'laufend'" class="hint">Lade Sync-Fehler-Reports…</div>

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
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in syncErrorExpandedReports" :key="r.id">
            <td class="hint">{{ (r.occurredAt ?? '').slice(0, 16) }}</td>
            <td class="hint">{{ r.source }}</td>
            <td class="wert-fehler">{{ r.code }}</td>
            <td class="hint">{{ r.httpStatus ?? '—' }}</td>
          </tr>
        </tbody>
      </table>

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
.bulk-datum {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--text-muted);
  font-size: 0.78rem;
}
.bulk-tabelle {
  margin-top: 0.75rem;
  overflow-x: auto;
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
</style>
