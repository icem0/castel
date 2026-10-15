<script setup lang="ts" generic="K extends string">
import { computed } from 'vue'
import type { SortDir } from '../composables/useTableSort'

const props = defineProps<{
  label: string
  sortKey: K
  activeKey: K | null
  dir: SortDir
  align?: 'left' | 'right'
}>()

const emit = defineEmits<{
  (e: 'sort', key: K): void
}>()

const istAktiv = computed(() => props.activeKey === props.sortKey && props.dir !== 'off')

const pfeil = computed<string>(() => {
  if (!istAktiv.value) return ''
  return props.dir === 'asc' ? '\u2191' : '\u2193'
})

const ariaSort = computed<'ascending' | 'descending' | 'none'>(() => {
  if (!istAktiv.value) return 'none'
  return props.dir === 'asc' ? 'ascending' : 'descending'
})

function onKlick(): void {
  emit('sort', props.sortKey)
}
</script>

<template>
  <th
    :class="['sortable', { active: istAktiv, right: align === 'right' }]"
    :aria-sort="ariaSort"
    role="columnheader"
    tabindex="0"
    @click="onKlick"
    @keydown.enter.prevent="onKlick"
    @keydown.space.prevent="onKlick"
  >
    <span class="label">{{ label }}</span>
    <span class="arrow" aria-hidden="true">{{ pfeil }}</span>
  </th>
</template>

<style scoped>
.sortable {
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

.sortable:hover {
  background: var(--bg-input);
  color: var(--text-strong);
}

.sortable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.sortable.right {
  text-align: right;
}

.label {
  display: inline-block;
}

.sortable.right .label {
  text-align: right;
}

.arrow {
  display: inline-block;
  margin-left: 0.25rem;
  min-width: 0.9em;
  color: var(--accent);
  font-weight: 700;
}

.sortable.active {
  color: var(--text-strong);
}
</style>
