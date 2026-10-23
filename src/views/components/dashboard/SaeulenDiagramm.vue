<script setup lang="ts">
import { computed } from 'vue'

export interface SaeulenSerie {
  key: string
  label: string
  color: string
  values: number[]
}

const props = defineProps<{
  labels: string[]
  series: SaeulenSerie[]
  beschreibung: string
  leerText: string
}>()

const maxWert = computed(() => {
  let max = 0
  for (const serie of props.series) {
    for (const value of serie.values) max = Math.max(max, value)
  }
  return Math.max(1, max)
})

const gesamt = computed(() =>
  props.series.reduce((sum, serie) => sum + serie.values.reduce((a, b) => a + b, 0), 0),
)

const labelSchritt = computed(() =>
  props.labels.length > 14 ? Math.ceil(props.labels.length / 8) : 1,
)

function hoehe(value: number): string {
  if (value <= 0) return '0%'
  return `${Math.max(2, (value / maxWert.value) * 100)}%`
}

function labelSichtbar(index: number): boolean {
  return index % labelSchritt.value === 0 || index === props.labels.length - 1
}
</script>

<template>
  <div class="saeulen">
    <div class="legende">
      <span v-for="serie in series" :key="serie.key" class="legende-eintrag">
        <span class="farbe" :style="{ background: serie.color }" aria-hidden="true"></span>
        {{ serie.label }}
      </span>
    </div>

    <p v-if="gesamt === 0" class="empty-state small">{{ leerText }}</p>
    <div v-else class="chart" role="img" :aria-label="beschreibung">
      <div v-for="(label, index) in labels" :key="index" class="gruppe">
        <div class="balken-wrap">
          <div
            v-for="serie in series"
            :key="serie.key"
            class="balken"
            :style="{ height: hoehe(serie.values[index] ?? 0), background: serie.color }"
            :title="`${label} · ${serie.label}: ${serie.values[index] ?? 0}`"
          ></div>
        </div>
        <span class="achse">
          <template v-if="labelSichtbar(index)">{{ label }}</template>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.saeulen {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.legende {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.legende-eintrag {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.farbe {
  width: 0.65rem;
  height: 0.65rem;
  border-radius: 2px;
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 0.2rem;
  min-height: 11rem;
  padding-top: 0.5rem;
  overflow: hidden;
}

.gruppe {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.25rem;
}

.balken-wrap {
  height: 9rem;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
}

.balken {
  flex: 1 1 0;
  min-width: 1px;
  max-width: 14px;
  border-radius: 3px 3px 0 0;
  transition: height 0.2s ease;
}

.achse {
  min-height: 1rem;
  font-size: 0.68rem;
  color: var(--text-muted);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
}

.empty-state.small {
  margin: 0;
  padding: 1.5rem 0;
  font-size: 0.85rem;
}
</style>
