<script setup lang="ts">
// FotoUpload: nimmt <input type=file capture="environment"/> entgegen,
// komprimiert, lädt hoch, gibt die URL als v-model weiter.

import { ref, watch } from 'vue'
import { ladeFotoHoch } from '../../services/fotos'

const props = defineProps<{
  artikelId: string
  modelValue: string[]
}>()
const emit = defineEmits<{
  'update:modelValue': [urls: string[]]
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const ladend = ref(false)
const fehler = ref<string | null>(null)
const previewUrls = ref<string[]>([])

watch(
  () => props.modelValue,
  (urls: string[]) => {
    previewUrls.value = urls ?? []
  },
  { immediate: true },
)

function trigger(): void {
  inputEl.value?.click()
}

async function onChange(e: Event): Promise<void> {
  const files = (e.target as HTMLInputElement).files
  if (!files || files.length === 0) return
  ladend.value = true
  fehler.value = null
  try {
    const neueUrls: string[] = []
    for (const f of Array.from(files)) {
      const erg = await ladeFotoHoch(props.artikelId, f, f.name)
      neueUrls.push(erg.url)
    }
    const aktuell = [...previewUrls.value, ...neueUrls]
    previewUrls.value = aktuell
    emit('update:modelValue', aktuell)
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  } finally {
    ladend.value = false
    if (inputEl.value) inputEl.value.value = ''
  }
}

function entfernen(url: string): void {
  const aktuell = previewUrls.value.filter((u: string) => u !== url)
  previewUrls.value = aktuell
  emit('update:modelValue', aktuell)
}
</script>

<template>
  <div class="foto-upload">
    <div class="vorschau">
      <div v-for="url in previewUrls" :key="url" class="thumb">
        <img :src="url" alt="" />
        <button type="button" class="remove-btn" aria-label="Entfernen" @click="entfernen(url)">
          ×
        </button>
      </div>
      <button type="button" class="add-btn" :disabled="ladend" @click="trigger">
        {{ ladend ? 'Lädt …' : '+ Foto' }}
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
  </div>
</template>

<style scoped>
.foto-upload {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
</style>
