<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useToastStore } from '../stores/toast'

const { t } = useI18n()
const toast = useToastStore()

const icons: Record<string, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '!',
  error: '×',
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <div
        v-for="eintrag in toast.toasts"
        :key="eintrag.id"
        class="toast"
        :class="`toast-${eintrag.status}`"
        :role="eintrag.status === 'error' ? 'alert' : 'status'"
      >
        <span class="toast-icon" aria-hidden="true">{{ icons[eintrag.status] }}</span>
        <span class="toast-text">{{ eintrag.text }}</span>
        <button
          type="button"
          class="toast-close"
          :aria-label="t('app.toast.schliessen')"
          @click="toast.dismiss(eintrag.id)"
        >
          ×
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  left: 50%;
  bottom: calc(var(--bottom-nav-h, 0px) + 1rem);
  transform: translateX(-50%);
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: min(92vw, 32rem);
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.7rem 0.9rem;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-left-width: 4px;
  border-radius: var(--radius);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
  color: var(--text-strong);
  font-size: 0.95rem;
}

.toast-info {
  border-left-color: var(--accent);
}
.toast-success {
  border-left-color: var(--success);
}
.toast-warning {
  border-left-color: var(--warning);
}
.toast-error {
  border-left-color: var(--danger);
}

.toast-icon {
  display: grid;
  place-items: center;
  flex: 0 0 1.4rem;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 50%;
  font-weight: 700;
  line-height: 1;
  background: var(--bg-input);
}

.toast-success .toast-icon {
  color: var(--success);
}
.toast-warning .toast-icon {
  color: var(--warning);
}
.toast-error .toast-icon {
  color: var(--danger);
}
.toast-info .toast-icon {
  color: var(--accent);
}

.toast-text {
  flex: 1 1 auto;
  min-width: 0;
}

.toast-close {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.15rem;
  line-height: 1;
  padding: 0.1rem 0.2rem;
  cursor: pointer;
}
.toast-close:hover {
  color: var(--text-strong);
}
</style>
