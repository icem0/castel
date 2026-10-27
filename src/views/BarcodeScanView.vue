<script setup lang="ts">
// Barcode-Scan-View: Kamera-Scan mit Direktnavigation in die Buchungsmaske.
// Strategie:
//   - Wenn Artikel mit passendem barcode, passender bestellnummer ODER
//     passender id existiert → /buchung/neu?artikelId=...
//   - Sonst: Dialog mit zwei Wegen — neuen Artikel mit dem Code anlegen
//     ODER den Code einem bestehenden Artikel zuweisen (mit Artikelsuche).
//     Beim Anlegen wird der gescannte Code als `barcode` an die Form
//     weitergereicht (route.query.barcode), damit der Folge-Scan den
//     frisch angelegten Artikel findet.

import { computed, nextTick, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useBarcode } from '../composables/useBarcode'
import ArtikelSucheSelect from '../components/ArtikelSucheSelect.vue'

const { t } = useI18n()
const router = useRouter()
const artikelStore = useArtikelStore()
onMounted(() => artikelStore.start())

const videoEl = ref<HTMLVideoElement | null>(null)
const manuelleEingabe = ref('')
const gefunden = ref<string | null>(null)
let startLaeuft = false

/**
 * Schritte des "Code nicht gefunden"-Dialogs.
 *   auswahl — Wahl zwischen neuem Artikel und Zuweisung an bestehenden
 *   suche  — Artikelsuche, danach wird der Barcode geschrieben
 */
type DialogSchritt = 'auswahl' | 'suche'

const dialogOffen = ref(false)
const dialogCode = ref('')
const dialogSchritt = ref<DialogSchritt>('auswahl')
const gewaehlterArtikelId = ref('')
const zuweisungLaeuft = ref(false)
const zuweisungFehler = ref('')
const sucheRef = ref<InstanceType<typeof ArtikelSucheSelect> | null>(null)

const {
  start,
  stop,
  aktiv,
  fehler: scannerFehler,
} = useBarcode({
  onDetected: (code, format) => {
    void codeVerarbeiten(code, format)
  },
})

/** Kandidaten für die Barcode-Zuweisung — der komplette Artikelbestand. */
const artikelKandidaten = computed(() => artikelStore.artikel)

/** Der im Suchschritt gewählte Artikel. */
const gewaehlterArtikel = computed(
  () => artikelStore.artikel.find((a) => a.id === gewaehlterArtikelId.value) ?? null,
)

/**
 * Barcode, den der gewählte Artikel bereits trägt. Beim Zuweisen wird er
 * ersetzt — der User soll das vorher wissen.
 */
const ersetzterBarcode = computed(() => {
  const alt = gewaehlterArtikel.value?.barcode ?? null
  if (!alt || alt === dialogCode.value) return null
  return alt
})

async function codeVerarbeiten(code: string, _format: string): Promise<void> {
  gefunden.value = code
  // Artikel suchen — Reihenfolge: barcode (primär), bestellnummer (Legacy-
  // Workaround), id (manuell eingegebene UUID). Beim Match direkt in die
  // Buchungsmaske.
  const artikel = artikelStore.artikel.find(
    (a) => a.barcode === code || a.bestellnummer === code || a.id === code,
  )
  if (artikel) {
    void router.push({ name: 'buchung-neu', query: { artikelId: artikel.id, from: 'scan' } })
    return
  }
  // Nicht gefunden — Dialog öffnen. Der User wählt zwischen "neuen Artikel
  // anlegen" und "bestehenden Artikel mit dem Code versehen".
  dialogCode.value = code
  dialogSchritt.value = 'auswahl'
  gewaehlterArtikelId.value = ''
  zuweisungFehler.value = ''
  dialogOffen.value = true
}

/** Neuen Artikel anlegen — der Code wandert als `barcode` in die Form. */
function neuenArtikelAnlegen(): void {
  const code = dialogCode.value
  dialogOffen.value = false
  void router.push({ name: 'artikel-neu', query: { barcode: code } })
}

/** Dialog schließen und den Scanner für den nächsten Code wieder wecken. */
function dialogSchliessen(): void {
  dialogOffen.value = false
  gefunden.value = null
  void scannerFortsetzen()
}

/** In den Artikelsuche-Schritt wechseln und das Suchfeld fokussieren. */
async function zurArtikelsuche(): Promise<void> {
  dialogSchritt.value = 'suche'
  await nextTick()
  sucheRef.value?.focusSuche()
}

/**
 * Den gescannten Code dem gewählten Artikel zuweisen und direkt in die
 * Buchungsmaske des Artikels springen (wie beim Treffer im Scan).
 */
async function barcodeZuweisen(): Promise<void> {
  const artikelId = gewaehlterArtikelId.value
  const code = dialogCode.value
  if (!artikelId || !code || zuweisungLaeuft.value) return
  zuweisungLaeuft.value = true
  zuweisungFehler.value = ''
  try {
    await artikelStore.aktualisieren(artikelId, { barcode: code })
    dialogOffen.value = false
    void router.push({ name: 'buchung-neu', query: { artikelId, from: 'scan' } })
  } catch (e) {
    zuweisungFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    zuweisungLaeuft.value = false
  }
}

function manuellScannen(): void {
  const code = manuelleEingabe.value.trim()
  if (!code) return
  void codeVerarbeiten(code, 'manual')
}

async function kameraStarten(): Promise<void> {
  if (!videoEl.value || startLaeuft) return
  startLaeuft = true
  try {
    await start(videoEl.value)
  } finally {
    startLaeuft = false
  }
}

/** Scanner wieder anwerfen — nur wenn kein Dialog offen ist. */
async function scannerFortsetzen(): Promise<void> {
  if (dialogOffen.value) return
  await kameraStarten()
}

async function scannerNeustarten(): Promise<void> {
  stop()
  await kameraStarten()
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') return
  if (aktiv.value || scannerFehler.value) return
  if (dialogOffen.value) return
  void kameraStarten()
}

/** Escape schließt den Dialog — die Combobox hat ihre eigene Escape-Logik. */
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !dialogOffen.value) return
  if (e.defaultPrevented) return
  dialogSchliessen()
}

onMounted(async () => {
  await new Promise((r) => setTimeout(r, 100))
  await kameraStarten()
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('keydown', onKeydown)
  stop()
})
</script>

<template>
  <section class="view barcode">
    <header class="view-head">
      <h1>{{ t('view.scan.h1') }}</h1>
      <p class="hint">{{ t('view.scan.hint') }}</p>
    </header>

    <div
      class="scanner-area"
      :class="{ 'is-ok': gefunden, 'is-err': scannerFehler }"
      role="region"
      :aria-label="t('view.scan.kameraLabel')"
      :aria-busy="!aktiv && !scannerFehler ? 'true' : undefined"
    >
      <video v-show="aktiv" ref="videoEl" class="scanner-video" playsinline muted autoplay></video>

      <!-- Reticle: zeigt dem User, wohin er den Barcode halten soll. -->
      <div v-if="aktiv" class="scanner-reticle" aria-hidden="true">
        <div class="scanner-reticle-corner tl"></div>
        <div class="scanner-reticle-corner tr"></div>
        <div class="scanner-reticle-corner bl"></div>
        <div class="scanner-reticle-corner br"></div>
        <span class="scanner-reticle-label">{{ t('view.scan.reticleLabel') }}</span>
      </div>

      <div v-if="!aktiv && !scannerFehler" class="scanner-overlay">
        <div class="scanner-status">
          <span class="scanner-spinner" aria-hidden="true"></span>
          <p>{{ t('view.scan.scannerStartet') }}</p>
        </div>
      </div>

      <div v-if="scannerFehler" class="scanner-overlay scanner-error" role="alert">
        <div class="scanner-status">
          <p>
            <strong>{{ t('view.scan.kameraNichtVerfuegbar') }}</strong>
          </p>
          <p class="scanner-error-detail">{{ scannerFehler }}</p>
          <p class="hint">{{ t('view.scan.kameraTipp') }}</p>
          <button type="button" class="scanner-retry" @click="scannerNeustarten">
            {{ t('view.scan.erneutVersuchen') }}
          </button>
        </div>
      </div>

      <div v-if="gefunden" class="scanner-overlay scanner-found" role="status" aria-live="polite">
        <div class="scanner-status">
          <p class="scanner-found-label">{{ t('view.scan.erkannt') }}</p>
          <code class="scanner-found-code">{{ gefunden }}</code>
        </div>
      </div>
    </div>

    <form class="manual-form" @submit.prevent="manuellScannen">
      <input
        v-model="manuelleEingabe"
        type="text"
        inputmode="text"
        autocomplete="off"
        :placeholder="t('view.scan.manuellerCode')"
        :aria-label="t('view.scan.manuellerCodeLabel')"
      />
      <button type="submit" class="primary" :disabled="!manuelleEingabe.trim()">
        {{ t('view.scan.uebernehmen') }}
      </button>
    </form>

    <button
      type="button"
      class="manual-buchen-btn primary"
      @click="router.push({ name: 'buchung-neu', query: { from: 'scan' } })"
    >
      {{ t('view.scan.manuellBuchen') }}
    </button>

    <p class="hint hint-bottom">{{ t('view.scan.fussHinweis') }}</p>

    <!-- Dialog: Code keinem Artikel zugeordnet. -->
    <div
      v-if="dialogOffen"
      class="scan-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-dialog-titel"
    >
      <div class="scan-dialog">
        <header class="scan-dialog-head">
          <h2 id="scan-dialog-titel">
            {{
              dialogSchritt === 'auswahl'
                ? t('view.scan.dialogTitel')
                : t('view.scan.dialogTitelSuche')
            }}
          </h2>
          <button
            type="button"
            class="scan-dialog-close"
            :aria-label="t('view.scan.dialogSchliessen')"
            @click="dialogSchliessen"
          >
            ×
          </button>
        </header>

        <p class="scan-dialog-code">
          <code>{{ dialogCode }}</code>
        </p>

        <!-- Schritt 1: Wahl -->
        <div v-if="dialogSchritt === 'auswahl'" class="scan-dialog-body">
          <p class="hint">{{ t('view.scan.dialogHinweis') }}</p>
          <button type="button" class="primary" @click="neuenArtikelAnlegen">
            {{ t('view.scan.neuenArtikelAnlegen') }}
          </button>
          <button type="button" class="secondary" @click="zurArtikelsuche">
            {{ t('view.scan.bestehendenArtikelZuordnen') }}
          </button>
          <button type="button" class="ghost" @click="dialogSchliessen">
            {{ t('view.scan.abbrechen') }}
          </button>
        </div>

        <!-- Schritt 2: Artikelsuche und Zuweisung -->
        <div v-else class="scan-dialog-body">
          <p class="hint">{{ t('view.scan.zuordnenHinweis') }}</p>
          <ArtikelSucheSelect
            id="scan-artikel-suche"
            ref="sucheRef"
            v-model="gewaehlterArtikelId"
            :items="artikelKandidaten"
            :placeholder="t('view.scan.artikelSuchen')"
          />
          <p v-if="ersetzterBarcode" class="scan-dialog-warnung" role="status">
            {{ t('view.scan.barcodeErsetzt', { code: ersetzterBarcode }) }}
          </p>
          <p v-if="zuweisungFehler" class="scan-dialog-fehler" role="alert">
            {{ zuweisungFehler }}
          </p>
          <button
            type="button"
            class="primary"
            :disabled="!gewaehlterArtikelId || zuweisungLaeuft"
            @click="barcodeZuweisen"
          >
            {{ zuweisungLaeuft ? t('view.scan.speichert') : t('view.scan.barcodeZuweisen') }}
          </button>
          <div class="scan-dialog-zeilen">
            <button type="button" class="ghost" @click="dialogSchritt = 'auswahl'">
              {{ t('view.scan.zurueck') }}
            </button>
            <button type="button" class="ghost" @click="dialogSchliessen">
              {{ t('view.scan.abbrechen') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.barcode {
  max-width: 36rem;
  margin: 0 auto;
}

.view-head {
  text-align: center;
  margin-bottom: 1rem;
}

.view-head .hint {
  margin-top: 0.25rem;
}

.scanner-area {
  position: relative;
  aspect-ratio: 4/3;
  background: #000;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 1rem;
}
.scanner-area.is-ok {
  border-color: var(--success);
}
.scanner-area.is-err {
  border-color: var(--danger);
}

.scanner-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.scanner-reticle {
  position: absolute;
  inset: 12%;
  pointer-events: none;
}
.scanner-reticle-corner {
  position: absolute;
  width: 1.5rem;
  height: 1.5rem;
  border-color: var(--accent);
  border-style: solid;
}
.scanner-reticle-corner.tl {
  top: 0;
  left: 0;
  border-width: 3px 0 0 3px;
  border-top-left-radius: 0.25rem;
}
.scanner-reticle-corner.tr {
  top: 0;
  right: 0;
  border-width: 3px 3px 0 0;
  border-top-right-radius: 0.25rem;
}
.scanner-reticle-corner.bl {
  bottom: 0;
  left: 0;
  border-width: 0 0 3px 3px;
  border-bottom-left-radius: 0.25rem;
}
.scanner-reticle-corner.br {
  bottom: 0;
  right: 0;
  border-width: 3px 3px 0 0;
}
.scanner-reticle-label {
  position: absolute;
  bottom: -1.6rem;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-muted);
  font-weight: 500;
}

.scanner-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.6);
  color: white;
}
.scanner-overlay .scanner-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  max-width: 80%;
}
.scanner-spinner {
  width: 1.75rem;
  height: 1.75rem;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
.scanner-error p {
  margin: 0;
}
.scanner-error-detail {
  font-family: var(--mono);
  font-size: 0.8rem;
  opacity: 0.8;
}
.scanner-error .hint {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.8rem;
  margin-top: 0.5rem;
}
.scanner-retry {
  margin-top: 0.6rem;
  padding: 0.45rem 0.85rem;
  background: var(--accent);
  color: white;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.scanner-retry:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.scanner-found {
  background: rgba(74, 222, 128, 0.85);
  color: #0a3b1c;
}
.scanner-found-label {
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 700;
  margin: 0;
}
.scanner-found-code {
  font-family: var(--mono);
  font-size: 1.25rem;
  font-weight: 600;
  background: rgba(0, 0, 0, 0.18);
  padding: 0.3rem 0.75rem;
  border-radius: var(--radius-sm);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.manual-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.manual-form button {
  min-height: 2.75rem;
}

.manual-buchen-btn {
  display: block;
  width: 100%;
  min-height: 3.5rem;
  font-size: 1.05rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

@media (max-width: 540px) {
  .manual-form {
    grid-template-columns: 1fr;
  }
  .manual-form button {
    order: 2;
  }
}

.hint-bottom {
  color: var(--text-muted);
  font-size: 0.8rem;
  text-align: center;
  margin-top: 0.75rem;
}

/* Dialog "Code nicht gefunden" */
.scan-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.55);
  animation: scan-dialog-fade 0.18s ease-out;
}

@keyframes scan-dialog-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.scan-dialog {
  width: 100%;
  max-width: 28rem;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-pop);
  padding: 1rem 1.1rem 1.1rem;
}

.scan-dialog-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.scan-dialog-head h2 {
  margin: 0;
  font-size: 1.05rem;
}
.scan-dialog-close {
  flex: 0 0 auto;
  width: 1.9rem;
  height: 1.9rem;
  padding: 0;
  justify-content: center;
  font-size: 1.1rem;
  line-height: 1;
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.scan-dialog-close:hover {
  background: var(--bg-input);
  border-color: var(--border-strong);
}

.scan-dialog-code {
  margin: 0.6rem 0 0.9rem;
}
.scan-dialog-code code {
  font-family: var(--mono);
  font-size: 1rem;
  font-weight: 600;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.3rem 0.6rem;
  word-break: break-all;
}

.scan-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
/* Die Trefferliste der Artikelsuche darf den Dialog nicht aus dem Bild
   schieben — hoeher wird sie ohnehin nicht. */
.scan-dialog :deep(.treffer-liste) {
  max-height: 12rem;
}
.scan-dialog-body .hint {
  margin: 0 0 0.25rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.scan-dialog-body > button {
  width: 100%;
  justify-content: center;
  min-height: 2.6rem;
}
.scan-dialog-body > button.secondary {
  background: var(--bg-input);
  border-color: var(--border-strong);
  color: var(--text-strong);
}
.scan-dialog-body > button.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.scan-dialog-body > button.ghost:hover {
  background: var(--bg-input);
  border-color: var(--border);
  color: var(--text);
}

.scan-dialog-zeilen {
  display: flex;
  gap: 0.5rem;
}
.scan-dialog-zeilen button {
  flex: 1 1 0;
  justify-content: center;
}

.scan-dialog-fehler {
  margin: 0;
  color: var(--danger);
  font-size: 0.85rem;
}

.scan-dialog-warnung {
  margin: 0;
  color: var(--warning);
  font-size: 0.85rem;
}
</style>
