<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useBuchungStore } from '../stores/buchung'
import type { Artikel, Buchung } from '../db/types'
import FotoUpload from './components/FotoUpload.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const buchungStore = useBuchungStore()

const artikelId = computed<string>(() => String(route.params.id ?? ''))
const artikel = computed<Artikel | undefined>(() => artikelStore.byId(artikelId.value))

const bestaende = computed<Array<{ name: string; menge: number; standortId: string }>>(() => {
  if (!artikel.value) return []
  const map = buchungStore.getBestandProStandort(artikel.value.id)
  return standortStore.aktive
    .map((s) => ({ standortId: s.id, name: s.name, menge: map.get(s.id) ?? 0 }))
    .filter((x) => x.menge !== 0)
})

const historie = computed<Buchung[]>(() => {
  if (!artikel.value) return []
  return buchungStore.byArtikel(artikel.value.id).slice().reverse()
})

function nameStandort(id: string): string {
  return standortStore.byId(id)?.name ?? '—'
}

const archivLaufend = ref(false)
const archivFehler = ref('')

async function archivieren(): Promise<void> {
  if (!artikel.value || archivLaufend.value) return
  if (!confirm(t('view.artikel.detail.archivierenFrage'))) return
  archivLaufend.value = true
  archivFehler.value = ''
  try {
    await artikelStore.archivieren(artikel.value.id)
    void router.push('/artikel')
  } catch (e) {
    archivFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaufend.value = false
  }
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <section v-if="artikel" class="view">
    <header class="view-head">
      <h1>
        {{ artikel.titel }}
        <span v-if="artikel.status === 'archiviert'" class="badge">
          {{ t('view.artikel.detail.archiviert') }}
        </span>
      </h1>
      <div class="header-actions">
        <RouterLink :to="`/buchung/neu?artikelId=${artikel.id}`" class="btn primary">
          {{ t('view.artikel.detail.buchen') }}
        </RouterLink>
        <button
          v-if="artikel.status !== 'archiviert'"
          type="button"
          class="danger"
          :disabled="archivLaufend"
          @click="archivieren"
        >
          {{ archivLaufend ? '…' : t('view.artikel.detail.archivieren') }}
        </button>
      </div>
    </header>

    <p v-if="archivFehler" class="fehler" role="alert">{{ archivFehler }}</p>

    <div class="card">
      <dl class="meta">
        <div>
          <dt>{{ t('view.artikel.spalten.typ') }}</dt>
          <dd>{{ artikel.typ }}</dd>
        </div>
        <div>
          <dt>{{ t('view.artikel.spalten.status') }}</dt>
          <dd>{{ t(`view.artikel.status.${artikel.status}`) }}</dd>
        </div>
        <div v-if="artikel.lieferant">
          <dt>{{ t('view.artikel.form.lieferant') }}</dt>
          <dd>{{ artikel.lieferant }}</dd>
        </div>
        <div v-if="artikel.bestellnummer">
          <dt>{{ t('view.artikel.form.bestellnummer') }}</dt>
          <dd>{{ artikel.bestellnummer }}</dd>
        </div>
        <div v-if="artikel.barcode">
          <dt>{{ t('view.artikel.form.barcode') }}</dt>
          <dd>
            <code>{{ artikel.barcode }}</code>
          </dd>
        </div>
        <div v-if="artikel.listenpreis != null">
          <dt>Listenpreis</dt>
          <dd>{{ artikel.listenpreis.toFixed(2) }} €</dd>
        </div>
        <div v-if="artikel.mindestbestand != null">
          <dt>{{ t('view.artikel.form.mindestbestand') }}</dt>
          <dd>{{ artikel.mindestbestand }}</dd>
        </div>
      </dl>
    </div>

    <h2>Fotos</h2>
    <div class="card">
      <FotoUpload
        v-if="artikel"
        :artikel-id="artikel.id"
        :model-value="artikel.fotoUrls"
        @update:model-value="
          (urls: string[]) => {
            if (artikel) artikelStore.aktualisieren(artikel.id, { fotoUrls: urls })
          }
        "
      />
    </div>

    <h2>{{ t('view.artikel.detail.bestandProStandort') }}</h2>
    <div v-if="bestaende.length === 0" class="empty-state muted">—</div>
    <div v-else class="card-grid">
      <div v-for="b in bestaende" :key="b.standortId" class="card stat-card">
        <strong>{{ b.menge }}</strong>
        <span>{{ b.name }}</span>
      </div>
    </div>

    <h2>{{ t('view.artikel.detail.historie') }}</h2>
    <p v-if="historie.length === 0" class="empty-state">{{ t('view.buchung.leer') }}</p>
    <table v-else class="data">
      <thead>
        <tr>
          <th>{{ t('view.buchung.spalten.zeit') }}</th>
          <th>{{ t('view.buchung.spalten.typ') }}</th>
          <th class="num">{{ t('view.buchung.spalten.menge') }}</th>
          <th>{{ t('view.buchung.spalten.standort') }}</th>
          <th>{{ t('view.buchung.spalten.projekt') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in historie" :key="b.id" :class="{ storno: b.storno }">
          <td>{{ formatDatum(b.erstelltAm) }}</td>
          <td>{{ b.typ }}</td>
          <td :class="b.menge > 0 ? 'num-plus' : b.menge < 0 ? 'num-minus' : 'num'">
            {{ b.menge > 0 ? '+' : '' }}{{ b.menge }}
          </td>
          <td>{{ nameStandort(b.standortId) }}</td>
          <td>{{ b.projekt ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
  <section v-else class="view">
    <p class="muted">Lade…</p>
  </section>
</template>

<style scoped>
.header-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.stat-card strong {
  font-size: 1.6rem;
  color: var(--accent);
}
.stat-card span {
  font-size: 0.85rem;
  color: var(--text-muted);
}
</style>
