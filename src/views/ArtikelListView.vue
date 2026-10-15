<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useBuchungStore } from '../stores/buchung'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import { useTableSort } from '../composables/useTableSort'
import SortableTh from '../components/SortableTh.vue'
import type { Artikel, ArtikelStatus } from '../db/types'

const { t } = useI18n()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const buchungStore = useBuchungStore()
const { alleBenutzten } = useArtikelTypen()

const suche = ref('')
const filterTyp = ref('')
const filterStatus = ref<'alle' | ArtikelStatus>('verfuegbar')

function applyFilter(): void {
  artikelStore.setFilter({
    suche: suche.value,
    typ: filterTyp.value || undefined,
    status: filterStatus.value,
  })
}

type SortKey = 'titel' | 'typ' | 'bestand'

const standardStandort = computed(() => standortStore.standardlager)

const sortierung = useTableSort<Artikel, SortKey>({
  defaultKey: 'titel',
  defaultDir: 'asc',
  getValue: (a, k) => {
    if (k === 'bestand') {
      const sl = standardStandort.value
      return sl ? buchungStore.getBestand(a.id, sl.id) : 0
    }
    return a[k]
  },
})

const zeilen = computed(() => sortierung.sortiere(artikelStore.gefiltert))

function bestandStandard(artikelId: string, standortId: string): number {
  return buchungStore.getBestand(artikelId, standortId)
}

const statusOptionen: { value: 'alle' | ArtikelStatus; labelKey: string }[] = [
  { value: 'verfuegbar', labelKey: 'view.artikel.status.verfuegbar' },
  { value: 'reserviert', labelKey: 'view.artikel.status.reserviert' },
  { value: 'gesperrt', labelKey: 'view.artikel.status.gesperrt' },
  { value: 'ausgesondert', labelKey: 'view.artikel.status.ausgesondert' },
  { value: 'archiviert', labelKey: 'view.artikel.status.archiviert' },
  { value: 'alle', labelKey: 'view.artikel.filter.statusAlle' },
]
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.artikel.h1') }}</h1>
      <RouterLink to="/artikel/neu" class="btn primary">{{ t('view.artikel.neu') }}</RouterLink>
    </header>

    <div class="filter-bar">
      <input
        v-model="suche"
        type="search"
        :placeholder="t('view.artikel.suche')"
        @input="applyFilter"
      />
      <select v-model="filterTyp" @change="applyFilter">
        <option value="">{{ t('view.artikel.filter.typ') }} —</option>
        <option v-for="typ in alleBenutzten" :key="typ" :value="typ">{{ typ }}</option>
      </select>
      <select v-model="filterStatus" @change="applyFilter">
        <option v-for="opt in statusOptionen" :key="opt.value" :value="opt.value">
          {{ t(opt.labelKey) }}
        </option>
      </select>
    </div>

    <p v-if="zeilen.length === 0" class="empty-state">{{ t('view.artikel.leer') }}</p>

    <table v-else class="data desktop-only">
      <thead>
        <tr>
          <SortableTh
            :label="t('view.artikel.spalten.titel')"
            sort-key="titel"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            :label="t('view.artikel.spalten.typ')"
            sort-key="typ"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <SortableTh
            v-if="standardStandort"
            :label="`${t('view.artikel.spalten.bestand')} (${standardStandort.name})`"
            sort-key="bestand"
            align="right"
            :active-key="sortierung.sortKey.value"
            :dir="sortierung.sortDir.value"
            @sort="sortierung.onSort"
          />
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in zeilen" :key="a.id">
          <td>
            <RouterLink :to="`/artikel/${a.id}`" class="link">{{ a.titel }}</RouterLink>
          </td>
          <td>{{ a.typ }}</td>
          <td v-if="standardStandort" class="num">
            {{ bestandStandard(a.id, standardStandort.id) }}
          </td>
          <td class="actions-cell">
            <RouterLink :to="`/buchung/neu?artikelId=${a.id}`" class="btn">
              {{ t('view.artikel.detail.buchen') }}
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- Mobile Card-Liste: gleiche Daten, anderes Layout.
         Per .data display:none auf Mobile bereits ausgeblendet,
         deshalb erscheint nur diese Liste. -->
    <ul v-if="zeilen.length > 0" class="card-list mobile-only" role="list">
      <li v-for="a in zeilen" :key="a.id" class="card-list-item">
        <RouterLink :to="`/artikel/${a.id}`" class="card-list-title">{{ a.titel }}</RouterLink>
        <div class="card-list-meta">
          <span class="badge">{{ a.typ }}</span>
          <span v-if="standardStandort">
            <span class="muted">{{ t('view.artikel.spalten.bestand') }}:</span>
            <span class="num">{{ bestandStandard(a.id, standardStandort.id) }}</span>
          </span>
        </div>
        <div class="card-list-actions">
          <RouterLink :to="`/buchung/neu?artikelId=${a.id}`" class="btn primary">
            {{ t('view.artikel.detail.buchen') }}
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

.link {
  color: var(--text-strong);
  font-weight: 500;
}
.link:hover {
  color: var(--accent);
  text-decoration: none;
}

.actions-cell {
  flex-wrap: wrap;
  gap: 0.3rem;
}
</style>
