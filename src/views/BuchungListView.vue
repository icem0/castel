<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useBuchungStore } from '../stores/buchung'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useTableSort } from '../composables/useTableSort'
import SortableTh from '../components/SortableTh.vue'
import type { Buchung } from '../db/types'

const { t } = useI18n()
const buchungStore = useBuchungStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()

const artikelFilter = ref<string>('')

function istStorniert(b: Buchung): boolean {
  return b.storno || b.typ === 'storno'
}

function statusLabel(b: Buchung): string {
  if (b.typ === 'storno') return t('view.buchung.status.storno')
  if (b.storno) return t('view.buchung.status.storniert')
  return t('view.buchung.status.aktiv')
}

type SortKey = 'erstelltAm' | 'artikel' | 'standort' | 'typ' | 'menge' | 'projekt' | 'von'

const sortierung = useTableSort<Buchung, SortKey>({
  defaultKey: 'erstelltAm',
  defaultDir: 'desc',
  getValue: (b, k) => {
    switch (k) {
      case 'erstelltAm':
        return b.erstelltAm
      case 'artikel':
        return nameArtikel(b.artikelId)
      case 'standort':
        return nameStandort(b.standortId)
      case 'typ':
        return b.typ
      case 'menge':
        return b.menge
      case 'projekt':
        return b.projekt ?? ''
      case 'von':
        return b.erstelltVon
    }
  },
})

const gefiltert = computed<Buchung[]>(() =>
  buchungStore.buchungen.filter((b) => {
    if (artikelFilter.value && b.artikelId !== artikelFilter.value) return false
    return true
  }),
)

const zeilen = computed<Buchung[]>(() => sortierung.sortiere(gefiltert.value))

function nameArtikel(id: string): string {
  return artikelStore.byId(id)?.titel ?? '—'
}
function nameStandort(id: string): string {
  return standortStore.byId(id)?.name ?? '—'
}

function formatTyp(typ: Buchung['typ']): string {
  if (typ === 'einlagerung' || typ === 'entnahme' || typ === 'umlagerung' || typ === 'inventur') {
    return t(`view.buchung.form.typen.${typ}`)
  }
  return typ
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatDatumKurz(iso: string): string {
  const d = new Date(iso)
  return (
    d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' }) +
    ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  )
}

async function stornieren(b: Buchung): Promise<void> {
  if (istStorniert(b)) return
  if (!confirm('Stornieren?')) return
  await buchungStore.mu.stornieren({
    buchungId: b.id,
    grund: 'Storno aus Buchungsliste',
    erstelltVon: '',
  })
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.buchung.h1') }}</h1>
      <RouterLink to="/buchung/neu" class="btn primary">{{ t('view.common.neu') }}</RouterLink>
    </header>

    <div class="filter-bar">
      <select v-model="artikelFilter">
        <option value="">— Alle Artikel —</option>
        <option v-for="a in artikelStore.artikel" :key="a.id" :value="a.id">{{ a.titel }}</option>
      </select>
    </div>

    <p v-if="zeilen.length === 0" class="empty-state">{{ t('view.buchung.leer') }}</p>

    <table v-else class="data">
      <thead>
        <tr>
          <SortableTh
            :label="t('view.buchung.spalten.zeit')"
            sort-key="erstelltAm"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.artikel')"
            sort-key="artikel"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.standort')"
            sort-key="standort"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.typ')"
            sort-key="typ"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.menge')"
            sort-key="menge"
            align="right"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.projekt')"
            sort-key="projekt"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.buchung.spalten.von')"
            sort-key="von"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <th>{{ t('view.buchung.spalten.status') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in zeilen" :key="b.id" :class="{ storno: istStorniert(b) }">
          <td>{{ formatDatum(b.erstelltAm) }}</td>
          <td>{{ nameArtikel(b.artikelId) }}</td>
          <td>{{ nameStandort(b.standortId) }}</td>
          <td>
            <span class="badge">{{ formatTyp(b.typ) }}</span>
          </td>
          <td :class="b.menge > 0 ? 'num-plus' : b.menge < 0 ? 'num-minus' : 'num'">
            {{ b.menge > 0 ? '+' : '' }}{{ b.menge }}
          </td>
          <td>{{ b.projekt ?? '—' }}</td>
          <td>{{ b.erstelltVon }}</td>
          <td>
            <span class="status-badge" :class="istStorniert(b) ? 'status-storno' : 'status-aktiv'">
              {{ statusLabel(b) }}
            </span>
          </td>
          <td class="actions-cell">
            <button
              v-if="!istStorniert(b) && b.typ !== 'kommission'"
              type="button"
              class="danger"
              @click="stornieren(b)"
            >
              Storno
            </button>
            <RouterLink v-if="b.typ === 'kommission'" :to="`/kommission/${b.id}`" class="btn">
              …
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>

    <ul v-if="zeilen.length > 0" class="card-list mobile-only" role="list">
      <li
        v-for="b in zeilen"
        :key="b.id"
        class="card-list-item"
        :class="{ storno: istStorniert(b) }"
      >
        <div class="card-list-title-row">
          <span class="card-list-title">{{ nameArtikel(b.artikelId) }}</span>
          <span class="num" :class="b.menge > 0 ? 'num-plus' : b.menge < 0 ? 'num-minus' : ''">
            {{ b.menge > 0 ? '+' : '' }}{{ b.menge }}
          </span>
        </div>
        <div class="card-list-meta">
          <span class="badge">{{ formatTyp(b.typ) }}</span>
          <span class="status-badge" :class="istStorniert(b) ? 'status-storno' : 'status-aktiv'">
            {{ statusLabel(b) }}
          </span>
          <span class="muted">{{ nameStandort(b.standortId) }}</span>
          <span class="muted">{{ formatDatumKurz(b.erstelltAm) }}</span>
          <span v-if="b.projekt" class="muted">{{ b.projekt }}</span>
        </div>
        <div class="card-list-actions">
          <button
            v-if="!istStorniert(b) && b.typ !== 'kommission'"
            type="button"
            class="danger"
            @click="stornieren(b)"
          >
            Storno
          </button>
          <RouterLink v-if="b.typ === 'kommission'" :to="`/kommission/${b.id}`" class="btn">
            Kommission
          </RouterLink>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.data .num {
  font-variant-numeric: tabular-nums;
  text-align: right;
  font-weight: 600;
}
.data .num-plus {
  color: var(--accent, #0a7a2a);
}
.data .num-minus {
  color: var(--danger, #b53030);
}
.data .storno td {
  color: var(--text-muted, #888);
}
.data .storno td.num-plus,
.data .storno td.num-minus {
  color: var(--text-muted, #888);
}

.card-list-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}
.card-list-item .num {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--text-strong);
}
.card-list-item .num-plus {
  color: var(--accent, #0a7a2a);
}
.card-list-item .num-minus {
  color: var(--danger, #b53030);
}
.card-list-item.storno .card-list-title,
.card-list-item.storno .num {
  text-decoration: line-through;
  color: var(--text-muted, #888);
}

.status-badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 0.4rem;
  font-size: 0.85em;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}
.status-aktiv {
  background: rgba(10, 122, 42, 0.12);
  color: var(--accent, #0a7a2a);
}
.status-storno {
  background: rgba(181, 48, 48, 0.12);
  color: var(--danger, #b53030);
}
</style>
