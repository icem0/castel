<script setup lang="ts">
// Dropdown for the commission (Kommission) of a booking.
//
// Shows the commissions from the global `kommissionen` setting plus
// orphaned names that are only used in existing bookings. Every user can
// add a new commission right here — the server merges the contribution into
// the global list (union); removing entries stays exclusive to the admin.

import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import {
  MAX_KOMMISSION_LAENGE,
  useKommissionen,
  type KommissionFehler,
} from '../composables/useKommissionen'

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
