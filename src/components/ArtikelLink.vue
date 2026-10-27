<script setup lang="ts">
// Renders an article title as a link to the article detail view. Falls back to
// plain text when the article cannot be resolved (e.g. deleted meanwhile), so
// lists never show broken links.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'

const props = withDefaults(
  defineProps<{
    artikelId: string
    /** Overrides the title resolved from the store (lists often already have it). */
    titel?: string
    /** Shown when no article matches `artikelId`. */
    fallback?: string
  }>(),
  { titel: undefined, fallback: '—' },
)

const artikelStore = useArtikelStore()

const artikel = computed(() => artikelStore.byId(props.artikelId))
const anzeige = computed(() => props.titel ?? artikel.value?.titel ?? props.fallback)
</script>

<template>
  <RouterLink v-if="artikel" :to="`/artikel/${artikel.id}`" class="artikel-link">
    {{ anzeige }}
  </RouterLink>
  <span v-else>{{ anzeige }}</span>
</template>

<style scoped>
/* `color: inherit` keeps cell-level colouring (e.g. muted storno rows) intact
   while the underline still marks the text as clickable. The underline hover
   rule is pointer-only to avoid stuck hover states on touch devices. */
.artikel-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
  text-underline-offset: 2px;
}
@media (hover: hover) {
  .artikel-link:hover {
    text-decoration-color: currentColor;
  }
}
</style>
