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

import { computed, nextTick, ref, watch } from 'vue'
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
  normalisiereKommission,
  type AuftragsArt,
  type ScanErgebnis,
  type ScanKandidat,
} from '../domain/kommission-scan'
import KommissionKameraScan from '../components/KommissionKameraScan.vue'

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

// --- Searchable dropdown (live filter while typing) ---

const offen = ref(false)
const suche = ref('')
const highlightIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listeEl = ref<HTMLUListElement | null>(null)
const wurzelEl = ref<HTMLElement | null>(null)

const gewaehlt = computed<string | null>(() => props.modelValue.trim() || null)

const treffer = computed<string[]>(() => {
  const q = normalisiereKommission(suche.value)
  if (!q) return auswahlOptionen.value
  return auswahlOptionen.value.filter((name) => normalisiereKommission(name).includes(q))
})

/**
 * First entry clears the selection, then the live-filtered commissions.
 * Keeping the clear entry in the same list preserves the old "" option.
 */
const eintraege = computed<Array<{ wert: string; text: string }>>(() => [
  { wert: '', text: t('view.kommission.keineAuswahl') },
  ...treffer.value.map((name) => ({ wert: name, text: name })),
])

function oeffnen(): void {
  if (props.disabled) return
  offen.value = true
  suche.value = ''
  highlightIndex.value = Math.max(
    0,
    eintraege.value.findIndex((e) => e.wert === props.modelValue),
  )
  void nextTick(() => inputEl.value?.focus())
}

function schliessen(): void {
  offen.value = false
  suche.value = ''
}

function auswaehlen(name: string): void {
  emit('update:modelValue', name)
  schliessen()
}

function leeren(): void {
  emit('update:modelValue', '')
  oeffnen()
}

watch(
  () => props.modelValue,
  () => {
    if (!offen.value) suche.value = ''
  },
)

function onInput(e: Event): void {
  suche.value = (e.target as HTMLInputElement).value
  offen.value = true
  highlightIndex.value = 0
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!offen.value) oeffnen()
    highlightIndex.value = Math.min(highlightIndex.value + 1, eintraege.value.length - 1)
    scrollHighlightIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!offen.value) oeffnen()
    highlightIndex.value = Math.max(highlightIndex.value - 1, 0)
    scrollHighlightIntoView()
  } else if (e.key === 'Enter') {
    if (!offen.value) {
      oeffnen()
      return
    }
    const eintrag = eintraege.value[highlightIndex.value]
    if (eintrag) {
      e.preventDefault()
      auswaehlen(eintrag.wert)
    }
  } else if (e.key === 'Escape') {
    if (offen.value) {
      e.preventDefault()
      schliessen()
    }
  } else if (e.key === 'Backspace' && !suche.value && gewaehlt.value) {
    e.preventDefault()
    leeren()
  }
}

function scrollHighlightIntoView(): void {
  void nextTick(() => {
    const el = listeEl.value?.children.item(highlightIndex.value) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function onBlur(e: FocusEvent): void {
  // A click on a list entry fires before blur, so check relatedTarget.
  const next = e.relatedTarget as Node | null
  if (next && wurzelEl.value?.contains(next)) return
  schliessen()
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
    <div ref="wurzelEl" class="kommission-suche" :class="{ offen, disabled }">
      <button
        v-if="gewaehlt && !offen"
        :id="id"
        type="button"
        class="auswahl-tag"
        :disabled="disabled"
        aria-haspopup="listbox"
        :aria-expanded="offen"
        @click="oeffnen"
      >
        <span class="auswahl-titel">{{ gewaehlt }}</span>
        <span
          v-if="!disabled"
          class="auswahl-clear"
          role="button"
          tabindex="0"
          :aria-label="t('view.kommission.auswahlAufheben')"
          @click.stop="leeren"
          @keydown.enter.stop="leeren"
          @keydown.space.stop.prevent="leeren"
          >×</span
        >
      </button>
      <input
        v-else
        :id="id"
        ref="inputEl"
        type="search"
        autocomplete="off"
        :value="suche"
        :placeholder="t('view.kommission.suchePlatzhalter')"
        :disabled="disabled"
        :aria-required="required || undefined"
        aria-autocomplete="list"
        :aria-expanded="offen"
        role="combobox"
        @input="onInput"
        @focus="oeffnen"
        @blur="onBlur"
        @keydown="onKeydown"
      />

      <ul
        v-if="offen"
        ref="listeEl"
        class="treffer-liste"
        role="listbox"
        :aria-label="t('view.kommission.suchePlatzhalter')"
      >
        <li
          v-for="(eintrag, idx) in eintraege"
          :key="eintrag.wert || '__leer__'"
          role="option"
          :aria-selected="idx === highlightIndex"
          :class="{
            aktiv: idx === highlightIndex,
            gewaehlt: eintrag.wert === modelValue,
            'leer-option': eintrag.wert === '',
          }"
          @mousedown.prevent="auswaehlen(eintrag.wert)"
          @mouseenter="highlightIndex = idx"
        >
          {{ eintrag.text }}
        </li>
        <li v-if="suche.trim() !== '' && treffer.length === 0" class="kein-treffer">
          {{ t('view.kommission.keinTreffer') }}
        </li>
      </ul>
    </div>

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

    <details v-if="allowCreate" class="kommission-kamera">
      <summary>{{ t('view.kommission.kameraScan.titel') }}</summary>
      <KommissionKameraScan
        :model-value="modelValue"
        :disabled="disabled"
        @update:model-value="emit('update:modelValue', $event)"
      />
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

.kommission-suche {
  position: relative;
}

.kommission-suche.disabled {
  opacity: 0.6;
  pointer-events: none;
}

.kommission-suche input[type='search'],
.auswahl-tag {
  width: 100%;
  font: inherit;
  color: inherit;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.55rem 0.7rem;
  text-align: left;
}

.kommission-suche input[type='search']:focus,
.auswahl-tag:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}

.auswahl-tag {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.auswahl-titel {
  flex: 1 1 auto;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auswahl-clear {
  flex: 0 0 auto;
  width: 1.4rem;
  height: 1.4rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
}

.auswahl-clear:hover,
.auswahl-clear:focus-visible {
  background: var(--accent-bg);
  color: var(--text);
  outline: none;
}

.treffer-liste {
  position: absolute;
  z-index: 30;
  top: calc(100% + 0.25rem);
  left: 0;
  right: 0;
  max-height: 18rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem 0;
  list-style: none;
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.treffer-liste li {
  padding: 0.45rem 0.7rem;
  cursor: pointer;
  font-size: 0.95rem;
}

.treffer-liste li.aktiv {
  background: var(--accent-bg);
}

.treffer-liste li.gewaehlt {
  font-weight: 600;
}

.treffer-liste li.leer-option {
  color: var(--text-muted);
}

.treffer-liste li.kein-treffer {
  cursor: default;
  color: var(--text-muted);
  font-style: italic;
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

.kommission-kamera {
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  margin-top: 0.2rem;
}

.kommission-kamera summary {
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
