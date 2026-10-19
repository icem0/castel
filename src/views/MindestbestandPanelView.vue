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
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'

const { t } = useI18n()
const router = useRouter()
const mindestbestand = useMindestbestandStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()

const filterArtikel = ref<string>('')
const filterStandort = ref<string>('')

onMounted(() => {
  mindestbestand.start()
  mindestbestand.startMarker()
  void mindestbestand.markiereAlleGesehen()
})

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
  border: 1px solid var(--border-color, #ccc);
  background: var(--input-bg, #fff);
  color: var(--text);
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
