<script setup lang="ts">
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useBuchungStore } from '../stores/buchung'
import { useAuthStore } from '../stores/auth'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import { useSettingsStore } from '../stores/settings'
import type { Artikel, ArtikelStatus, Buchung } from '../db/types'
import JsBarcode from 'jsbarcode'
import FotoUpload from './components/FotoUpload.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const buchungStore = useBuchungStore()
const auth = useAuthStore()
const { alleWaehlbaren } = useArtikelTypen()
const settings = useSettingsStore()

const barcodeEl = ref<SVGSVGElement | null>(null)

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

// ---------- Bearbeiten ----------

interface BearbeitungsForm {
  titel: string
  typ: string
  status: ArtikelStatus
  lieferant: string
  verpackungseinheit: number
  mindestbestand: number | null
  bestellnummer: string
  barcode: string
  listenpreis: number | null
}

const bearbeitet = ref(false)
const formular = ref<BearbeitungsForm | null>(null)
const bearbeitFehler = ref('')
const bearbeitLaufend = ref(false)

const statusOptionen: ArtikelStatus[] = [
  'verfuegbar',
  'reserviert',
  'gesperrt',
  'ausgesondert',
  'archiviert',
]

function bearbeitenStart(): void {
  const a = artikel.value
  if (!a) return
  formular.value = {
    titel: a.titel,
    typ: a.typ,
    status: a.status,
    lieferant: a.lieferant ?? '',
    verpackungseinheit: a.verpackungseinheit ?? 1,
    mindestbestand: a.mindestbestand,
    bestellnummer: a.bestellnummer ?? '',
    barcode: a.barcode ?? '',
    listenpreis: a.listenpreis,
  }
  bearbeitFehler.value = ''
  bearbeitet.value = true
}

function bearbeitenAbbrechen(): void {
  bearbeitet.value = false
  formular.value = null
  bearbeitFehler.value = ''
}

async function bearbeitenSpeichern(): Promise<void> {
  const a = artikel.value
  const f = formular.value
  if (!a || !f || bearbeitLaufend.value) return
  bearbeitFehler.value = ''
  if (!f.titel.trim()) {
    bearbeitFehler.value = t('view.artikel.form.pflicht') + ': ' + t('view.artikel.form.titel')
    return
  }
  bearbeitLaufend.value = true
  try {
    await artikelStore.aktualisieren(a.id, {
      titel: f.titel.trim(),
      typ: f.typ,
      status: f.status,
      lieferant: f.lieferant.trim() || null,
      verpackungseinheit: f.verpackungseinheit,
      mindestbestand: f.mindestbestand,
      bestellnummer: f.bestellnummer.trim() || null,
      barcode: f.barcode.trim() || null,
      listenpreis: f.listenpreis,
    })
    bearbeitet.value = false
    formular.value = null
  } catch (e) {
    bearbeitFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    bearbeitLaufend.value = false
  }
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

const barcodeTyp = computed(() => settings.settings.barcodeTyp)

function renderBarcode(): void {
  if (!barcodeEl.value) return
  const wert = artikel.value?.barcode?.trim()
  if (!wert) {
    barcodeEl.value.innerHTML = ''
    return
  }
  try {
    barcodeEl.value.innerHTML = ''
    JsBarcode(barcodeEl.value, wert, {
      format: barcodeTyp.value,
      width: 2,
      height: 50,
      displayValue: false,
      fontSize: 12,
      margin: 5,
    })
  } catch (_e) {
    barcodeEl.value.innerHTML = ''
  }
}

watch(
  () => artikel.value?.barcode,
  () => {
    nextTick(() => renderBarcode())
  },
)

watch(
  () => barcodeTyp.value,
  () => {
    nextTick(() => renderBarcode())
  },
)

onMounted(() => {
  artikelStore.start()
  nextTick(() => renderBarcode())
})
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
        <template v-if="!bearbeitet">
          <RouterLink :to="`/buchung/neu?artikelId=${artikel.id}`" class="btn primary">
            {{ t('view.artikel.detail.buchen') }}
          </RouterLink>
          <button type="button" class="btn" @click="bearbeitenStart">
            {{ t('view.artikel.detail.bearbeiten') }}
          </button>
          <button
            v-if="artikel.status !== 'archiviert'"
            type="button"
            class="danger"
            :disabled="archivLaufend"
            @click="archivieren"
          >
            {{ archivLaufend ? '…' : t('view.artikel.detail.archivieren') }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="archivFehler" class="fehler" role="alert">{{ archivFehler }}</p>

    <div v-if="!bearbeitet" class="card">
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
          <dd class="barcode-row">
            <code>{{ artikel.barcode }}</code>
            <svg ref="barcodeEl"></svg>
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

    <div v-else-if="formular" class="card">
      <form
        class="form"
        :aria-busy="bearbeitLaufend || undefined"
        @submit.prevent="bearbeitenSpeichern"
      >
        <label>
          <span>{{ t('view.artikel.form.titel') }} *</span>
          <input v-model="formular.titel" required autocomplete="off" :disabled="bearbeitLaufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.typ') }} {{ t('view.artikel.form.typOptional') }}</span>
          <select v-model="formular.typ" :disabled="bearbeitLaufend">
            <option value="">{{ t('view.artikel.form.typKeiner') }}</option>
            <option v-for="typ in alleWaehlbaren" :key="typ" :value="typ">{{ typ }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.artikel.form.status') }}</span>
          <select
            v-model="formular.status"
            :disabled="bearbeitLaufend || !auth.istAdmin"
            data-testid="artikel-detail-status"
          >
            <option v-for="s in statusOptionen" :key="s" :value="s">
              {{ t(`view.artikel.status.${s}`) }}
            </option>
          </select>
          <small v-if="!auth.istAdmin" class="hint muted">
            {{ t('view.artikel.detail.statusAdminHint') }}
          </small>
        </label>
        <label>
          <span>{{ t('view.artikel.form.lieferant') }}</span>
          <input v-model="formular.lieferant" autocomplete="off" :disabled="bearbeitLaufend" />
        </label>
        <div class="row">
          <label>
            <span>{{ t('view.artikel.form.ve') }}</span>
            <input
              v-model.number="formular.verpackungseinheit"
              type="number"
              min="1"
              :disabled="bearbeitLaufend"
            />
          </label>
          <label>
            <span>{{ t('view.artikel.form.mindestbestand') }}</span>
            <input
              v-model.number="formular.mindestbestand"
              type="number"
              min="0"
              :disabled="bearbeitLaufend"
            />
          </label>
        </div>
        <label>
          <span>{{ t('view.artikel.form.bestellnummer') }}</span>
          <input v-model="formular.bestellnummer" autocomplete="off" :disabled="bearbeitLaufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.barcode') }}</span>
          <input
            v-model="formular.barcode"
            autocomplete="off"
            inputmode="text"
            :disabled="bearbeitLaufend"
          />
        </label>
        <label>
          <span>Listenpreis</span>
          <input
            v-model.number="formular.listenpreis"
            type="number"
            min="0"
            step="0.01"
            :disabled="bearbeitLaufend"
          />
        </label>

        <p v-if="bearbeitFehler" class="fehler" role="alert">{{ bearbeitFehler }}</p>

        <div class="form-actions">
          <button type="submit" class="primary" :disabled="bearbeitLaufend">
            {{ bearbeitLaufend ? '…' : t('view.artikel.form.speichern') }}
          </button>
          <button type="button" :disabled="bearbeitLaufend" @click="bearbeitenAbbrechen">
            {{ t('view.artikel.form.abbrechen') }}
          </button>
        </div>
      </form>
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
.barcode-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.barcode-row code {
  font-size: 0.9rem;
  background: var(--surface-muted, #f4f4f4);
  padding: 0.15rem 0.4rem;
  border-radius: 0.25rem;
}
.header-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
@media (max-width: 540px) {
  .row {
    grid-template-columns: 1fr;
  }
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
