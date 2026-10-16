<script setup lang="ts">
import { onMounted, ref, watch, nextTick } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import type { Artikel } from '../db/types'
import JsBarcode from 'jsbarcode'

const { t } = useI18n()
const route = useRoute()
const artikelStore = useArtikelStore()

const barcodeEl = ref<SVGSVGElement | null>(null)
const auswahlArtikel = ref<Artikel | null>(null)
const barcodeWert = ref('')
const format = ref<'CODE128' | 'EAN13' | 'CODE39'>('CODE128')
const anzeigen = ref(false)
const fehler = ref('')
const laufend = ref(false)

const formate = [
  { wert: 'CODE128' as const, label: t('view.barcode.formatCode128') },
  { wert: 'EAN13' as const, label: t('view.barcode.formatEAN13') },
  { wert: 'CODE39' as const, label: t('view.barcode.formatCode39') },
]

function artikelOptionen(): Artikel[] {
  return artikelStore.artikel
}

function aufArtikelWechseln(): void {
  const a = auswahlArtikel.value
  barcodeWert.value = a?.barcode ?? ''
  anzeigen.value = false
  fehler.value = ''
  renderBarcode()
}

function renderBarcode(): void {
  if (!barcodeEl.value) return
  const wert = barcodeWert.value.trim()
  if (!wert) {
    barcodeEl.value.innerHTML = ''
    anzeigen.value = false
    return
  }
  try {
    barcodeEl.value.innerHTML = ''
    JsBarcode(barcodeEl.value, wert, {
      format: format.value,
      width: 2,
      height: 60,
      displayValue: true,
      fontSize: 16,
      margin: 10,
    })
    anzeigen.value = true
    fehler.value = ''
  } catch (e) {
    anzeigen.value = false
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

watch(
  () => barcodeWert.value,
  () => {
    renderBarcode()
  },
)

watch(
  () => format.value,
  () => {
    renderBarcode()
  },
)

onMounted(() => {
  artikelStore.start()
  const queryArtikelId = route.query.artikelId
  if (typeof queryArtikelId === 'string') {
    const a = artikelStore.byId(queryArtikelId)
    if (a) {
      auswahlArtikel.value = a
      barcodeWert.value = a.barcode ?? ''
    }
  }
  nextTick(() => renderBarcode())
})

async function speichernAmArtikel(): Promise<void> {
  if (!auswahlArtikel.value) return
  laufend.value = true
  fehler.value = ''
  try {
    await artikelStore.aktualisieren(auswahlArtikel.value.id, {
      barcode: barcodeWert.value.trim() || null,
    })
    fehler.value = t('view.barcode.gespeichert')
    auswahlArtikel.value = artikelStore.byId(auswahlArtikel.value.id) ?? null
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

function drucken(): void {
  window.print()
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.barcode.h1') }}</h1>
      <RouterLink to="/einstellungen" class="btn">{{ t('common.abbrechen') }}</RouterLink>
    </header>

    <div class="card">
      <form class="form" @submit.prevent>
        <label>
          <span>{{ t('view.barcode.artikel') }} *</span>
          <select v-model="auswahlArtikel" :disabled="laufend" @change="aufArtikelWechseln">
            <option :value="null">{{ t('view.barcode.artikelWaehlen') }}</option>
            <option v-for="a in artikelOptionen()" :key="a.id" :value="a">
              {{ a.titel }} {{ a.typ ? '(' + a.typ + ')' : '' }}
            </option>
          </select>
        </label>

        <label v-if="auswahlArtikel">
          <span>{{ t('view.barcode.wert') }}</span>
          <input
            v-model="barcodeWert"
            type="text"
            inputmode="text"
            :disabled="laufend"
            @input="renderBarcode"
          />
          <small class="hint">
            {{ t('view.barcode.wertHint') }}
          </small>
        </label>

        <label v-if="auswahlArtikel">
          <span>{{ t('view.barcode.format') }}</span>
          <select v-model="format" :disabled="laufend">
            <option v-for="f in formate" :key="f.wert" :value="f.wert">
              {{ f.label }}
            </option>
          </select>
        </label>

        <div class="form-actions">
          <button
            type="button"
            class="primary"
            :disabled="!auswahlArtikel || !barcodeWert.trim() || laufend"
            @click="speichernAmArtikel"
          >
            {{ t('view.barcode.zuArtikelSpeichern') }}
          </button>
          <button type="button" :disabled="!anzeigen || laufend" @click="drucken">
            {{ t('view.barcode.drucken') }}
          </button>
          <span v-if="laufend" class="hint">{{ t('view.barcode.speichert') }}…</span>
          <span v-if="fehler" class="hint fehler">{{ fehler }}</span>
        </div>
      </form>
    </div>

    <div v-if="anzeigen" class="card barcode-vorschau">
      <svg ref="barcodeEl"></svg>
    </div>
  </section>
</template>

<style scoped>
.view-head {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.btn {
  margin-left: auto;
}
.barcode-vorschau {
  display: flex;
  justify-content: center;
  padding: 1.5rem;
  border: 1px dashed var(--border, #ccc);
  border-radius: 0.5rem;
  background: #fff;
}
.fehler {
  color: var(--error, #c00);
}
</style>
