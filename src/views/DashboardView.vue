<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'
import { useBuchungStore } from '../stores/buchung'
import { useStandortStore } from '../stores/standort'

const { t } = useI18n()
const artikelStore = useArtikelStore()
const buchungStore = useBuchungStore()
const standortStore = useStandortStore()

const artikelAnzahl = computed(() => artikelStore.gefiltert.length)
const standortAnzahl = computed(() => standortStore.aktive.length)
const buchungsAnzahl = computed(() => buchungStore.buchungen.length)

const leer = computed(
  () => artikelAnzahl.value === 0 && standortAnzahl.value === 0 && buchungsAnzahl.value === 0,
)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.dashboard.h1') }}</h1>
    </header>

    <p v-if="leer" class="empty-state">{{ t('view.dashboard.leer') }}</p>

    <div v-else class="card-grid">
      <RouterLink to="/artikel" class="card stat-card">
        <strong>{{ artikelAnzahl }}</strong>
        <span>{{ t('app.nav.artikel') }}</span>
      </RouterLink>
      <RouterLink to="/standorte" class="card stat-card">
        <strong>{{ standortAnzahl }}</strong>
        <span>{{ t('app.nav.standorte') }}</span>
      </RouterLink>
      <RouterLink to="/buchungen" class="card stat-card">
        <strong>{{ buchungsAnzahl }}</strong>
        <span>{{ t('app.nav.buchungen') }}</span>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  text-decoration: none;
  color: var(--text-strong);
  transition:
    transform 0.15s,
    border-color 0.15s;
}

.stat-card:hover {
  text-decoration: none;
  border-color: var(--accent-border);
  transform: translateY(-1px);
}

.stat-card strong {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 1;
  color: var(--accent);
}

.stat-card span {
  font-size: 0.85rem;
  color: var(--text-muted);
  font-weight: 500;
}
</style>
