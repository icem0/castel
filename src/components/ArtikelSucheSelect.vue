<script setup lang="ts">
// Combobox for picking an Artikel. Typing into the text field narrows the
// drop-down list to matching titles, suppliers and order numbers. v-model is
// the selected `Artikel.id` (string), or '' for no selection. The list of
// candidates is passed in as a prop so the parent stays in charge of
// filtering (status filters, archived items, etc.).

import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Artikel } from '../db/types'

const props = defineProps<{
  modelValue: string
  items: Artikel[]
  disabled?: boolean
  placeholder?: string
  required?: boolean
  id?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { t } = useI18n()

const offen = ref(false)
const suche = ref('')
const fokussiereSuche = ref(false)
const highlightIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const listeEl = ref<HTMLUListElement | null>(null)
const wurzelEl = ref<HTMLElement | null>(null)

const ausgewaehlterArtikel = computed<Artikel | null>(
  () => props.items.find((a) => a.id === props.modelValue) ?? null,
)

function normalisiere(s: string): string {
  return s.toLowerCase().trim()
}

const treffer = computed<Artikel[]>(() => {
  const q = normalisiere(suche.value)
  if (!q) return props.items.slice(0, 50)
  const out: Artikel[] = []
  for (const a of props.items) {
    const haystack = `${a.titel} ${a.typ} ${a.lieferant ?? ''} ${a.bestellnummer ?? ''} ${
      a.barcode ?? ''
    }`.toLowerCase()
    if (haystack.includes(q)) out.push(a)
    if (out.length >= 50) break
  }
  return out
})

function oeffnen(): void {
  if (props.disabled) return
  offen.value = true
  suche.value = ''
  highlightIndex.value = 0
  void nextTick(() => inputEl.value?.focus())
}

function schliessen(): void {
  offen.value = false
  suche.value = ''
}

function auswaehlen(a: Artikel): void {
  emit('update:modelValue', a.id)
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

function onInput(): void {
  offen.value = true
  highlightIndex.value = 0
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!offen.value) oeffnen()
    highlightIndex.value = Math.min(highlightIndex.value + 1, treffer.value.length - 1)
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
    const a = treffer.value[highlightIndex.value]
    if (a) {
      e.preventDefault()
      auswaehlen(a)
    }
  } else if (e.key === 'Escape') {
    if (offen.value) {
      e.preventDefault()
      schliessen()
    }
  } else if (e.key === 'Backspace' && !suche.value && ausgewaehlterArtikel.value) {
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
  // Click auf einen Listeneintrag löst erst hier aus, daher relatedTarget prüfen.
  const next = e.relatedTarget as Node | null
  if (next && wurzelEl.value?.contains(next)) return
  schliessen()
}

function onFocus(): void {
  fokussiereSuche.value = true
  oeffnen()
}

function trefferText(a: Artikel): string {
  const meta = [a.typ, a.bestellnummer, a.lieferant].filter(Boolean).join(' · ')
  return meta ? `${a.titel} — ${meta}` : a.titel
}
</script>

<template>
  <div ref="wurzelEl" class="artikel-suche" :class="{ offen, disabled }">
    <button
      v-if="ausgewaehlterArtikel && !offen"
      type="button"
      class="auswahl-tag"
      :disabled="disabled"
      :aria-haspopup="'listbox'"
      :aria-expanded="offen"
      @click="oeffnen"
    >
      <span class="auswahl-titel">{{ ausgewaehlterArtikel.titel }}</span>
      <span class="auswahl-meta">{{ ausgewaehlterArtikel.typ }}</span>
      <span
        v-if="!disabled"
        class="auswahl-clear"
        role="button"
        tabindex="0"
        :aria-label="t('view.buchung.form.sucheLeeren')"
        @click.stop="leeren"
        @keydown.enter.stop="leeren"
        @keydown.space.stop.prevent="leeren"
        >×</span
      >
    </button>
    <input
      v-else
      ref="inputEl"
      type="search"
      autocomplete="off"
      :value="suche"
      :placeholder="placeholder ?? t('view.buchung.form.artikelSuchen')"
      :disabled="disabled"
      :required="required"
      :aria-expanded="offen"
      :aria-controls="id ? `${id}-liste` : undefined"
      aria-autocomplete="list"
      role="combobox"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />

    <ul
      v-if="offen"
      :id="id ? `${id}-liste` : undefined"
      ref="listeEl"
      class="treffer-liste"
      role="listbox"
    >
      <li v-if="treffer.length === 0" class="kein-treffer">
        {{ t('view.buchung.form.keinTreffer') }}
      </li>
      <li
        v-for="(a, idx) in treffer"
        :key="a.id"
        role="option"
        :aria-selected="idx === highlightIndex"
        :class="{ aktiv: idx === highlightIndex, gewaehlt: a.id === modelValue }"
        @mousedown.prevent="auswaehlen(a)"
        @mouseenter="highlightIndex = idx"
      >
        {{ trefferText(a) }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.artikel-suche {
  position: relative;
}
.artikel-suche.disabled {
  opacity: 0.6;
  pointer-events: none;
}
.artikel-suche input[type='search'],
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
.artikel-suche input[type='search']:focus,
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
.auswahl-meta {
  color: var(--text-muted);
  font-size: 0.8rem;
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
.treffer-liste li.kein-treffer {
  cursor: default;
  color: var(--text-muted);
  font-style: italic;
}
</style>
