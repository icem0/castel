<script setup lang="ts">
// Barcode-Scan-View: Kamera-Scan mit Direktnavigation in die Buchungsmaske.
// Strategie:
//   - Wenn Artikel mit passendem barcode, passender bestellnummer ODER
//     passender id existiert → /buchung/neu?artikelId=...
//   - Sonst: kurzer Dialog "Neuen Artikel anlegen oder weiter scannen?"
//     Beim Anlegen wird der gescannte Code als `barcode` an die Form
//     weitergereicht (route.query.barcode), damit der Folge-Scan den
//     frisch angelegten Artikel findet.

import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'
import { useBarcode } from '../composables/useBarcode'

const router = useRouter()
const artikelStore = useArtikelStore()
onMounted(() => artikelStore.start())

const videoEl = ref<HTMLVideoElement | null>(null)
const manuelleEingabe = ref('')
const gefunden = ref<string | null>(null)

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

async function codeVerarbeiten(code: string, _format: string): Promise<void> {
  gefunden.value = code
  // Artikel suchen — Reihenfolge: barcode (primär), bestellnummer (Legacy-
  // Workaround), id (manuell eingegebene UUID). Beim Match direkt in die
  // Buchungsmaske.
  const artikel = artikelStore.artikel.find(
    (a) => a.barcode === code || a.bestellnummer === code || a.id === code,
  )
  if (artikel) {
    void router.push({ name: 'buchung-neu', query: { artikelId: artikel.id } })
    return
  }
  // Nicht gefunden — User fragen. Der gescannte Code wird als
  // route.query.barcode an die Artikel-Form durchgereicht, damit der
  // frisch angelegte Artikel beim nächsten Scan gefunden wird.
  const anlegen = confirm(`Code "${code}" nicht im Bestand. Neuen Artikel anlegen?`)
  if (anlegen) {
    void router.push({ name: 'artikel-neu', query: { barcode: code } })
  } else {
    gefunden.value = null
  }
}

function manuellScannen(): void {
  const code = manuelleEingabe.value.trim()
  if (!code) return
  void codeVerarbeiten(code, 'manual')
}

async function scannerNeustarten(): Promise<void> {
  stop()
  if (videoEl.value) await start(videoEl.value)
}

onMounted(async () => {
  await new Promise((r) => setTimeout(r, 100))
  if (videoEl.value) await start(videoEl.value)
})

onBeforeUnmount(() => stop())
</script>

<template>
  <section class="view barcode">
    <header class="view-head">
      <h1>Barcode-Scan</h1>
      <p class="hint">Halte die Kamera auf den Barcode des Artikels.</p>
    </header>

    <div
      class="scanner-area"
      :class="{ 'is-ok': gefunden, 'is-err': scannerFehler }"
      role="region"
      aria-label="Kamera-Vorschau"
      :aria-busy="!aktiv && !scannerFehler ? 'true' : undefined"
    >
      <video v-show="aktiv" ref="videoEl" class="scanner-video" playsinline muted autoplay></video>

      <!-- Reticle: zeigt dem User, wohin er den Barcode halten soll. -->
      <div v-if="aktiv" class="scanner-reticle" aria-hidden="true">
        <div class="scanner-reticle-corner tl"></div>
        <div class="scanner-reticle-corner tr"></div>
        <div class="scanner-reticle-corner bl"></div>
        <div class="scanner-reticle-corner br"></div>
        <span class="scanner-reticle-label">Barcode im Rahmen halten</span>
      </div>

      <div v-if="!aktiv && !scannerFehler" class="scanner-overlay">
        <div class="scanner-status">
          <span class="scanner-spinner" aria-hidden="true"></span>
          <p>Scanner startet …</p>
        </div>
      </div>

      <div v-if="scannerFehler" class="scanner-overlay scanner-error" role="alert">
        <div class="scanner-status">
          <p><strong>Kamera nicht verfügbar</strong></p>
          <p class="scanner-error-detail">{{ scannerFehler }}</p>
          <p class="hint">Tipp: Browser-Berechtigung erteilen oder Code unten manuell eingeben.</p>
          <button type="button" class="scanner-retry" @click="scannerNeustarten">
            Erneut versuchen
          </button>
        </div>
      </div>

      <div v-if="gefunden" class="scanner-overlay scanner-found" role="status" aria-live="polite">
        <div class="scanner-status">
          <p class="scanner-found-label">Erkannt</p>
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
        placeholder="Oder Code manuell eingeben …"
        aria-label="Code manuell eingeben"
      />
      <button type="submit" class="primary" :disabled="!manuelleEingabe.trim()">Übernehmen</button>
    </form>

    <p class="hint hint-bottom">
      Hinweis: Die Kamera-Berechtigung muss im Browser erteilt sein. Auf mobilen Geräten muss die
      App ggf. über "Zum Startbildschirm hinzufügen" installiert sein.
    </p>
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
  border-width: 0 3px 3px 0;
  border-bottom-right-radius: 0.25rem;
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
</style>
