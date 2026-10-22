<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { clearAppCacheAndReload } from '../services/sync/clear-cache'
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
/** Set after a ReseedGuardError — unlocks the explicit "force" button. */
const reseedGuardFehler = ref(false)

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
</style>
