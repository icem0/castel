<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

export interface BalkenEintrag {
  key: string
  label: string
  value: number
  text: string
  to?: string
}

const props = defineProps<{
  eintraege: BalkenEintrag[]
  beschreibung: string
  leerText: string
}>()

const maxWert = computed(() => {
  let max = 0
  for (const eintrag of props.eintraege) max = Math.max(max, Math.abs(eintrag.value))
  return Math.max(1, max)
})

function breite(value: number): string {
  return `${Math.max(2, (Math.abs(value) / maxWert.value) * 100)}%`
}
</script>

<template>
  <div v-if="eintraege.length === 0" class="empty-state small">{{ leerText }}</div>
  <div v-else class="balken-liste" role="img" :aria-label="beschreibung">
    <div v-for="eintrag in eintraege" :key="eintrag.key" class="balken-zeile">
      <div class="balken-kopf">
        <RouterLink v-if="eintrag.to" :to="eintrag.to" class="balken-label">
          {{ eintrag.label }}
        </RouterLink>
        <span v-else class="balken-label">{{ eintrag.label }}</span>
        <span class="balken-wert">{{ eintrag.text }}</span>
      </div>
      <div class="balken-spur">
        <div
          class="balken-fuellung"
          :class="{ negativ: eintrag.value < 0 }"
          :style="{ width: breite(eintrag.value) }"
        ></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.balken-liste {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.balken-zeile {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.balken-kopf {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.82rem;
}

.balken-label {
  color: var(--text-strong);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.balken-label:hover {
  color: var(--accent);
}

.balken-wert {
  color: var(--text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.balken-spur {
  height: 0.45rem;
  background: var(--bg-input, rgba(127, 127, 127, 0.12));
  border-radius: 999px;
  overflow: hidden;
}

.balken-fuellung {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
}

.balken-fuellung.negativ {
  background: var(--danger, #dc2626);
}

.empty-state.small {
  margin: 0;
  padding: 1.5rem 0;
  font-size: 0.85rem;
}
</style>
