<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useSettingsStore } from '../stores/settings'
import { useBarcodeRender } from '../composables/useBarcodeRender'
import type { Artikel } from '../db/types'

const { t } = useI18n()
const route = useRoute()
const artikelStore = useArtikelStore()
const settings = useSettingsStore()

const auswahlArtikel = ref<Artikel | null>(null)
const barcodeWert = ref('')
const laufend = ref(false)
const speicherHinweis = ref('')

const barcodeQuelle = computed<string | null | undefined>(() => barcodeWert.value)
const { el: barcodeEl, fehler: barcodeFehler } = useBarcodeRender(barcodeQuelle, {
  width: 2,
  height: 60,
  displayValue: true,
  fontSize: 16,
  margin: 10,
})

function artikelOptionen(): Artikel[] {
  return artikelStore.artikel
}

function aufArtikelWechseln(): void {
  const a = auswahlArtikel.value
  barcodeWert.value = a?.barcode ?? ''
  speicherHinweis.value = ''
}

onMounted(() => {
  settings.start()
  artikelStore.start()
  const queryArtikelId = route.query.artikelId
  if (typeof queryArtikelId === 'string') {
    const a = artikelStore.byId(queryArtikelId)
    if (a) {
      auswahlArtikel.value = a
      barcodeWert.value = a.barcode ?? ''
    }
  }
})

async function speichernAmArtikel(): Promise<void> {
  if (!auswahlArtikel.value) return
  laufend.value = true
  speicherHinweis.value = ''
  try {
    await artikelStore.aktualisieren(auswahlArtikel.value.id, {
      barcode: barcodeWert.value.trim() || null,
    })
    speicherHinweis.value = t('view.barcode.gespeichert')
    auswahlArtikel.value = artikelStore.byId(auswahlArtikel.value.id) ?? null
  } catch (e) {
    speicherHinweis.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

async function bildSpeichern(): Promise<void> {
  if (!barcodeEl.value) return
  const svg = barcodeEl.value.cloneNode(true) as SVGSVGElement
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const serializer = new XMLSerializer()
  const svgString = serializer.serializeToString(svg)
  const blob = new Blob([svgString], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)

  const width = parseInt(svg.getAttribute('width') ?? '') || barcodeEl.value.clientWidth || 400
  const height = parseInt(svg.getAttribute('height') ?? '') || barcodeEl.value.clientHeight || 100

  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(img, 0, 0, width, height)
      const pngUrl = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.download = `barcode-${barcodeWert.value.trim() || 'etikett'}.png`
      a.href = pngUrl
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    }
    URL.revokeObjectURL(url)
  }
  img.src = url
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.barcode.h1') }}</h1>
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
          <input v-model="barcodeWert" type="text" inputmode="text" :disabled="laufend" />
          <small class="hint">
            {{ t('view.barcode.wertHint') }}
          </small>
        </label>

        <p v-if="auswahlArtikel" class="hint format-hinweis">
          {{ t('view.barcode.formatLabel') }}:
          <strong>{{ settings.settings.barcodeTyp }}</strong>
        </p>

        <div class="form-actions">
          <button
            type="button"
            class="primary"
            :disabled="!auswahlArtikel || !barcodeWert.trim() || laufend"
            @click="speichernAmArtikel"
          >
            {{ t('view.barcode.zuArtikelSpeichern') }}
          </button>
          <button type="button" :disabled="!barcodeWert.trim() || laufend" @click="bildSpeichern">
            {{ t('view.barcode.bildSpeichern') }}
          </button>
          <span v-if="laufend" class="hint">{{ t('view.barcode.speichert') }}…</span>
          <span v-if="speicherHinweis" class="hint fehler">{{ speicherHinweis }}</span>
        </div>
      </form>
    </div>

    <div class="card barcode-vorschau">
      <svg ref="barcodeEl"></svg>
      <small v-if="barcodeFehler" class="fehler hint">{{ barcodeFehler }}</small>
    </div>
  </section>
</template>

<style scoped>
.view-head {
  display: flex;
  align-items: center;
}
.barcode-vorschau {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1.5rem;
  border: 1px dashed var(--border, #ccc);
  border-radius: 0.5rem;
  background: #fff;
  min-height: 120px;
}
.format-hinweis {
  margin: 0;
  padding: 0.4rem 0.6rem;
  background: var(--bg-input, #f4f4f4);
  border-radius: 0.25rem;
  border: 1px solid var(--border, #cbd5e1);
}
.fehler {
  color: var(--error, #c00);
}
</style>
