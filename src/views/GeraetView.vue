<script setup lang="ts">
// Device storage: local mirror counts + a hard reset for every role.
//
// The local IndexedDB is a disposable mirror of the server (AGENTS.md: the
// client is flushed and refilled on sync). A hard reset is the only escape
// hatch when the incremental sync cannot converge — e.g. ghost bookings after
// a server-side hard delete, or a corrupt local database. That button used to
// live in the admin-only developer view, so an ordinary user with a stuck
// sync had no way out. This view is reachable for every logged-in role.
//
// The reset reuses `resetLocalDbAndPull`: stop the sync worker, drop
// IndexedDB (outbox included), pull a complete snapshot, reload the page.

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'
import { useSyncStore } from '../stores/sync'
import { resetLocalDbAndPull } from '../services/sync/reset-local-db'
import type { TableCounts } from '../services/sync/worker'

const { t } = useI18n()
const sync = useSyncStore()

type ResetPhase = 'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'

/** Grace period to show the result before the page reloads. */
const RELOAD_DELAY_MS = 3_000
const RELOAD_SEK = RELOAD_DELAY_MS / 1000

const phase = ref<ResetPhase>('idle')
const fehler = ref<string | null>(null)
const erfolg = ref<string | null>(null)

const lokal = computed<TableCounts | null>(() => sync.status.localCounts)
const server = computed<TableCounts | null>(() => sync.status.serverCounts)
const offen = computed(() => sync.status.pending)
const quarantine = computed(() => sync.status.quarantined)

const zeilen = computed(() => {
  const l = lokal.value
  const s = server.value
  const zahl = (wert: number | undefined): string => (typeof wert === 'number' ? String(wert) : '—')
  return [
    {
      key: 'artikel',
      label: t('view.geraet.tippArtikel'),
      lokal: zahl(l?.artikel),
      server: zahl(s?.artikel),
    },
    {
      key: 'standorte',
      label: t('view.geraet.tippStandorte'),
      lokal: zahl(l?.standorte),
      server: zahl(s?.standorte),
    },
    {
      key: 'commission',
      label: t('view.geraet.tippKommissionen'),
      lokal: zahl(l?.commission),
      server: zahl(s?.commission),
    },
    {
      key: 'buchungen',
      label: t('view.geraet.tippBuchungen'),
      lokal: zahl(l?.buchungen),
      server: zahl(s?.buchungen),
    },
  ]
})

async function syncJetzt(): Promise<void> {
  await sync.syncNow(getApiBaseUrl(), () => jwtLesen())
}

function zuruecksetzenFrage(): void {
  phase.value = 'bestaetigen'
  fehler.value = null
  erfolg.value = null
}

function zuruecksetzenAbbrechen(): void {
  if (phase.value === 'laufend') return
  phase.value = 'idle'
  fehler.value = null
  erfolg.value = null
}

async function zuruecksetzenBestaetigen(): Promise<void> {
  phase.value = 'laufend'
  fehler.value = null
  try {
    const ergebnis = await resetLocalDbAndPull({
      apiBase: getApiBaseUrl(),
      token: jwtLesen(),
    })
    erfolg.value = t('view.geraet.erfolg', {
      artikel: ergebnis.pulled.artikel,
      standorte: ergebnis.pulled.standorte,
      buchungen: ergebnis.pulled.buchungen,
    })
    phase.value = 'fertig'
    setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
  } catch (e) {
    // The database is already gone at this point — the sync worker refills it
    // after a reload, so the error is not fatal.
    fehler.value = e instanceof Error ? e.message : String(e)
    phase.value = 'fehler'
  }
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.geraet.h1') }}</h1>
    </header>
    <p class="intro">{{ t('view.geraet.intro') }}</p>

    <h2>{{ t('view.geraet.uebersicht') }}</h2>
    <div class="card">
      <table class="tabelle">
        <thead>
          <tr>
            <th>{{ t('view.geraet.spalteTabelle') }}</th>
            <th>{{ t('view.geraet.spalteLokal') }}</th>
            <th>{{ t('view.geraet.spalteServer') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="z in zeilen" :key="z.key">
            <td>{{ z.label }}</td>
            <td>{{ z.lokal }}</td>
            <td>{{ z.server }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="offen > 0" class="hint hint-warn">
        {{ t('view.geraet.ausstehend', { anzahl: offen }) }}
      </p>
      <p v-else class="hint">{{ t('view.geraet.keineAusstehend') }}</p>
      <p v-if="quarantine > 0" class="hint hint-warn">
        {{ t('view.geraet.quarantaene', { anzahl: quarantine }) }}
      </p>
      <div class="actions">
        <button type="button" :disabled="sync.triggering" @click="syncJetzt">
          {{ sync.triggering ? '…' : t('view.geraet.syncJetzt') }}
        </button>
      </div>
    </div>

    <h2>{{ t('view.geraet.zuruecksetzen') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.geraet.zuruecksetzenHint') }}</p>
      <div class="actions">
        <button
          type="button"
          class="danger"
          :disabled="phase === 'laufend' || phase === 'fertig'"
          @click="zuruecksetzenFrage"
        >
          {{
            phase === 'laufend'
              ? t('view.geraet.laeuft')
              : phase === 'fertig'
                ? t('view.geraet.fertig')
                : t('view.geraet.zuruecksetzenBtn')
          }}
        </button>
      </div>
    </div>

    <div v-if="phase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="phase === 'fertig'">
        <p class="hint hint-ok">{{ erfolg }}</p>
        <p class="hint">{{ t('view.geraet.neuladenIn', { sek: RELOAD_SEK }) }}</p>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.geraet.frage') }}</strong>
        </p>
        <p class="hint">{{ t('view.geraet.detail') }}</p>
        <p v-if="offen > 0" class="wert-fehler">
          {{ t('view.geraet.warnungAusstehend', { anzahl: offen }) }}
        </p>
        <p v-else class="hint">{{ t('view.geraet.warnung') }}</p>
        <p v-if="phase === 'fehler' && fehler" class="wert-fehler">{{ fehler }}</p>
        <p v-if="phase === 'fehler'" class="hint">{{ t('view.geraet.neustartHinweis') }}</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="phase === 'laufend'"
            @click="zuruecksetzenBestaetigen"
          >
            {{ phase === 'laufend' ? t('view.geraet.laeuft') : t('view.geraet.jaZuruecksetzen') }}
          </button>
          <button type="button" :disabled="phase === 'laufend'" @click="zuruecksetzenAbbrechen">
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.intro {
  color: var(--text-muted, #666);
  margin: 0 0 1rem;
}
.tabelle {
  width: 100%;
  border-collapse: collapse;
}
.tabelle th,
.tabelle td {
  text-align: left;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--border, #ddd);
}
.tabelle th:nth-child(n + 2),
.tabelle td:nth-child(n + 2) {
  text-align: right;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.8rem;
}
.confirm {
  margin-top: 0.8rem;
  padding: 0.8rem;
  border: 1px solid var(--border, #ddd);
  border-radius: 0.5rem;
}
.hint-warn {
  color: var(--warn, #a80);
}
.wert-fehler {
  color: var(--danger, #b00);
}
</style>
