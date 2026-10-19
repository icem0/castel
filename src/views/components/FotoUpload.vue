<script setup lang="ts">
// FotoUpload: lädt Bilder zum Server und zeigt die Liste der Server-Fotos
// an. Fotos leben nur auf dem Server (`fotos`-Tabelle ist Source-of-Truth);
// die PWA lädt die Liste bei Mount frisch und nach jedem Upload/Delete neu.
//
// Offline-Verhalten: ist der Sync-Worker im Status "offline", wird die
// Sektion komplett ausgeblendet — damit der User keine kaputten Bild-Links
// sieht, wenn der Server nicht erreichbar ist.
//
// Lightbox: Klick aufs Thumbnail → Bild groß, Klick auf den Backdrop oder
// ESC → zu. Funktioniert auch auf Mobile (Touch via Vue @click).

import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import {
  ladeFotoHoch,
  ladeFotoListe,
  loescheFoto,
  type FotoListEintrag,
} from '../../services/fotos'
import { useSyncStore } from '../../stores/sync'

const props = defineProps<{
  artikelId: string
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const liste = ref<FotoListEintrag[]>([])
const initialLaden = ref(true)
const uploadLaden = ref(false)
const loeschenId = ref<string | null>(null)
const fehler = ref<string | null>(null)

const sync = useSyncStore()
const offline = computed(() => sync.status.status === 'offline')

async function ladeListe(): Promise<void> {
  if (offline.value) return
  try {
    liste.value = await ladeFotoListe(props.artikelId)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    initialLaden.value = false
  }
}

onMounted(() => {
  void ladeListe()
})

function trigger(): void {
  inputEl.value?.click()
}

async function onChange(e: Event): Promise<void> {
  const files = (e.target as HTMLInputElement).files
  if (!files || files.length === 0) return
  uploadLaden.value = true
  fehler.value = null
  try {
    for (const f of Array.from(files)) {
      await ladeFotoHoch(props.artikelId, f, f.name)
    }
    await ladeListe()
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  } finally {
    uploadLaden.value = false
    if (inputEl.value) inputEl.value.value = ''
  }
}

async function entfernen(id: string): Promise<void> {
  loeschenId.value = id
  fehler.value = null
  try {
    await loescheFoto(id)
    await ladeListe()
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  } finally {
    loeschenId.value = null
  }
}

// Lightbox
const lightboxUrl = ref<string | null>(null)
const lightboxTitel = ref<string>('')

function openLightbox(url: string): void {
  lightboxUrl.value = url
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
</script>

<template>
  <section v-if="!offline" class="foto-upload">
    <h2>Fotos</h2>
    <div v-if="initialLaden" class="muted">Lade…</div>
    <div v-else class="vorschau">
      <div v-for="f in liste" :key="f.id" class="thumb">
        <button
          type="button"
          class="thumb-btn"
          :aria-label="`Foto vergroessern`"
          @click="openLightbox(f.url)"
        >
          <img :src="f.url" alt="" />
        </button>
        <button
          type="button"
          class="remove-btn"
          aria-label="Entfernen"
          :disabled="loeschenId === f.id"
          @click="entfernen(f.id)"
        >
          ×
        </button>
      </div>
      <button type="button" class="add-btn" :disabled="uploadLaden" @click="trigger">
        {{ uploadLaden ? 'Lädt …' : '+ Foto' }}
      </button>
    </div>
    <input
      ref="inputEl"
      type="file"
      accept="image/*"
      capture="environment"
      multiple
      hidden
      @change="onChange"
    />
    <p v-if="fehler" class="fehler">{{ fehler }}</p>
    <p class="hint">Foto per Kamera oder Datei-Auswahl hinzufügen.</p>

    <div
      v-if="lightboxUrl !== null"
      class="lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      @click="closeLightbox"
    >
      <img :src="lightboxUrl" alt="" class="lightbox-img" @click.stop />
    </div>
  </section>
</template>

<style scoped>
.foto-upload {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.vorschau {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.thumb {
  position: relative;
  width: 6rem;
  height: 6rem;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-input);
}

.thumb-btn {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: zoom-in;
  display: block;
  width: 100%;
  height: 100%;
  line-height: 0;
  -webkit-tap-highlight-color: transparent;
}
.thumb-btn img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-btn:hover img,
.thumb-btn:focus-visible img {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.remove-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border: none;
  border-radius: 50%;
  width: 1.5rem;
  height: 1.5rem;
  font-size: 1rem;
  cursor: pointer;
  line-height: 1;
  -webkit-tap-highlight-color: transparent;
}

.add-btn {
  width: 6rem;
  height: 6rem;
  border: 2px dashed var(--border);
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.add-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}

.fehler {
  color: var(--danger);
  font-size: 0.85rem;
  margin: 0;
}

.hint {
  color: var(--text-muted);
  font-size: 0.8rem;
  margin: 0;
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
  /* iOS-Safari: full-height fixed element trotz URL-Bar */
  height: 100vh;
  height: 100dvh;
}

.lightbox-img {
  max-width: 95vw;
  max-height: 95vh;
  max-height: 95dvh;
  object-fit: contain;
  border-radius: var(--radius-sm);
  cursor: default;
  /* verhindert Pull-to-refresh auf Mobile, während Lightbox offen ist */
  touch-action: none;
}
</style>
