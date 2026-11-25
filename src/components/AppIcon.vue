<script setup lang="ts">
// AppIcon: renders a named icon from the central `ICONS` map as an inline
// Feather/Lucide-style SVG (24x24, stroke=currentColor). Every menu consumes
// this component so icons stay consistent across top-nav, bottom-nav and
// settings. Unknown names render an empty placeholder to keep the layout.

import { ICONS } from '../domain/icons'

defineProps<{
  name: string
}>()
</script>

<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="app-icon"
  >
    <!-- eslint-disable-next-line vue/no-v-html -->
    <g v-html="ICONS[name] ?? ''" />
  </svg>
</template>

<style scoped>
.app-icon {
  width: 1.15em;
  height: 1.15em;
  vertical-align: -0.2em;
  flex: none;
  margin-right: 0.45rem;
}
</style>
