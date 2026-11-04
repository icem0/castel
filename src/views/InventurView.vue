<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const settings = useSettingsStore()
const auth = useAuthStore()

const stichtag = computed(() => settings.settings.inventurStichtag ?? null)
const vorlaufTage = computed(() => settings.settings.inventurVorlaufTage)
const darfEinstellen = computed(() => auth.hat('inventur.stichtag'))

onMounted(() => {
  if (!stichtag.value && darfEinstellen.value) {
    // Hinweis, dass noch kein Stichtag gesetzt ist
  }
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.inventur.h1') }}</h1>
      <RouterLink to="/einstellungen" class="btn desktop-only">{{
        t('view.inventur.zurueck')
      }}</RouterLink>
    </header>

    <p class="hint">{{ t('view.inventur.hint') }}</p>

    <div class="card">
      <h2>{{ t('view.inventur.einstellungen') }}</h2>
      <div class="form-grid">
        <label v-if="darfEinstellen" class="account-setting">
          <span class="label">{{ t('view.inventur.stichtag') }}</span>
          <RouterLink to="/einstellungen">{{ t('view.inventur.inEinstellungen') }}</RouterLink>
        </label>
        <label v-else class="account-setting">
          <span class="label">{{ t('view.inventur.stichtag') }}</span>
          <span class="value">{{ stichtag ?? t('view.inventur.nichtGesetzt') }}</span>
        </label>
        <label class="account-setting">
          <span class="label">{{ t('view.inventur.vorlaufTage') }}</span>
          <span class="value">{{ vorlaufTage }} {{ t('view.inventur.tage') }}</span>
        </label>
      </div>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.abschluss') }}</h2>
      <p>{{ t('view.inventur.abschlussHint') }}</p>
      <button type="button" class="btn" disabled>{{ t('view.inventur.abschliessen') }}</button>
      <small class="hint">{{ t('view.inventur.abschlussBald') }}</small>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.hilfestellung') }}</h2>
      <p>{{ t('view.inventur.hilfestellungHint') }}</p>
      <button type="button" class="btn" disabled>{{ t('view.inventur.ohneInventur') }}</button>
      <small class="hint">{{ t('view.inventur.hilfestellungBald') }}</small>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.archiv') }}</h2>
      <p>{{ t('view.inventur.archivHint') }}</p>
      <button type="button" class="btn" disabled>{{ t('view.inventur.buchungsarchiv') }}</button>
      <small class="hint">{{ t('view.inventur.archivBald') }}</small>
    </div>
  </section>
</template>

<style scoped>
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
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
.account-setting .value {
  font-weight: 500;
}
</style>
