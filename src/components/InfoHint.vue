<script setup lang="ts">
// InfoHint: a small info badge ("i" in a circle) whose explanation opens as a
// tooltip.
//
// Two activation paths are intentional:
//   - Mouse-over: plain CSS `:hover` (plus `:active` and keyboard focus) shows
//     the tooltip without any state — desktop users just hover.
//   - Click/tap: a stateful toggle so touch devices (PWA on phone/tablet, no
//     hover capability) can pin the tooltip open, read it, and close it with
//     a second tap.
//
// The explanation text is resolved by the consumer (i18n `t()` at the call
// site), so this component never touches the locale files itself.

import AppIcon from './AppIcon.vue'
import { ref } from 'vue'

defineProps<{
  text: string
}>()

const open = ref(false)

function toggle(): void {
  open.value = !open.value
}
</script>

<template>
  <span class="info-hint" :class="{ offen: open }" tabindex="0" @click="toggle">
    <AppIcon name="info" class="badge" />
    <span class="info-tip">{{ text }}</span>
  </span>
</template>

<style scoped>
.info-hint {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 0.18rem;
  border-radius: 50%;
  color: var(--text-muted, #666);
  cursor: pointer;
  transition:
    color 0.15s ease-out,
    background-color 0.15s ease-out;
}
.info-hint:hover,
.info-hint:focus-visible,
.info-hint.offen {
  color: var(--accent, #6366f1);
  background: var(--accent-bg, rgba(99, 102, 241, 0.12));
}
.info-hint.badge,
.info-hint .badge {
  width: 1.15rem;
  height: 1.15rem;
}
.info-hint .badge {
  margin: 0;
}
.info-tip {
  position: absolute;
  right: 0;
  bottom: 1.9em;
  max-width: min(36rem, 94vw);
  width: auto;
  padding: 0.6rem 0.9rem;
  background: var(--bg-card, #fff);
  border: 1px solid var(--border-strong, #ccc);
  border-radius: 0.5rem;
  box-shadow: var(--shadow-pop, 0 8px 24px rgba(0, 0, 0, 0.45));
  font-size: 0.92em;
  font-weight: 400;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease-out;
  z-index: 60;
}
.info-hint:hover .info-tip,
.info-hint:active .info-tip,
.info-hint:focus-visible .info-tip,
.info-hint.offen .info-tip {
  opacity: 1;
}
</style>
