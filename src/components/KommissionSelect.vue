<script setup lang="ts">
// Dropdown for the commission (Kommission) of a booking.
//
// Shows the commissions from the global `kommissionen` setting plus
// orphaned names that are only used in existing bookings. Every user can
// add a new commission right here — the server merges the contribution into
// the global list (union); removing entries stays exclusive to the admin.
//
// The "Sannen" block pastes order text and detects the commission number
// offline (see domain/kommission-scan.ts): it matches an existing
// commission or creates a new one named after the detected number.

import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import {
  MAX_KOMMISSION_LAENGE,
  useKommissionen,
  type KommissionFehler,
} from '../composables/useKommissionen'
import {
  erkenneKommission,
  matcheKommission,
  type AuftragsArt,
  type ScanErgebnis,
  type ScanKandidat,
} from '../domain/kommission-scan'

const props = withDefaults(
  defineProps<{
    modelValue: string
    label?: string
    disabled?: boolean
    required?: boolean
    id?: string
    /** Allow the user to create a new commission (default: true). */
    allowCreate?: boolean
  }>(),
  { allowCreate: true, label: undefined, disabled: false, required: false, id: undefined },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()
const auth = useAuthStore()
const { optionen, hinzufuegen } = useKommissionen()

const neuerName = ref('')
const fehler = ref('')
const hinweis = ref('')

/**
 * The selected value is always part of the option list — otherwise the
 * dropdown would silently show a different commission than the one that is
 * stored in the booking.
 */
const auswahlOptionen = computed<string[]>(() => {
  const liste = [...optionen.value]
  const wert = props.modelValue.trim()
  if (wert !== '' && !liste.includes(wert)) liste.push(wert)
  return liste
})

function onChange(e: Event): void {
  emit('update:modelValue', (e.target as HTMLSelectElement).value)
}

function fehlerText(grund: KommissionFehler, name: string): string {
  if (grund === 'leer') return t('view.kommissionen.fehlerLeer')
  if (grund === 'duplikat') return `"${name}" ${t('view.kommissionen.fehlerDuplikat')}`
  return t('view.kommission.fehlerZuLang', { max: MAX_KOMMISSION_LAENGE })
}

async function anlegen(): Promise<void> {
  const wert = neuerName.value.trim()
  fehler.value = ''
  hinweis.value = ''
  const grund = await hinzufuegen(wert)
  if (grund !== null) {
    fehler.value = fehlerText(grund, wert)
    return
  }
  neuerName.value = ''
  hinweis.value = t('view.kommission.angelegt')
  emit('update:modelValue', wert)
}

// --- Scan ("Sannen"): paste order text, detect the commission number. ---

const scanText = ref('')
const scanErgebnis = ref<ScanErgebnis | null>(null)
const scanIndex = ref(0)
const scanVersucht = ref(false)
const scanFehler = ref('')

const scanKandidat = computed<ScanKandidat | null>(
  () => scanErgebnis.value?.kandidaten[scanIndex.value] ?? null,
)

const scanTreffer = computed<string | null>(() =>
  scanKandidat.value ? matcheKommission(scanKandidat.value.wert, optionen.value) : null,
)

function typLabel(art: AuftragsArt): string {
  if (art === 'kommission') return t('view.kommission.scan.typKommission')
  if (art === 'serviceauftrag') return t('view.kommission.scan.typServiceauftrag')
  if (art === 'arbeitsauftrag') return t('view.kommission.scan.typArbeitsauftrag')
  return t('view.kommission.scan.typUnbekannt')
}

function erkennen(): void {
  scanFehler.value = ''
  scanVersucht.value = true
  scanErgebnis.value = erkenneKommission(scanText.value, optionen.value)
  scanIndex.value = 0
}

function scanKandidatWechseln(e: Event): void {
  scanIndex.value = Number((e.target as HTMLSelectElement).value)
}

async function scanUebernehmen(): Promise<void> {
  const kandidaat = scanKandidat.value
  if (!kandidaat) return
  scanFehler.value = ''
  const treffer = scanTreffer.value
  const name = treffer ?? kandidaat.wert
  if (!treffer) {
    const grund = await hinzufuegen(name)
    if (grund !== null) {
      scanFehler.value = fehlerText(grund, name)
      return
    }
    hinweis.value = t('view.kommission.angelegt')
  }
  emit('update:modelValue', name)
}
</script>

<template>
  <div class="kommission-feld">
    <span v-if="label" class="kommission-label">{{ label }}</span>
    <select
      :id="id"
      class="kommission-select"
      :value="modelValue"
      :disabled="disabled"
      :required="required"
      @change="onChange"
    >
      <option value="">{{ t('view.kommission.keineAuswahl') }}</option>
      <option v-for="name in auswahlOptionen" :key="name" :value="name">{{ name }}</option>
    </select>

    <details v-if="allowCreate" class="kommission-scan">
      <summary>{{ t('view.kommission.scan.titel') }}</summary>
      <textarea
        v-model="scanText"
        rows="5"
        :placeholder="t('view.kommission.scan.platzhalter')"
        :disabled="disabled"
      ></textarea>
      <div class="scan-aktionen">
        <button
          type="button"
          class="scan-erkennen"
          :disabled="disabled || scanText.trim() === ''"
          @click="erkennen"
        >
          {{ t('view.kommission.scan.erkennen') }}
        </button>
      </div>

      <template v-if="scanKandidat">
        <div v-if="(scanErgebnis?.kandidaten.length ?? 0) > 1" class="scan-kandidaten">
          <span class="kommission-label">{{ t('view.kommission.scan.kandidaten') }}</span>
          <select :value="scanIndex" @change="scanKandidatWechseln">
            <option v-for="(k, i) in scanErgebnis?.kandidaten" :key="`${k.wert}-${i}`" :value="i">
              {{ k.wert }} — {{ typLabel(k.art) }}
            </option>
          </select>
        </div>
        <p class="scan-ergebnis">
          <strong>{{ scanKandidat.wert }}</strong>
          <span class="scan-typ">{{ typLabel(scanKandidat.art) }}</span>
        </p>
        <p class="hint">
          {{
            scanTreffer
              ? t('view.kommission.scan.bestehend', { name: scanTreffer })
              : t('view.kommission.scan.neu')
          }}
        </p>
        <div class="scan-aktionen">
          <button
            type="button"
            class="primary scan-uebernehmen"
            :disabled="disabled"
            @click="scanUebernehmen"
          >
            {{ t('view.kommission.scan.uebernehmen') }}
          </button>
        </div>
      </template>
      <p v-else-if="scanVersucht" class="hint">{{ t('view.kommission.scan.nichts') }}</p>
      <p v-if="scanFehler" class="fehler" role="alert">{{ scanFehler }}</p>
    </details>

    <details v-if="allowCreate" class="kommission-neu">
      <summary>{{ t('view.kommission.neueAnlegen') }}</summary>
      <div class="row">
        <input
          v-model="neuerName"
          type="text"
          :placeholder="t('view.kommission.namePlatzhalter')"
          autocomplete="off"
          :disabled="disabled"
          @keydown.enter.prevent="anlegen"
        />
        <button type="button" class="primary" :disabled="disabled" @click="anlegen">
          {{ t('view.kommissionen.hinzufuegen') }}
        </button>
      </div>
      <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>
      <p v-if="hinweis" class="hint hint-ok" role="status" aria-live="polite">{{ hinweis }}</p>
    </details>

    <small v-if="auth.istAdmin" class="hint">
      <RouterLink to="/einstellungen/kommissionen">{{ t('view.kommission.verwalten') }}</RouterLink>
    </small>
  </div>
</template>

<style scoped>
.kommission-feld {
  display: grid;
  gap: 0.3rem;
}

.kommission-label {
  color: var(--text-muted);
  font-size: 0.85rem;
  font-weight: 500;
}

.kommission-neu {
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  margin-top: 0.2rem;
}

.kommission-neu summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--accent);
}

.kommission-scan {
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  margin-top: 0.2rem;
}

.kommission-scan summary {
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--accent);
}

.kommission-scan textarea {
  width: 100%;
  margin-top: 0.5rem;
  font: inherit;
  resize: vertical;
}

.scan-aktionen {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}

.scan-kandidaten {
  display: grid;
  gap: 0.25rem;
  margin-top: 0.5rem;
}

.scan-ergebnis {
  margin: 0.5rem 0 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.scan-typ {
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 0.05rem 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.kommission-scan .fehler,
.kommission-scan .hint {
  margin: 0.25rem 0 0;
}

.kommission-neu .row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.4rem;
  align-items: end;
  margin: 0.5rem 0;
}

.kommission-neu .fehler,
.kommission-neu .hint {
  margin: 0.25rem 0 0;
}

@media (max-width: 540px) {
  .kommission-neu .row {
    grid-template-columns: 1fr;
  }
}
</style>
