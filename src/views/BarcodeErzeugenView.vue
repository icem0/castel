<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useSettingsStore } from '../stores/settings'
import { useStandortStore } from '../stores/standort'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import { useArtikelFilter } from '../composables/useArtikelFilter'
import { useTableSort } from '../composables/useTableSort'
import { useBarcodeRender } from '../composables/useBarcodeRender'
import { etikettenIstNeu } from '../domain/etiketten'
import {
  ETIKETTEN_PRESETS,
  PRESET_ID_BENUTZERDEFINIERT,
  benutzerdefiniertesPreset,
  etikettenJeSeite,
  seitenAnzahl,
  type EtikettenPreset,
} from '../services/etiketten/presets'
import { presetWarnungen } from '../services/etiketten/layout'
import { downloadPdf, erzeugeEtikettenPdf, type EtikettDaten } from '../services/etiketten/pdf'
import type { Artikel, ArtikelStatus } from '../db/types'

const { t } = useI18n()
const route = useRoute()
const artikelStore = useArtikelStore()
const settings = useSettingsStore()
const standortStore = useStandortStore()
const { alleBenutzten } = useArtikelTypen()

// ---------- Tab: Einzel-Etikett (bestehende Funktion) ----------

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

// ---------- Tab: Serien-Etiketten (DIN A4) ----------

const tab = ref<'serie' | 'einzel'>('serie')

const { suche, filterTyp, filterStatus, filterStandort, gefiltert } = useArtikelFilter(
  () => artikelStore.artikel,
)

// Standard: nur die als "neu" markierten Artikel zeigen — das ist der
// Arbeitsfall "Bogen fuer die neuen Artikel drucken". Der Filter laesst
// sich abschalten, um den kompletten Bestand zu sehen.
const nurNeu = ref(true)
const auswahl = ref<Set<string>>(new Set())

const sortierung = useTableSort<Artikel, 'titel' | 'typ'>({
  defaultKey: 'titel',
  defaultDir: 'asc',
  getValue: (a, k) => a[k],
})

/** Artikel nach Filter + "nur neu" + Sortierung. */
const sichtbar = computed<Artikel[]>(() => {
  const basis = nurNeu.value ? gefiltert.value.filter(etikettenIstNeu) : gefiltert.value
  return sortierung.sortiere(basis)
})

/** Artikel in der aktuellen Ansicht, die einen Barcode haben. */
const mitBarcode = computed<Artikel[]>(() => sichtbar.value.filter((a) => !!a.barcode?.trim()))
const ohneBarcodeAnzahl = computed(() => sichtbar.value.length - mitBarcode.value.length)

const auswahlAnzahl = computed(() => {
  let n = 0
  for (const id of auswahl.value) {
    const a = artikelStore.byId(id)
    if (a && a.barcode?.trim()) n++
  }
  return n
})

function istGewaehlt(id: string): boolean {
  return auswahl.value.has(id)
}

function umschalten(id: string): void {
  const neu = new Set(auswahl.value)
  if (neu.has(id)) neu.delete(id)
  else neu.add(id)
  auswahl.value = neu
}

function alleAuswaehlen(): void {
  const neu = new Set(auswahl.value)
  for (const a of mitBarcode.value) neu.add(a.id)
  auswahl.value = neu
}

function auswahlAufheben(): void {
  auswahl.value = new Set()
}

// ---------- Layout (Bogen) ----------

const presetId = ref<string>(ETIKETTEN_PRESETS[0]?.id ?? PRESET_ID_BENUTZERDEFINIERT)
const custom = ref<EtikettenPreset>(benutzerdefiniertesPreset())

const preset = computed<EtikettenPreset>(() => {
  if (presetId.value === PRESET_ID_BENUTZERDEFINIERT) return custom.value
  return ETIKETTEN_PRESETS.find((p) => p.id === presetId.value) ?? benutzerdefiniertesPreset()
})

const layoutWarnungen = computed(() => presetWarnungen(preset.value))
const etikettenProSeite = computed(() => etikettenJeSeite(preset.value))
const seiten = computed(() => seitenAnzahl(auswahlAnzahl.value, preset.value))

// ---------- Aktionen ----------

const pdfLaeuft = ref(false)
const pdfWarnungen = ref<string[]>([])
const aktionsHinweis = ref('')

async function pdfErzeugen(): Promise<void> {
  if (auswahlAnzahl.value === 0) {
    aktionsHinweis.value = t('view.barcode.serie.keineAuswahl')
    return
  }
  pdfLaeuft.value = true
  aktionsHinweis.value = ''
  pdfWarnungen.value = []
  try {
    const daten: EtikettDaten[] = sichtbar.value
      .filter((a) => auswahl.value.has(a.id) && !!a.barcode?.trim())
      .map((a) => ({
        id: a.id,
        titel: a.titel,
        typ: a.typ,
        barcode: a.barcode,
      }))
    const ergebnis = await erzeugeEtikettenPdf(daten, preset.value, settings.settings.barcodeTyp)
    downloadPdf(ergebnis.blob, ergebnis.dateiname)
    pdfWarnungen.value = ergebnis.warnungen
    aktionsHinweis.value = t('view.barcode.serie.pdfFertig', {
      anzahl: ergebnis.seiten,
      etiketten: daten.length,
    })
  } catch (e) {
    aktionsHinweis.value = e instanceof Error ? e.message : String(e)
  } finally {
    pdfLaeuft.value = false
  }
}

/** Setzt/loescht den Etiketten-Marker "neu" fuer ALLE Artikel. */
async function setzeNeuTags(wert: boolean): Promise<void> {
  const frage = wert
    ? t('view.barcode.serie.tagsSetzenFrage')
    : t('view.barcode.serie.tagsLoeschenFrage')
  if (!confirm(frage)) return
  aktionsHinweis.value = ''
  const ids = artikelStore.artikel.map((a) => a.id)
  const anzahl = await artikelStore.markiereEtikettenNeu(ids, wert)
  aktionsHinweis.value = wert
    ? t('view.barcode.serie.tagsGesetzt', { anzahl })
    : t('view.barcode.serie.tagsGeloescht', { anzahl })
}

/**
 * Deep-Link `/etiketten?artikelId=<id>`: zeigt das Einzel-Etikett des
 * Artikels. Die Artikelliste laedt asynchron (Dexie liveQuery) — der
 * Artikel ist beim Mount oft noch nicht da, deshalb wird der Deep-Link
 * erneut angewendet, sobald die Daten eintreffen.
 */
function deepLinkAnwenden(): void {
  const id = route.query.artikelId
  if (typeof id !== 'string') return
  const a = artikelStore.byId(id)
  if (!a) return
  auswahlArtikel.value = a
  barcodeWert.value = a.barcode ?? ''
  tab.value = 'einzel'
}

onMounted(() => {
  settings.start()
  artikelStore.start()
  deepLinkAnwenden()
})

watch(() => route.query.artikelId, deepLinkAnwenden)
watch(() => artikelStore.artikel, deepLinkAnwenden)

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
      <h1>{{ t('view.barcode.h1') }}</h1>
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab"
          :class="{ aktiv: tab === 'serie' }"
          role="tab"
          :aria-selected="tab === 'serie'"
          @click="tab = 'serie'"
        >
          {{ t('view.barcode.serie.tab') }}
        </button>
        <button
          type="button"
          class="tab"
          :class="{ aktiv: tab === 'einzel' }"
          role="tab"
          :aria-selected="tab === 'einzel'"
          @click="tab = 'einzel'"
        >
          {{ t('view.barcode.serie.tabEinzel') }}
        </button>
      </div>
    </header>

    <!-- ---------- Serien-Etiketten (A4) ---------- -->
    <template v-if="tab === 'serie'">
      <div class="card">
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
            <option v-for="s in standortStore.aktive" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
          <label class="checkbox-inline">
            <input v-model="nurNeu" type="checkbox" />
            <span>{{ t('view.barcode.serie.nurNeu') }}</span>
          </label>
        </div>

        <div class="auswahl-zeile">
          <button type="button" class="btn" @click="alleAuswaehlen">
            {{ t('view.barcode.serie.alleAuswaehlen') }}
          </button>
          <button type="button" class="btn" @click="auswahlAufheben">
            {{ t('view.barcode.serie.auswahlAufheben') }}
          </button>
          <span class="hint">{{
            t('view.barcode.serie.auswahlInfo', { anzahl: auswahlAnzahl })
          }}</span>
          <span v-if="ohneBarcodeAnzahl > 0" class="hint">
            {{ t('view.barcode.serie.ohneBarcode', { anzahl: ohneBarcodeAnzahl }) }}
          </span>
        </div>

        <div v-if="sichtbar.length === 0" class="empty-state">
          <p v-if="nurNeu">{{ t('view.barcode.serie.leerKeineNeue') }}</p>
          <p v-else>{{ t('view.artikel.leer') }}</p>
        </div>

        <table v-else class="data">
          <thead>
            <tr>
              <th style="width: 40px"></th>
              <th>{{ t('view.artikel.spalten.titel') }}</th>
              <th>{{ t('view.artikel.spalten.typ') }}</th>
              <th>{{ t('view.barcode.serie.spalten.barcode') }}</th>
              <th style="width: 60px">{{ t('view.barcode.serie.spalten.neu') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in sichtbar" :key="a.id" :class="{ ohneBarcode: !a.barcode?.trim() }">
              <td>
                <input
                  type="checkbox"
                  :checked="istGewaehlt(a.id)"
                  :disabled="!a.barcode?.trim()"
                  :aria-label="a.titel"
                  @change="umschalten(a.id)"
                />
              </td>
              <td>{{ a.titel }}</td>
              <td>{{ a.typ }}</td>
              <td class="mono">{{ a.barcode ?? '—' }}</td>
              <td>
                <span v-if="etikettenIstNeu(a)" class="badge-neu">{{
                  t('view.barcode.serie.neuBadge')
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 class="card-titel">{{ t('view.barcode.serie.bogenTitel') }}</h2>
        <label class="form-label">
          <span>{{ t('view.barcode.serie.layout') }}</span>
          <select v-model="presetId">
            <option v-for="p in ETIKETTEN_PRESETS" :key="p.id" :value="p.id">
              {{ t(p.nameKey) }}
            </option>
            <option :value="PRESET_ID_BENUTZERDEFINIERT">
              {{ t('view.barcode.serie.layoutBenutzerdefiniert') }}
            </option>
          </select>
        </label>

        <div v-if="presetId === PRESET_ID_BENUTZERDEFINIERT" class="custom-grid">
          <label>
            <span>{{ t('view.barcode.serie.custom.cols') }}</span>
            <input v-model.number="custom.cols" type="number" min="1" max="20" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.rows') }}</span>
            <input v-model.number="custom.rows" type="number" min="1" max="100" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.labelW') }}</span>
            <input v-model.number="custom.labelW" type="number" min="5" max="210" step="0.1" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.labelH') }}</span>
            <input v-model.number="custom.labelH" type="number" min="3" max="297" step="0.1" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.gapX') }}</span>
            <input v-model.number="custom.gapX" type="number" min="0" max="50" step="0.1" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.gapY') }}</span>
            <input v-model.number="custom.gapY" type="number" min="0" max="50" step="0.1" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.marginX') }}</span>
            <input v-model.number="custom.marginX" type="number" min="0" max="50" step="0.1" />
          </label>
          <label>
            <span>{{ t('view.barcode.serie.custom.marginY') }}</span>
            <input v-model.number="custom.marginY" type="number" min="0" max="50" step="0.1" />
          </label>
        </div>

        <p class="hint">
          {{
            t('view.barcode.serie.seitenInfo', {
              etiketten: auswahlAnzahl,
              seiten,
              proSeite: etikettenProSeite,
            })
          }}
        </p>
        <p v-if="layoutWarnungen.length > 0" class="hint fehler">
          {{ t('view.barcode.serie.layoutFehler', { grund: layoutWarnungen.join(', ') }) }}
        </p>

        <div class="form-actions">
          <button
            type="button"
            class="primary"
            :disabled="auswahlAnzahl === 0 || pdfLaeuft || layoutWarnungen.length > 0"
            @click="pdfErzeugen"
          >
            {{ t('view.barcode.serie.pdfErzeugen') }}
          </button>
          <span v-if="pdfLaeuft" class="hint">{{ t('view.barcode.serie.pdfLaeuft') }}</span>
        </div>

        <p v-if="aktionsHinweis" class="hint">{{ aktionsHinweis }}</p>
        <ul v-if="pdfWarnungen.length > 0" class="warnliste">
          <li v-for="w in pdfWarnungen" :key="w">{{ w }}</li>
        </ul>
      </div>

      <div class="card">
        <h2 class="card-titel">{{ t('view.barcode.serie.tagsTitel') }}</h2>
        <p class="hint">{{ t('view.barcode.serie.tagsHint') }}</p>
        <div class="form-actions">
          <button type="button" @click="setzeNeuTags(false)">
            {{ t('view.barcode.serie.tagsLoeschen') }}
          </button>
          <button type="button" @click="setzeNeuTags(true)">
            {{ t('view.barcode.serie.tagsSetzen') }}
          </button>
        </div>
      </div>
    </template>

    <!-- ---------- Einzel-Etikett ---------- -->
    <template v-else>
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
    </template>
  </section>
</template>

<style scoped>
.view-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.tabs {
  display: flex;
  gap: 0.35rem;
}

.tab {
  border: 1px solid var(--border, #cbd5e1);
  background: var(--bg-input, #f4f4f4);
  color: var(--text, #111);
  border-radius: var(--radius-sm, 0.25rem);
  padding: 0.45rem 0.8rem;
  font-size: 0.95rem;
  cursor: pointer;
}

.tab.aktiv {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}

.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}

.auswahl-zeile {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}

.checkbox-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  white-space: nowrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
}

.badge-neu {
  display: inline-block;
  background: var(--accent, #2563eb);
  color: #fff;
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
}

tr.ohneBarcode td {
  opacity: 0.6;
}

.custom-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.6rem;
  margin: 0.6rem 0;
}

.custom-grid label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.9rem;
}

.warnliste {
  margin: 0.5rem 0 0;
  padding-left: 1.1rem;
  color: var(--error, #c00);
  font-size: 0.9rem;
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
