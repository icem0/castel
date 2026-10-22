<script setup lang="ts">
// MindestbestandPanelView: vollständige Liste aller erfassten
// Mindestbestand-Ereignisse, sortiert nach `erstelltAm` (neueste
// zuerst). Filter nach Artikel und Standort. Klick auf einen Eintrag
// navigiert zur Artikel-Detail-View.
//
// Admin-only. Beim Mount wird "alle gesehen" markiert, sodass der
// Counter in der Glocke auf 0 springt.

import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMindestbestandStore } from '../stores/mindestbestand'
import { useSettingsStore } from '../stores/settings'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useMindestbestandAlarm } from '../composables/useMindestbestandAlarm'

const { t } = useI18n()
const router = useRouter()
const mindestbestand = useMindestbestandStore()
const settings = useSettingsStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const alarm = useMindestbestandAlarm()

const filterArtikel = ref<string>('')
const filterStandort = ref<string>('')
const speichert = ref(false)

onMounted(() => {
  mindestbestand.start()
  mindestbestand.startMarker()
  void mindestbestand.markiereAlleGesehen()
})

// ---------- Benachrichtigungs-Einstellungen ----------

const soundAn = computed(() => settings.settings.mindestbestandSoundAn)
const lautstaerke = computed(() => settings.settings.mindestbestandLautstaerke)
const wiederholen = computed(() => settings.settings.mindestbestandWiederholen)
const permission = computed(() => alarm.permission.value)

async function speichern(fn: () => Promise<void>): Promise<void> {
  speichert.value = true
  try {
    await fn()
  } finally {
    speichert.value = false
  }
}

async function onSoundAn(an: boolean): Promise<void> {
  await speichern(() => settings.setMindestbestandSoundAn(an))
}

async function onLautstaerke(ereignis: Event): Promise<void> {
  const ziel = ereignis.target as HTMLInputElement | null
  const wert = Number.parseInt(ziel?.value ?? '70', 10)
  if (!Number.isFinite(wert)) return
  await speichern(() => settings.setMindestbestandLautstaerke(wert))
}

async function onWiederholen(an: boolean): Promise<void> {
  await speichern(() => settings.setMindestbestandWiederholen(an))
}

async function testen(): Promise<void> {
  await alarm.signalTesten()
}

/**
 * Fordert die Notification-Permission an. Muss aus einer echten
 * User-Geste heraus passieren (Button-Klick), sonst blocken die
 * Browser den Aufruf.
 */
async function permissionAnfordern(): Promise<void> {
  if (typeof Notification === 'undefined') return
  try {
    await Notification.requestPermission()
  } catch {
    // Bereits abgelehnt oder blockiert — der Status wird ohnehin
    // über `permission` angezeigt.
  }
}

function artikelTitel(id: string): string {
  return artikelStore.byId(id)?.titel ?? '…'
}
function standortName(id: string): string {
  return standortStore.aktive.find((s) => s.id === id)?.name ?? '…'
}

const gefiltert = computed(() =>
  mindestbestand.ereignisse.filter((e) => {
    if (filterArtikel.value && e.artikelId !== filterArtikel.value) return false
    if (filterStandort.value && e.standortId !== filterStandort.value) return false
    return true
  }),
)

const artikelOptionen = computed(() => {
  const ids = new Set(mindestbestand.ereignisse.map((e) => e.artikelId))
  return Array.from(ids)
    .map((id) => ({ id, titel: artikelTitel(id) }))
    .sort((a, b) => a.titel.localeCompare(b.titel))
})

function open(id: string): void {
  void router.push(`/artikel/${id}`)
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.mindestbestand.title') }}</h1>
      <RouterLink to="/einstellungen" class="btn desktop-only">
        {{ t('view.mindestbestand.back') }}
      </RouterLink>
    </header>

    <p class="hint">{{ t('view.mindestbestand.hint') }}</p>

    <!-- ---------- Benachrichtigungen ---------- -->
    <section class="card alarm-settings">
      <h2 class="alarm-settings-titel">{{ t('view.mindestbestand.settingsTitel') }}</h2>

      <label class="alarm-zeile">
        <input
          type="checkbox"
          :checked="soundAn"
          :disabled="speichert"
          @change="onSoundAn(($event.target as HTMLInputElement).checked)"
        />
        <span class="alarm-zeile-text">
          <span class="alarm-zeile-label">{{ t('view.mindestbestand.soundAn') }}</span>
          <span class="alarm-zeile-hint">{{ t('view.mindestbestand.soundAnHint') }}</span>
        </span>
      </label>

      <label v-if="soundAn" class="alarm-zeile alarm-zeile-indent">
        <span class="alarm-zeile-label">{{ t('view.mindestbestand.lautstaerke') }}</span>
        <span class="alarm-slider-zeile">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            :value="lautstaerke"
            :disabled="speichert"
            :aria-label="t('view.mindestbestand.lautstaerke')"
            @input="onLautstaerke"
          />
          <span class="alarm-slider-wert">{{ lautstaerke }} %</span>
        </span>
      </label>

      <label class="alarm-zeile">
        <input
          type="checkbox"
          :checked="wiederholen"
          disabled
          :title="t('view.mindestbestand.wiederholenNoch')"
          @change="onWiederholen(($event.target as HTMLInputElement).checked)"
        />
        <span class="alarm-zeile-text">
          <span class="alarm-zeile-label">
            {{ t('view.mindestbestand.wiederholen') }}
            <em class="alarm-badge-soon">{{ t('view.mindestbestand.bald') }}</em>
          </span>
          <span class="alarm-zeile-hint">{{ t('view.mindestbestand.wiederholenHint') }}</span>
        </span>
      </label>

      <div class="alarm-aktionen">
        <button type="button" :disabled="!soundAn || speichert" @click="testen">
          {{ t('view.mindestbestand.testen') }}
        </button>
      </div>

      <p class="alarm-permission-hinweis" :class="`state-${permission}`">
        <template v-if="permission === 'unsupported'">
          {{ t('view.mindestbestand.permUnsupported') }}
        </template>
        <template v-else-if="permission === 'denied'">
          {{ t('view.mindestbestand.permDenied') }}
        </template>
        <template v-else-if="permission === 'default'">
          {{ t('view.mindestbestand.permDefault') }}
          <button type="button" class="link-btn" @click="permissionAnfordern">
            {{ t('view.mindestbestand.permAnfordern') }}
          </button>
        </template>
        <template v-else>
          {{ t('view.mindestbestand.permGranted') }}
        </template>
      </p>
      <p class="alarm-technik-hinweis">{{ t('view.mindestbestand.technikHinweis') }}</p>
    </section>

    <div class="card">
      <div class="filter-row">
        <label>
          <span>{{ t('view.mindestbestand.filterArtikel') }}</span>
          <select v-model="filterArtikel">
            <option value="">{{ t('view.mindestbestand.alleArtikel') }}</option>
            <option v-for="a in artikelOptionen" :key="a.id" :value="a.id">
              {{ a.titel }}
            </option>
          </select>
        </label>
        <label>
          <span>{{ t('view.mindestbestand.filterStandort') }}</span>
          <select v-model="filterStandort">
            <option value="">{{ t('view.mindestbestand.alleStandorte') }}</option>
            <option v-for="s in standortStore.aktive" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>
      </div>

      <p v-if="gefiltert.length === 0" class="empty-state">
        {{ t('view.mindestbestand.empty') }}
      </p>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>{{ t('view.mindestbestand.colZeit') }}</th>
            <th>{{ t('view.mindestbestand.colArtikel') }}</th>
            <th>{{ t('view.mindestbestand.colStandort') }}</th>
            <th>{{ t('view.mindestbestand.colBestand') }}</th>
            <th>{{ t('view.mindestbestand.colMindest') }}</th>
            <th>{{ t('view.mindestbestand.colDefizit') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ev in gefiltert" :key="ev.id">
            <td>{{ formatDatum(ev.erstelltAm) }}</td>
            <td>{{ artikelTitel(ev.artikelId) }}</td>
            <td>{{ standortName(ev.standortId) }}</td>
            <td>{{ ev.bestandDanach }}</td>
            <td>{{ ev.mindestbestand }}</td>
            <td class="defizit">{{ ev.defizit }}</td>
            <td>
              <button type="button" class="btn" @click="open(ev.artikelId)">
                {{ t('view.mindestbestand.openArtikel') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-muted);
  margin: 0 0 0.6rem;
}
.filter-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.8rem;
  flex-wrap: wrap;
}
.filter-row label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.85rem;
  min-width: 12rem;
}
.filter-row select {
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border-strong, #ccc);
  background: var(--bg-input, #fff);
  color: var(--text);
}

/* ---------- Benachrichtigungs-Einstellungen ---------- */
.alarm-settings {
  margin-bottom: 1rem;
}
.alarm-settings-titel {
  margin: 0 0 0.7rem;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.alarm-zeile {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.45rem 0;
  cursor: pointer;
}
.alarm-zeile input[type='checkbox'] {
  margin-top: 0.2rem;
  width: 1.05rem;
  height: 1.05rem;
  flex: 0 0 auto;
  accent-color: var(--accent);
}
.alarm-zeile-indent {
  padding-left: 1.65rem;
  flex-wrap: wrap;
}
.alarm-zeile-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.alarm-zeile-label {
  font-size: 0.9rem;
  color: var(--text-strong);
}
.alarm-zeile-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
}
.alarm-slider-zeile {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 1;
  min-width: 12rem;
}
.alarm-slider-zeile input[type='range'] {
  flex: 1;
  accent-color: var(--accent);
  min-width: 8rem;
}
.alarm-slider-wert {
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
  color: var(--text-muted);
  min-width: 3rem;
  text-align: right;
}
.alarm-badge-soon {
  font-style: normal;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.05rem 0.35rem;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent);
  vertical-align: middle;
  margin-left: 0.3rem;
}
.alarm-aktionen {
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.alarm-aktionen button {
  padding: 0.4rem 0.85rem;
  font-size: 0.85rem;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  font-family: inherit;
}
.alarm-aktionen button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.alarm-aktionen button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.alarm-permission-hinweis {
  margin: 0.6rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.alarm-permission-hinweis.state-granted {
  color: var(--success, #16a34a);
}
.alarm-permission-hinweis.state-denied,
.alarm-permission-hinweis.state-unsupported {
  color: var(--text-muted);
}
.alarm-technik-hinweis {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  color: var(--text-muted);
  opacity: 0.85;
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: inherit;
  padding: 0 0 0 0.35rem;
  text-decoration: underline;
}
.data-table {
  width: 100%;
  border-collapse: collapse;
}
.data-table th,
.data-table td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border-color, #eee);
}
.data-table th {
  font-size: 0.85rem;
  color: var(--text-muted);
  font-weight: 600;
  border-bottom: 2px solid var(--border-color, #ccc);
}
.defizit {
  color: #c0392b;
  font-weight: 600;
}
.empty-state {
  color: var(--text-muted);
  padding: 1rem 0;
  text-align: center;
}
</style>
