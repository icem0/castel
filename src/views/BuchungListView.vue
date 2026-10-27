<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useBuchungStore } from '../stores/buchung'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useAuthStore } from '../stores/auth'
import { useTableSort } from '../composables/useTableSort'
import SortableTh from '../components/SortableTh.vue'
import ArtikelSucheSelect from '../components/ArtikelSucheSelect.vue'
import ArtikelLink from '../components/ArtikelLink.vue'
import { istKommissionStorno } from '../domain/buchungen'
import type { Buchung } from '../db/types'

const { t } = useI18n()
const buchungStore = useBuchungStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const auth = useAuthStore()

const artikelFilter = ref<string>('')
const typFilter = ref<Buchung['typ'] | ''>('')
const laufend = ref(false)
const fehler = ref('')

function istStorniert(b: Buchung): boolean {
  return b.storno || b.typ === 'storno'
}

function findeBuchung(id: string | null): Buchung | undefined {
  if (!id) return undefined
  return buchungStore.buchungen.find((b) => b.id === id)
}

/**
 * A storno can be undone when its original booking is currently cancelled by
 * exactly this storno. Commission stornos are excluded (a replacement booking
 * already carries the quantity).
 */
function istAufhebbar(s: Buchung): boolean {
  if (s.typ !== 'storno' || !s.storno || !s.stornoVon) return false
  const original = findeBuchung(s.stornoVon)
  if (!original || original.storno !== true || original.storniertDurch !== s.id) return false
  return !istKommissionStorno(s, original, buchungStore.buchungen)
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
    if (typFilter.value && b.typ !== typFilter.value) return false
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
  if (
    typ === 'einlagerung' ||
    typ === 'entnahme' ||
    typ === 'umlagerung' ||
    typ === 'inventur' ||
    typ === 'kommission' ||
    typ === 'storno'
  ) {
    return t(`view.buchung.form.typen.${typ}`)
  }
  return typ
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

async function stornieren(b: Buchung): Promise<void> {
  if (laufend.value || istStorniert(b)) return
  if (!confirm(t('view.buchung.stornoFrage'))) return
  laufend.value = true
  fehler.value = ''
  try {
    await buchungStore.mu.stornieren({
      buchungId: b.id,
      grund: t('view.buchung.stornoGrund'),
      erstelltVon: auth.erstelltVon,
    })
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

async function stornoAufheben(s: Buchung): Promise<void> {
  if (laufend.value || !istAufhebbar(s)) return
  if (!confirm(t('view.buchung.stornoAufhebenFrage'))) return
  laufend.value = true
  fehler.value = ''
  try {
    await buchungStore.mu.stornoAufheben({
      stornoId: s.id,
      grund: t('view.buchung.stornoAufhebenGrund'),
      erstelltVon: auth.erstelltVon,
    })
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.buchung.h1') }}</h1>
      <RouterLink to="/buchung/neu" class="btn primary">{{ t('view.common.neu') }}</RouterLink>
    </header>

    <div class="filter-bar">
      <ArtikelSucheSelect
        v-model="artikelFilter"
        class="filter-suche"
        :items="artikelStore.artikel"
        :placeholder="t('view.buchung.filterArtikel')"
      />
      <select v-model="typFilter">
        <option value="">— Alle Typen —</option>
        <option value="einlagerung">{{ formatTyp('einlagerung') }}</option>
        <option value="entnahme">{{ formatTyp('entnahme') }}</option>
        <option value="umlagerung">{{ formatTyp('umlagerung') }}</option>
        <option value="inventur">{{ formatTyp('inventur') }}</option>
        <option value="kommission">Kommission</option>
        <option value="storno">Storno</option>
      </select>
    </div>

    <p v-if="fehler" class="hint hint-danger" role="alert">{{ fehler }}</p>

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
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in zeilen" :key="b.id" :class="{ storno: istStorniert(b) }">
          <td>{{ formatDatum(b.erstelltAm) }}</td>
          <td>
            <ArtikelLink :artikel-id="b.artikelId" />
          </td>
          <td>{{ nameStandort(b.standortId) }}</td>
          <td>
            <span class="badge">{{ formatTyp(b.typ) }}</span>
            <span
              v-if="b.nichtGespeichert"
              class="badge badge-nicht-gespeichert"
              :title="b.skipBemerkung ?? t('app.sync.lokalNichtGespeichert')"
            >
              {{ t('app.sync.lokalNichtGespeichert') }}
            </span>
          </td>
          <td :class="b.menge > 0 ? 'num-plus' : b.menge < 0 ? 'num-minus' : 'num'">
            {{ b.menge > 0 ? '+' : '' }}{{ b.menge }}
          </td>
          <td>{{ b.projekt ?? '—' }}</td>
          <td>{{ b.erstelltVon }}</td>
          <td class="actions-cell">
            <button
              v-if="!istStorniert(b) && b.typ !== 'kommission'"
              type="button"
              class="danger"
              :disabled="laufend"
              @click="stornieren(b)"
            >
              {{ t('view.buchung.stornoAktion') }}
            </button>
            <button
              v-if="istAufhebbar(b)"
              type="button"
              class="btn"
              :disabled="laufend"
              @click="stornoAufheben(b)"
            >
              {{ t('view.buchung.stornoAufhebenAktion') }}
            </button>
            <RouterLink v-if="b.typ === 'kommission'" :to="`/kommission/${b.id}`" class="btn">
              …
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.filter-bar .filter-suche {
  flex: 1 1 16rem;
  min-width: 12rem;
}
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
.badge-nicht-gespeichert {
  margin-left: 0.35rem;
  background: rgba(245, 158, 11, 0.18);
  color: #b45309;
  border: 1px solid rgba(245, 158, 11, 0.5);
}
</style>
