<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { HandlungsbedarfEintrag } from '../../../domain/statistik'

defineProps<{ eintraege: HandlungsbedarfEintrag[] }>()

const { t } = useI18n()
</script>

<template>
  <p v-if="eintraege.length === 0" class="empty-state small">
    {{ t('view.dashboard.handlungsbedarf.leer') }}
  </p>
  <ul v-else class="bedarf-liste">
    <li v-for="eintrag in eintraege" :key="`${eintrag.artikelId}-${eintrag.standortId}`">
      <RouterLink :to="`/artikel/${eintrag.artikelId}`" class="bedarf-link">
        <span class="bedarf-titel">{{ eintrag.artikelTitel }}</span>
        <span class="bedarf-meta">{{ eintrag.standortName }}</span>
        <span class="bedarf-werte">
          {{ t('view.dashboard.handlungsbedarf.bestand', { bestand: eintrag.bestand }) }}
          <template v-if="eintrag.mindestbestand !== null">
            · {{ t('view.dashboard.handlungsbedarf.minimum', { minimum: eintrag.mindestbestand }) }}
          </template>
        </span>
      </RouterLink>
      <span class="bedarf-defizit">
        {{ t('view.dashboard.handlungsbedarf.defizit', { defizit: eintrag.defizit }) }}
      </span>
    </li>
  </ul>
</template>

<style scoped>
.bedarf-liste {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.bedarf-liste li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
}

.bedarf-link {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
  text-decoration: none;
}

.bedarf-titel {
  color: var(--text-strong);
  font-weight: 600;
  font-size: 0.9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bedarf-link:hover .bedarf-titel {
  color: var(--accent);
}

.bedarf-meta,
.bedarf-werte {
  color: var(--text-muted);
  font-size: 0.78rem;
}

.bedarf-defizit {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--danger, #dc2626);
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.25);
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
}

.empty-state.small {
  margin: 0;
  padding: 1.5rem 0;
  font-size: 0.85rem;
}
</style>
