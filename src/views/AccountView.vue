<script setup lang="ts">
// Account page: personal, per-user settings only (display name read-only,
// language, theme, sign-out). Everything else lives on dedicated pages
// reachable from the settings menu.
//
// Language and theme apply immediately (no "Save" button): the write lands in
// the local IndexedDB first, the settings store refreshes via liveQuery and
// the watchers in main.ts / App.vue switch locale and `data-theme` right away.

import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import InfoHint from '../components/InfoHint.vue'

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()
const auth = useAuthStore()

function abmelden(): void {
  auth.abmelden()
  void router.push('/login')
}

/**
 * Apply the language immediately — without the "Save" button.
 */
async function spracheAendern(e: Event): Promise<void> {
  const ziel = (e.target as HTMLSelectElement).value
  if (ziel !== 'de' && ziel !== 'en') return
  if (ziel === settings.settings.sprache) return
  await settings.setSprache(ziel)
}

/**
 * Apply the theme immediately — same pattern as the language.
 */
async function themeAendern(e: Event): Promise<void> {
  const ziel = (e.target as HTMLSelectElement).value
  if (ziel !== 'dark' && ziel !== 'light' && ziel !== 'auto') return
  if (ziel === settings.settings.theme) return
  await settings.setTheme(ziel)
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.account.h1') }}</h1>
      <InfoHint :text="t('view.account.be')" />
    </header>

    <div class="card quick-links">
      <div class="readonly">
        <span class="label">{{ t('view.settings.benutzer') }}</span>
        <span class="value">{{ auth.anzeigename || '—' }}</span>
      </div>
      <label class="account-setting">
        <span class="label">{{ t('view.settings.sprache') }}</span>
        <select
          :value="settings.settings.sprache"
          :aria-label="t('view.settings.sprache')"
          @change="spracheAendern"
        >
          <option value="de">{{ t('view.settings.sprachen.de') }}</option>
          <option value="en">{{ t('view.settings.sprachen.en') }}</option>
        </select>
        <small class="hint">{{ t('view.settings.spracheHint') }}</small>
      </label>
      <label class="account-setting">
        <span class="label">{{ t('view.settings.theme') }}</span>
        <select
          :value="settings.settings.theme"
          :aria-label="t('view.settings.theme')"
          @change="themeAendern"
        >
          <option value="dark">{{ t('view.settings.themes.dark') }}</option>
          <option value="light">{{ t('view.settings.themes.light') }}</option>
          <option value="auto">{{ t('view.settings.themes.auto') }}</option>
        </select>
        <small class="hint">{{ t('view.settings.themeHint') }}</small>
      </label>
      <RouterLink to="/einstellungen" class="btn desktop-only">
        {{ t('view.settings.h1') }}
      </RouterLink>
      <button type="button" class="danger" @click="abmelden">
        {{ t('view.settings.abmelden') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.quick-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.readonly {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.readonly .label {
  font-size: 0.85em;
  color: var(--text-muted, #666);
}
.readonly .value {
  font-weight: 500;
}
.account-setting {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.account-setting .label {
  font-size: 0.85em;
  color: var(--text-muted, #666);
}
.account-setting select {
  width: max-content;
  min-width: 12rem;
}
</style>
