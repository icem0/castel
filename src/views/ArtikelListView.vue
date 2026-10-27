<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useArtikelStandortMindestbestandStore } from '../stores/artikelStandortMindestbestand'
import { useBuchungStore } from '../stores/buchung'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import { useArtikelFilter } from '../composables/useArtikelFilter'
import { useTableSort } from '../composables/useTableSort'
import { useSyncStore } from '../stores/sync'
import { sortiereNachName } from '../domain/sortierung'
import { ladeFotoThumbnails, type FotoThumbnail } from '../services/fotos'
import SortableTh from '../components/SortableTh.vue'
import type { Artikel, ArtikelStatus } from '../db/types'

const { t } = useI18n()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const mindestbestandStore = useArtikelStandortMindestbestandStore()
const buchungStore = useBuchungStore()
const { alleBenutzten } = useArtikelTypen()
const sync = useSyncStore()

// Filterlogik (Suche/Typ/Status/Standort) liegt im Composable, damit die
// Etiketten-Ansicht dieselben Filter benutzen kann.
const { suche, filterTyp, filterStatus, filterStandort, gefiltert } = useArtikelFilter(
  () => artikelStore.artikel,
)

// Foto-Thumbnails: werden beim Mount einmal geladen und in folgenden
// Situationen neu gefetcht, damit Bild-Zuweisungen, die auf einem anderen
// Gerät passiert sind, hier sichtbar werden:
//   - Browser feuert 'online'-Event (war kurz offline)
//   - Tab wird wieder sichtbar (visibilitychange)
//   - Sync-Worker hat einen Pull abgeschlossen (status: syncing → idle)
// Damit wirkt jede Foto-Zuweisung server-weit, nicht pro Gerät.
const thumbnails = ref<Map<string, FotoThumbnail>>(new Map())
const offline = computed(() => sync.status.status === 'offline')

let ladeThumbnailsInFlight = false
async function ladeThumbnails(): Promise<void> {
  if (offline.value) return
  if (ladeThumbnailsInFlight) return
  ladeThumbnailsInFlight = true
  try {
    const liste = await ladeFotoThumbnails()
    const m = new Map<string, FotoThumbnail>()
    for (const t of liste) m.set(t.artikelId, t)
    thumbnails.value = m
  } catch {
    // still ok — Spalte wird ohne Thumbs gerendert
  } finally {
    ladeThumbnailsInFlight = false
  }
}

function onOnline(): void {
  void ladeThumbnails()
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    void ladeThumbnails()
  }
}

// Sync-Worker beobachten: nach jedem erfolgreichen Pull (status: syncing →
// idle) refreshen. So sehen wir Bild-Änderungen, die ein anderes Gerät
// gerade per Push an den Server geschickt hat, beim nächsten Render-Frame.
let letzterStatus: string | null = null
function onSyncStatus(next: { status: string }): void {
  const war = letzterStatus
  letzterStatus = next.status
  if (war === 'syncing' && next.status === 'idle') {
    void ladeThumbnails()
  }
}

onMounted(() => {
  mindestbestandStore.start()
  void ladeThumbnails()
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  sync.onSyncStatus(onSyncStatus)
  letzterStatus = sync.status.status
})
onBeforeUnmount(() => {
  window.removeEventListener('online', onOnline)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

// Lightbox: Klick aufs Thumbnail → Bild groß, Klick auf den Backdrop
// (oder ESC) → zu. State ist nur die URL + der zugehörige Artikel-Titel.
const lightboxUrl = ref<string | null>(null)
const lightboxTitel = ref<string>('')

function openLightbox(url: string, titel: string): void {
  lightboxUrl.value = url
  lightboxTitel.value = titel
}

function closeLightbox(): void {
  lightboxUrl.value = null
  lightboxTitel.value = ''
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && lightboxUrl.value !== null) {
    closeLightbox()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

type SortKey = 'titel' | 'typ' | 'bestand'

const standardStandort = computed(() => standortStore.standardlager)

const standortOptionen = computed(() => sortiereNachName(standortStore.aktive, (s) => s.name))

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

const zeilen = computed(() => sortierung.sortiere(gefiltert.value))

function bestandStandard(artikelId: string, standortId: string): number {
  return buchungStore.getBestand(artikelId, standortId)
}

function bestandBenotigtAufmerksamkeit(artikelId: string, standortId: string): boolean {
  const a = artikelStore.byId(artikelId)
  if (!a) return false
  const bestand = buchungStore.getBestand(artikelId, standortId)
  if (bestand < 0) return true
  const schwelle = mindestbestandStore.wertFuer(artikelId, standortId)
  if (schwelle > 0 && bestand < schwelle) return true
  return false
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
      <input v-model="suche" type="search" :placeholder="t('view.artikel.suche')" />
      <select v-model="filterTyp">
        <option value="">{{ t('view.artikel.filter.typAlle') }}</option>
        <option v-for="typ in alleBenutzten" :key="typ" :value="typ">{{ typ }}</option>
      </select>
      <select v-model="filterStatus">
        <option v-for="opt in statusOptionen" :key="opt.value" :value="opt.value">
          {{ t(opt.labelKey) }}
        </option>
      </select>
      <select v-model="filterStandort">
        <option value="">{{ t('view.artikel.filter.standortAlle') }}</option>
        <option v-for="s in standortOptionen" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
    </div>

    <p v-if="zeilen.length === 0" class="empty-state">{{ t('view.artikel.leer') }}</p>

    <table v-else class="data">
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
          <th
            v-if="standardStandort"
            style="width: 44px; text-align: center"
            :title="t('view.artikel.spalten.aufmerksamkeit')"
          >
            ⚠
          </th>
          <th v-if="!offline" style="width: 44px; text-align: center">
            {{ t('view.artikel.spalten.foto') }}
          </th>
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
          <td
            v-if="standardStandort"
            class="attention-cell"
            style="width: 44px; text-align: center"
          >
            <RouterLink
              v-if="bestandBenotigtAufmerksamkeit(a.id, standardStandort.id)"
              :to="`/artikel/${a.id}`"
              class="attention-badge link"
              :title="t('view.artikel.spalten.aufmerksamkeit')"
              >⚠</RouterLink
            >
          </td>
          <td v-if="!offline" class="foto-cell" style="width: 44px; text-align: center">
            <button
              v-if="thumbnails.get(a.id)"
              type="button"
              class="foto-thumb-btn"
              :aria-label="`Foto ${a.titel} vergroessern`"
              @click="openLightbox(thumbnails.get(a.id)!.url, a.titel)"
            >
              <img :src="thumbnails.get(a.id)!.url" :alt="a.titel" class="foto-thumb" />
            </button>
          </td>
          <td class="actions-cell">
            <RouterLink :to="`/buchung/neu?artikelId=${a.id}`" class="btn">
              {{ t('view.artikel.detail.buchen') }}
            </RouterLink>
          </td>
        </tr>
      </tbody>
    </table>

    <div
      v-if="lightboxUrl !== null"
      class="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="lightboxTitel"
      @click="closeLightbox"
    >
      <figure class="lightbox-figure" @click.stop>
        <img :src="lightboxUrl" :alt="lightboxTitel" class="lightbox-img" />
        <figcaption class="lightbox-caption">{{ lightboxTitel }}</figcaption>
      </figure>
    </div>
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

.foto-thumb {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  display: block;
}

.foto-thumb-btn {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  display: inline-block;
  line-height: 0;
  -webkit-tap-highlight-color: transparent;
}
.foto-thumb-btn:hover .foto-thumb,
.foto-thumb-btn:focus-visible .foto-thumb {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* Mobile: größere Tap-Targets (Apple HIG: mind. 44×44px) */
@media (max-width: 720px) {
  .foto-thumb {
    width: 44px;
    height: 44px;
  }
  .foto-cell {
    padding: 4px !important;
  }
}

.lightbox-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  cursor: zoom-out;
  -webkit-tap-highlight-color: transparent;
  /* --app-vh: vh als Baseline, dvh wo unterstützt (siehe style.css), damit
     die Lightbox die tatsächlich sichtbare Höhe nutzt. */
  height: var(--app-vh, 100vh);
}

.lightbox-figure {
  margin: 0;
  max-width: 95vw;
  max-height: 95vh;
  max-height: 95dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  cursor: default;
}

.lightbox-img {
  max-width: 100%;
  max-height: calc(95vh - 3rem);
  max-height: calc(95dvh - 3rem);
  object-fit: contain;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  /* Mobile: verhindert Pull-to-refresh und Pinch-Zoom-Drift, während die
     Lightbox offen ist. */
  touch-action: none;
  -webkit-user-drag: none;
}

.lightbox-caption {
  color: white;
  font-size: 1rem;
  text-align: center;
}

.attention-badge {
  display: inline-block;
  font-size: 1.1rem;
  line-height: 1;
}
</style>
