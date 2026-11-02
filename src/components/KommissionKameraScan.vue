<script setup lang="ts">
// KommissionKameraScan — Kamera-Scan der Kommissionsnummer.
//
// Der User richtet die Kamera so aus, dass die Ziffern im markierten
// Streifen liegen, bestaetigt, und die OCR liest genau dieses Feld aus.
// Das Ergebnis wird gegen die bestehenden Kommissionen gematcht:
//   - Treffer  -> bestehende Kommission uebernehmen
//   - kein Treffer -> der User wird gefragt, ob eine neue Kommission
//     mit der Nummer angelegt werden soll.
//
// Das Scan-Feld ist bewusst ein breiter Streifen (eine Zeile mit gut
// zehn Ziffern) — quadratische Ausschnitte liefern bei OCR deutlich
// schlechtere Treffer.

import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MAX_KOMMISSION_LAENGE, useKommissionen } from '../composables/useKommissionen'
import { useKommissionOcr, type OcrResult } from '../composables/useKommissionOcr'
import { berechneVideoAusschnitt, type OcrKandidat, type Rechteck } from '../domain/kommission-ocr'
import { matcheKommission } from '../domain/kommission-scan'

const props = withDefaults(
  defineProps<{
    modelValue: string
    disabled?: boolean
  }>(),
  { disabled: false },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()
const { optionen, hinzufuegen } = useKommissionen()

const { fehler, scan: ocrScan, stop: ocrStop, ensureWorker } = useKommissionOcr()

const videoEl = ref<HTMLVideoElement | null>(null)
const containerEl = ref<HTMLElement | null>(null)

const kameraAktiv = ref(false)
const kameraLaeuft = ref(false)
const kameraFehler = ref<string | null>(null)
const ocrBereit = ref(false)
const ocrLaedt = ref(false)
const scanLaeuft = ref(false)
const scanErgebnis = ref<OcrResult | null>(null)
const scanIndex = ref(0)

/** Die vom User korrigierbare Nummer (vorbelegt mit dem OCR-Treffer). */
const nummer = ref('')

/**
 * Scan-Streifen in normalisierten Container-Koordinaten (0..1).
 * Breiter Streifen: eine Zeile mit rund zehn Ziffern.
 */
const cropRect = ref<Rechteck>({ x: 0.04, y: 0.43, width: 0.92, height: 0.14 })

const dragModus = ref<'none' | 'move' | 'resize'>('none')
const dragStart = ref({ x: 0, y: 0 })
const cropStart = ref<Rechteck>({ x: 0, y: 0, width: 0, height: 0 })

const scannedKandidat = computed<OcrKandidat | null>(
  () => scanErgebnis.value?.kandidaten[scanIndex.value] ?? null,
)

/** Match gegen die bestehenden Kommissionen — fuer die eingegebene Nummer. */
const scanTreffer = computed<string | null>(() =>
  nummer.value.trim() === '' ? null : matcheKommission(nummer.value.trim(), optionen.value),
)

/** True, wenn eine Nummer erkannt wurde, aber keiner bestehenden entspricht. */
const neuAnlegenVorgeschlagen = computed<boolean>(
  () => scanErgebnis.value !== null && nummer.value.trim() !== '' && scanTreffer.value === null,
)

async function starteKamera(): Promise<void> {
  if (kameraAktiv.value || kameraLaeuft.value) return
  kameraFehler.value = null
  kameraLaeuft.value = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
    if (!videoEl.value) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    videoEl.value.srcObject = stream
    await videoEl.value.play()
    kameraAktiv.value = true
    // OCR parallel vorladen, damit der erste Scan nicht ewig dauert
    // und fehlende Assets sofort sichtbar werden.
    void ladeOcr()
  } catch (e) {
    kameraFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    kameraLaeuft.value = false
  }
}

async function ladeOcr(): Promise<void> {
  if (ocrBereit.value || ocrLaedt.value) return
  ocrLaedt.value = true
  try {
    await ensureWorker()
    ocrBereit.value = true
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    ocrLaedt.value = false
  }
}

function stoppeKamera(): void {
  kameraAktiv.value = false
  if (videoEl.value) {
    const stream = videoEl.value.srcObject as MediaStream | null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
    videoEl.value.srcObject = null
  }
  void ocrStop()
}

onBeforeUnmount(stoppeKamera)

function clampRect(r: Rechteck): Rechteck {
  const minHoehe = 0.06
  const x = Math.min(Math.max(r.x, 0), 1)
  const y = Math.min(Math.max(r.y, 0), 1 - minHoehe)
  const width = Math.min(Math.max(r.width, 0.1), 1 - x)
  const height = Math.min(Math.max(r.height, minHoehe), 1 - y)
  return { x, y, width, height }
}

function onPointerDown(e: PointerEvent, modus: 'move' | 'resize'): void {
  if (props.disabled) return
  e.preventDefault()
  e.stopPropagation()
  const ziel = e.currentTarget as HTMLElement | null
  ziel?.setPointerCapture?.(e.pointerId)
  dragModus.value = modus
  dragStart.value = { x: e.clientX, y: e.clientY }
  cropStart.value = { ...cropRect.value }
}

function onPointerMove(e: PointerEvent): void {
  if (dragModus.value === 'none') return
  const r = containerEl.value?.getBoundingClientRect()
  if (!r || r.width === 0 || r.height === 0) return

  // Pixel -> normalisiert
  const nx = (e.clientX - dragStart.value.x) / r.width
  const ny = (e.clientY - dragStart.value.y) / r.height

  if (dragModus.value === 'move') {
    cropRect.value = clampRect({
      x: cropStart.value.x + nx,
      y: cropStart.value.y + ny,
      width: cropStart.value.width,
      height: cropStart.value.height,
    })
  } else {
    // Hoehe anpassen (Anfasspunkt unten rechts) — die Breite bleibt.
    cropRect.value = clampRect({
      x: cropStart.value.x,
      y: cropStart.value.y,
      width: cropStart.value.width,
      height: cropStart.value.height + ny,
    })
  }
}

function onPointerUp(): void {
  dragModus.value = 'none'
}

/**
 * Wartet, bis das Video ein Bild liefert. Ohne das ist videoWidth 0 und
 * der OCR bekommt ein 1x1-Pixel-Bild — der Scan liefe ins Leere.
 */
async function warteAufVideoBild(): Promise<void> {
  const video = videoEl.value
  if (!video) throw new Error(t('view.kommission.kameraScan.keinVideo'))
  if (video.videoWidth > 0 && video.readyState >= 2) return

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      aufraeumen()
      reject(new Error(t('view.kommission.kameraScan.keinVideo')))
    }, 10000)

    const aufraeumen = (): void => {
      window.clearTimeout(timeout)
      video.removeEventListener('loadeddata', pruefe)
      video.removeEventListener('canplay', pruefe)
    }
    const pruefe = (): void => {
      if (video.videoWidth > 0) {
        aufraeumen()
        resolve()
      }
    }

    video.addEventListener('loadeddata', pruefe)
    video.addEventListener('canplay', pruefe)
    pruefe()
  })
}

/** Rechnet den Streifen (Container) in das Quell-Rechteck des Videos um. */
function videoAusschnitt(): Rechteck {
  const container = containerEl.value?.getBoundingClientRect()
  const video = videoEl.value
  if (!container || !video || video.videoWidth === 0) {
    return { x: 0, y: 0, width: 1, height: 1 }
  }
  const streifenPx: Rechteck = {
    x: cropRect.value.x * container.width,
    y: cropRect.value.y * container.height,
    width: cropRect.value.width * container.width,
    height: cropRect.value.height * container.height,
  }
  return berechneVideoAusschnitt(
    { width: container.width, height: container.height },
    { width: video.videoWidth, height: video.videoHeight },
    streifenPx,
    'cover',
  )
}

async function bestaetigeScan(): Promise<void> {
  if (scanLaeuft.value) return
  fehler.value = ''
  scanLaeuft.value = true
  try {
    if (!kameraAktiv.value) await starteKamera()
    if (!videoEl.value) return

    await warteAufVideoBild()
    if (!ocrBereit.value) await ladeOcr()

    const ausschnitt = videoAusschnitt()
    const result = await ocrScan(videoEl.value, ausschnitt)
    scanErgebnis.value = result
    scanIndex.value = 0
    nummer.value = result.beste?.wert ?? ''
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanLaeuft.value = false
  }
}

function kandidatWechseln(index: number): void {
  scanIndex.value = index
  const kandidat = scanErgebnis.value?.kandidaten[index]
  if (kandidat) nummer.value = kandidat.wert
}

function trefferUebernehmen(): void {
  const treffer = scanTreffer.value
  if (!treffer) return
  emit('update:modelValue', treffer)
  stoppeKamera()
}

async function neueKommissionAnlegen(): Promise<void> {
  const wert = nummer.value.trim()
  fehler.value = ''
  if (wert === '') {
    fehler.value = t('view.kommissionen.fehlerLeer')
    return
  }
  const grund = await hinzufuegen(wert)
  if (grund !== null) {
    fehler.value =
      grund === 'leer'
        ? t('view.kommissionen.fehlerLeer')
        : grund === 'duplikat'
          ? t('view.kommissionen.fehlerDuplikat', { name: wert })
          : t('view.kommission.fehlerZuLang', { max: MAX_KOMMISSION_LAENGE })
    return
  }
  emit('update:modelValue', wert)
  stoppeKamera()
}
</script>

<template>
  <div ref="containerEl" class="kamera-scan" :class="{ disabled }">
    <p v-if="kameraFehler" class="fehler" role="alert">{{ kameraFehler }}</p>

    <div class="video-wrap">
      <video ref="videoEl" class="video" playsinline autoplay muted></video>

      <div v-if="!kameraAktiv" class="kamera-start">
        <button
          type="button"
          class="primary"
          :disabled="disabled || kameraLaeuft"
          @click="starteKamera"
        >
          {{ kameraLaeuft ? '…' : t('view.kommission.kameraScan.kameraStarten') }}
        </button>
        <p class="hint">{{ t('view.kommission.kameraScan.hinweis') }}</p>
      </div>

      <template v-else>
        <div
          class="crop-overlay"
          :style="{
            left: `${cropRect.x * 100}%`,
            top: `${cropRect.y * 100}%`,
            width: `${cropRect.width * 100}%`,
            height: `${cropRect.height * 100}%`,
          }"
          @pointerdown="onPointerDown($event, 'move')"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <span class="crop-label">{{ t('view.kommission.kameraScan.ausschnitt') }}</span>
          <span
            class="crop-handle"
            @pointerdown="onPointerDown($event, 'resize')"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          ></span>
        </div>

        <div class="scan-aktionen">
          <button
            type="button"
            class="primary scan-btn"
            :disabled="disabled || scanLaeuft || ocrLaedt"
            @click="bestaetigeScan"
          >
            {{
              scanLaeuft
                ? t('view.kommission.kameraScan.erkennt')
                : t('view.kommission.kameraScan.bestaetigen')
            }}
          </button>
        </div>

        <p v-if="ocrLaedt" class="hinweis-zeile">
          {{ t('view.kommission.kameraScan.ocrLaden') }}
        </p>
      </template>
    </div>

    <div v-if="scanErgebnis" class="scan-ergebnis">
      <p v-if="scanErgebnis.kandidaten.length > 1" class="kandidaten">
        <label for="kamera-kandidaten">{{ t('view.kommission.kameraScan.kandidaten') }}</label>
        <select
          id="kamera-kandidaten"
          :value="scanIndex"
          @change="kandidatWechseln(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="(k, i) in scanErgebnis.kandidaten" :key="i" :value="i">
            {{ k.wert }}{{ k.keyword ? ` — ${k.keyword}` : '' }}
          </option>
        </select>
      </p>

      <label class="nummer-feld">
        <span>{{ t('view.kommission.kameraScan.nummer') }}</span>
        <input
          v-model="nummer"
          type="text"
          inputmode="text"
          autocomplete="off"
          :disabled="disabled"
        />
        <small v-if="scannedKandidat?.keyword" class="keyword-hinweis">
          {{ t('view.kommission.kameraScan.gefundenAls', { keyword: scannedKandidat.keyword }) }}
        </small>
      </label>

      <!-- Treffer: bestehende Kommission uebernehmen -->
      <div v-if="scanTreffer" class="ergebnis-karte">
        <p class="treffer">
          {{ t('view.kommission.kameraScan.bestehend', { name: scanTreffer }) }}
        </p>
        <div class="scan-aktionen">
          <button type="button" class="primary" :disabled="disabled" @click="trefferUebernehmen">
            {{ t('view.kommission.kameraScan.uebernehmen') }}
          </button>
        </div>
      </div>

      <!-- Kein Treffer: nachfragen, ob eine neue Kommission angelegt wird -->
      <div v-else-if="neuAnlegenVorgeschlagen" class="ergebnis-karte">
        <p class="frage">
          {{ t('view.kommission.kameraScan.neuFrage', { nummer: nummer.trim() }) }}
        </p>
        <div class="scan-aktionen">
          <button type="button" class="primary" :disabled="disabled" @click="neueKommissionAnlegen">
            {{ t('view.kommission.kameraScan.neuAnlegen') }}
          </button>
          <button type="button" class="btn" :disabled="disabled" @click="scanErgebnis = null">
            {{ t('view.kommission.kameraScan.verwerfen') }}
          </button>
        </div>
      </div>

      <!-- Gar nichts erkannt: Rohtext zeigen, Nummer von Hand korrigieren -->
      <div v-else class="ergebnis-karte">
        <p class="frage">{{ t('view.kommission.kameraScan.keineNummer') }}</p>
        <p v-if="scanErgebnis.text" class="rohtext">„{{ scanErgebnis.text }}“</p>
        <div class="scan-aktionen">
          <button type="button" class="primary" :disabled="disabled" @click="bestaetigeScan">
            {{ t('view.kommission.kameraScan.erneut') }}
          </button>
        </div>
      </div>
    </div>

    <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>
  </div>
</template>

<style scoped>
.kamera-scan {
  display: grid;
  gap: 0.5rem;
  max-width: 100%;
}

.kamera-scan.disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* Breites Fenster — der Scan-Streifen ist eine Zeile, kein Quadrat. */
.video-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  touch-action: none;
}

.video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.kamera-start {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 1rem;
  text-align: center;
  background: var(--bg-input);
}

.crop-overlay {
  position: absolute;
  left: 4%;
  top: 43%;
  width: 92%;
  height: 14%;
  border: 2px solid var(--accent);
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  cursor: move;
  z-index: 10;
  display: grid;
  place-items: center;
  touch-action: none;
}

.crop-label {
  pointer-events: none;
  z-index: 20;
  color: var(--accent);
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}

.crop-handle {
  position: absolute;
  right: -10px;
  bottom: -10px;
  width: 22px;
  height: 22px;
  background: var(--accent);
  border: 2px solid var(--bg-input);
  border-radius: 50%;
  cursor: nwse-resize;
  z-index: 20;
  touch-action: none;
}

.scan-aktionen {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.scan-btn {
  flex: 1;
}

.scan-ergebnis {
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  padding: 0.6rem;
  background: var(--bg-input);
}

.ergebnis-karte {
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
}

.kandidaten {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
}

.kandidaten select {
  font: inherit;
  padding: 0.2rem 0.4rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: inherit;
}

.nummer-feld {
  display: grid;
  gap: 0.2rem;
  margin: 0 0 0.5rem;
}

.nummer-feld > span {
  color: var(--text-muted);
  font-size: 0.8rem;
  font-weight: 500;
}

.nummer-feld input {
  font: inherit;
  padding: 0.4rem 0.6rem;
  color: inherit;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.keyword-hinweis {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.treffer,
.frage {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
}

.frage {
  font-weight: 500;
}

.rohtext {
  margin: 0 0 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
  word-break: break-all;
}

.hinweis-zeile {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.fehler {
  margin: 0;
  color: var(--error);
  font-size: 0.85rem;
}

@media (max-width: 540px) {
  .kamera-start {
    padding: 0.5rem;
  }
  .crop-label {
    font-size: 0.55rem;
  }
}
</style>
