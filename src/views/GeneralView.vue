<script setup lang="ts">
// Global settings (formerly the inline form at the top of the settings hub):
// standard location, company name, barcode format and the Akkutausch tool
// toggle. All of these are global, admin-only settings (`globalEinstellung`),
// so the route itself is gated accordingly.

import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useStandortStore } from '../stores/standort'
import InfoHint from '../components/InfoHint.vue'
import type { BarcodeTyp } from '../stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()
const standort = useStandortStore()

const standardId = ref<string>(settings.settings.standardStandortId ?? '')
const firmaName = ref<string>(settings.settings.companyName ?? '')
const firmaNameVomUser = ref(false)
const barcodeTyp = ref<BarcodeTyp>(settings.settings.barcodeTyp)
const barcodeTypVomUser = ref(false)

const barcodeFormate = [
  { wert: 'CODE128' as BarcodeTyp, label: t('view.barcode.formatCode128') },
  { wert: 'EAN13' as BarcodeTyp, label: t('view.barcode.formatEAN13') },
  { wert: 'CODE39' as BarcodeTyp, label: t('view.barcode.formatCode39') },
]

watch(
  () => settings.settings,
  (s) => {
    standardId.value = s.standardStandortId ?? ''
    if (!firmaNameVomUser.value) {
      firmaName.value = s.companyName ?? ''
    }
    if (!barcodeTypVomUser.value) {
      barcodeTyp.value = s.barcodeTyp
    }
  },
)

const standorte = computed(() => standort.aktive)
const statusmeldung = ref('')
const laufend = ref(false)
let statusTimer: ReturnType<typeof setTimeout> | null = null

async function speichern(): Promise<void> {
  if (laufend.value) return
  laufend.value = true
  try {
    await settings.setStandardStandort(standardId.value || null)
    await settings.setKey('companyName', firmaName.value)
    await settings.setBarcodeTyp(barcodeTyp.value)
    barcodeTypVomUser.value = false
    statusmeldung.value = t('view.settings.gespeichert')
    if (statusTimer !== null) clearTimeout(statusTimer)
    statusTimer = setTimeout(() => {
      statusmeldung.value = ''
      statusTimer = null
    }, 1500)
  } finally {
    laufend.value = false
  }
}

/**
 * Enables/disables the Akkutausch tool for everyone. The store write is
 * local-first; the sync worker pushes the global (admin-only) setting.
 */
async function akkutauschAendern(e: Event): Promise<void> {
  const aktiv = (e.target as HTMLInputElement).checked
  if (aktiv === settings.settings.akkutauschAktiv) return
  await settings.setAkkutauschAktiv(aktiv)
}

onBeforeUnmount(() => {
  if (statusTimer !== null) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.general.h1') }}</h1>
      <InfoHint :text="t('view.general.be')" />
    </header>

    <div class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <label>
          <span>{{ t('view.settings.standardStandort') }}</span>
          <select v-model="standardId" :disabled="laufend">
            <option value="">— {{ t('view.settings.nichtGelegt') }} —</option>
            <option v-for="s in standorte" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.settings.companyName') }}</span>
          <input
            v-model="firmaName"
            type="text"
            :disabled="laufend"
            :placeholder="t('view.settings.companyNameHint')"
            @input="firmaNameVomUser = true"
          />
        </label>
        <label>
          <span>{{ t('view.settings.barcodeTyp') }}</span>
          <select v-model="barcodeTyp" :disabled="laufend" @input="barcodeTypVomUser = true">
            <option v-for="f in barcodeFormate" :key="f.wert" :value="f.wert">
              {{ f.label }}
            </option>
          </select>
          <small class="hint">{{ t('view.settings.barcodeTypHint') }}</small>
        </label>

        <div class="form-actions">
          <button type="submit" class="primary" :disabled="laufend">
            {{ laufend ? '…' : t('view.settings.speichern') }}
          </button>
          <span v-if="statusmeldung" class="hint hint-ok" role="status" aria-live="polite">{{
            statusmeldung
          }}</span>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="akkutausch-toggle">
        <label class="account-setting">
          <span class="label">{{ t('view.settings.akkutauschAktiv') }}</span>
          <input
            type="checkbox"
            :checked="settings.settings.akkutauschAktiv"
            @change="akkutauschAendern"
          />
          <small class="hint">{{ t('view.settings.akkutauschAktivHint') }}</small>
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
.akkutausch-toggle {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
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
</style>
