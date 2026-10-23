<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

export interface LetzteBuchungEintrag {
  id: string
  artikelId: string
  artikelTitel: string
  typLabel: string
  mengeText: string
  standortName: string
  zeitText: string
  erstelltVon: string
  storno: boolean
}

defineProps<{ eintraege: LetzteBuchungEintrag[] }>()

const { t } = useI18n()
</script>

<template>
  <p v-if="eintraege.length === 0" class="empty-state small">
    {{ t('view.dashboard.letzteBuchungen.leer') }}
  </p>
  <ul v-else class="buchung-liste">
    <li v-for="eintrag in eintraege" :key="eintrag.id" :class="{ storno: eintrag.storno }">
      <RouterLink :to="`/artikel/${eintrag.artikelId}`" class="buchung-link">
        <span class="buchung-kopf">
          <span class="buchung-titel">{{ eintrag.artikelTitel }}</span>
          <span class="buchung-menge">{{ eintrag.mengeText }}</span>
        </span>
        <span class="buchung-meta">
          {{ eintrag.typLabel }} · {{ eintrag.standortName }} · {{ eintrag.erstelltVon }} ·
          {{ eintrag.zeitText }}
        </span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
.buchung-liste {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.buchung-liste li {
  border-bottom: 1px solid var(--border);
}

.buchung-liste li:last-child {
  border-bottom: none;
}

.buchung-liste li.storno {
  opacity: 0.6;
}

.buchung-link {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.5rem 0.15rem;
  text-decoration: none;
}

.buchung-kopf {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
}

.buchung-titel {
  color: var(--text-strong);
  font-weight: 600;
  font-size: 0.86rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.buchung-link:hover .buchung-titel {
  color: var(--accent);
}

.buchung-menge {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text-strong);
  white-space: nowrap;
}

.buchung-meta {
  color: var(--text-muted);
  font-size: 0.76rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-state.small {
  margin: 0;
  padding: 1.5rem 0;
  font-size: 0.85rem;
}
</style>
