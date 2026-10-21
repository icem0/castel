<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { clearAppCacheAndReload } from '../services/sync/clear-cache'
import { resetLocalDbAndPull } from '../services/sync/reset-local-db'

const { t } = useI18n()

type ResetPhase = 'idle' | 'bestaetigen' | 'laufend' | 'fehler'

const cachePhase = ref<ResetPhase>('idle')
const cacheFehler = ref<string | null>(null)
const dbPhase = ref<ResetPhase>('idle')
const dbFehler = ref<string | null>(null)
const serverDbPhase = ref<ResetPhase>('idle')
const serverDbFehler = ref<string | null>(null)
const serverDbErfolg = ref<string | null>(null)

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
}
function dbAbbrechen(): void {
  dbPhase.value = 'idle'
  dbFehler.value = null
}
async function dbBestaetigen(): Promise<void> {
  dbPhase.value = 'laufend'
  dbFehler.value = null
  try {
    await resetLocalDbAndPull({
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
    })
    window.location.reload()
  } catch (e) {
    dbFehler.value = e instanceof Error ? e.message : String(e)
    dbPhase.value = 'fehler'
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
          {{ cachePhase === 'laufend' ? t('view.development.leert') : t('common.ja') }}
        </button>
        <button type="button" :disabled="cachePhase === 'laufend'" @click="cacheAbbrechen">
          {{ t('common.abbrechen') }}
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
          :disabled="dbPhase === 'laufend'"
          @click="dbFrageStarten"
        >
          {{
            dbPhase === 'laufend'
              ? t('view.development.loescht')
              : t('view.development.lokaleDBLoeschen')
          }}
        </button>
      </div>
    </div>

    <div v-if="dbPhase !== 'idle'" class="confirm" role="alertdialog">
      <p>
        <strong>{{ t('view.development.lokaleDBFrage') }}</strong>
      </p>
      <p class="hint">{{ t('view.development.lokaleDBDetail') }}</p>
      <p class="hint">{{ t('view.development.lokaleDBWarnung') }}</p>
      <p v-if="dbPhase === 'fehler' && dbFehler" class="wert-fehler">{{ dbFehler }}</p>
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
          {{ t('common.abbrechen') }}
        </button>
      </div>
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
          {{ t('common.abbrechen') }}
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
.button {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}
.button.danger {
  background: var(--danger);
  color: white;
  border-color: var(--danger);
}
.button.danger:hover:not(:disabled) {
  filter: brightness(1.08);
}
.button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
