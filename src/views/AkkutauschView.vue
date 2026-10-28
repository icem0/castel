<script setup lang="ts">
// Akkutausch-Tool: Austauschplanung fuer Akkus.
//
// Drei Reiter:
//   - Planung:     Bedarf je Akku-Groesse fuer ein Quartal + Bestellliste
//   - Netzteile:   eingebaute Geraete, deren Akku in einem Intervall getauscht wird
//   - Projektakkus: Projektbatterien je Quartal
//
// Die Akku-Groessen selbst pflegt der Admin unter
// Einstellungen -> Akku-Groessen (dort auch der Mindestbestand am
// Hauptlager, der als Reserve in die Planung eingeht).

import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../stores/akkutausch'
import { useArtikelStore } from '../stores/artikel'
import PlanungTab from './akkutausch/PlanungTab.vue'
import NetzteileTab from './akkutausch/NetzteileTab.vue'
import ProjektakkusTab from './akkutausch/ProjektakkusTab.vue'

type Tab = 'planung' | 'netzteile' | 'projektakkus'

const { t } = useI18n()
const store = useAkkutauschStore()
const artikelStore = useArtikelStore()

const tab = ref<Tab>('planung')
const netzteilBearbeitenId = ref<string | null>(null)

function netzteilOeffnen(netzteilId: string): void {
  netzteilBearbeitenId.value = netzteilId
  tab.value = 'netzteile'
}

function netzteilBearbeitenUebernommen(): void {
  netzteilBearbeitenId.value = null
}

onMounted(() => {
  store.start()
  artikelStore.start()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.akkutausch.h1') }}</h1>
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab"
          :class="{ aktiv: tab === 'planung' }"
          role="tab"
          :aria-selected="tab === 'planung'"
          @click="tab = 'planung'"
        >
          {{ t('view.akkutausch.tabPlanung') }}
        </button>
        <button
          type="button"
          class="tab"
          :class="{ aktiv: tab === 'netzteile' }"
          role="tab"
          :aria-selected="tab === 'netzteile'"
          @click="tab = 'netzteile'"
        >
          {{ t('view.akkutausch.tabNetzteile') }}
        </button>
        <button
          type="button"
          class="tab"
          :class="{ aktiv: tab === 'projektakkus' }"
          role="tab"
          :aria-selected="tab === 'projektakkus'"
          @click="tab = 'projektakkus'"
        >
          {{ t('view.akkutausch.tabProjektakkus') }}
        </button>
      </div>
    </header>

    <PlanungTab v-if="tab === 'planung'" @netzteil-oeffnen="netzteilOeffnen" />
    <NetzteileTab
      v-else-if="tab === 'netzteile'"
      :bearbeiten-id="netzteilBearbeitenId"
      @bearbeiten-uebernommen="netzteilBearbeitenUebernommen"
    />
    <ProjektakkusTab v-else />
  </section>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.tab {
  border: 1px solid var(--border, #cbd5e1);
  background: var(--bg-input, #f4f4f4);
  color: var(--text, #111);
  border-radius: var(--radius-sm, 0.25rem);
  padding: 0.45rem 0.8rem;
  font-size: 0.95rem;
  cursor: pointer;
}

.tab.aktiv {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}
</style>
