<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useStandortStore } from '../stores/standort'
import { useAuthStore } from '../stores/auth'
import MindestbestandBenachrichtigungen from './components/MindestbestandBenachrichtigungen.vue'
import type { BarcodeTyp } from '../stores/settings'

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()
const standort = useStandortStore()
const auth = useAuthStore()

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
    if (auth.istAdmin) {
      await settings.setStandardStandort(standardId.value || null)
      await settings.setKey('companyName', firmaName.value)
      await settings.setBarcodeTyp(barcodeTyp.value)
      barcodeTypVomUser.value = false
    }
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

function abmelden(): void {
  auth.abmelden()
  void router.push('/login')
}

/**
 * Apply the language immediately — without the "Save" button.
 *
 * `setSprache` writes to the local IndexedDB first; the settings store is
 * refreshed via liveQuery and `main.ts` mirrors the value into the i18n
 * locale. The whole UI therefore switches language right away — offline
 * as well. The server is not in the critical path: the setting is synced
 * asynchronously via the outbox.
 */
async function spracheAendern(e: Event): Promise<void> {
  const ziel = (e.target as HTMLSelectElement).value
  if (ziel !== 'de' && ziel !== 'en') return
  if (ziel === settings.settings.sprache) return
  await settings.setSprache(ziel)
}

/**
 * Apply the theme immediately — same pattern as the language: the local
 * IndexedDB write refreshes the store via liveQuery and the root watcher
 * in `App.vue` updates `data-theme` right away.
 */
async function themeAendern(e: Event): Promise<void> {
  const ziel = (e.target as HTMLSelectElement).value
  if (ziel !== 'dark' && ziel !== 'light' && ziel !== 'auto') return
  if (ziel === settings.settings.theme) return
  await settings.setTheme(ziel)
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
      <h1>{{ t('view.settings.h1') }}</h1>
    </header>

    <div class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <label v-if="auth.istAdmin">
          <span>{{ t('view.settings.standardStandort') }}</span>
          <select v-model="standardId" :disabled="laufend">
            <option value="">— {{ t('view.settings.nichtGelegt') }} —</option>
            <option v-for="s in standorte" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label v-if="auth.istAdmin">
          <span>{{ t('view.settings.companyName') }}</span>
          <input
            v-model="firmaName"
            type="text"
            :disabled="laufend"
            :placeholder="t('view.settings.companyNameHint')"
            @input="firmaNameVomUser = true"
          />
        </label>
        <label v-if="auth.istAdmin">
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

    <h2>{{ t('view.settings.informationen') }}</h2>
    <div class="card quick-links">
      <RouterLink to="/info">{{ t('view.settings.ersteSchritte') }}</RouterLink>
    </div>

    <h2>{{ t('view.settings.account') }}</h2>
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
      <RouterLink to="/passwort-aendern">{{ t('view.settings.passwortAendern') }}</RouterLink>
      <button type="button" class="danger" @click="abmelden">
        {{ t('view.settings.abmelden') }}
      </button>
    </div>

    <!-- Notification tracking is not admin-only: every role may follow its
         minimum-stock alarms and enable the signal itself (off by default
         for non-admins, see `alarmDefaultFuerRolle`). -->
    <h2>{{ t('view.settings.benachrichtigungen') }}</h2>
    <div class="card">
      <MindestbestandBenachrichtigungen />
    </div>

    <h2 v-if="auth.istAdmin">{{ t('view.settings.administration') }}</h2>
    <div v-if="auth.istAdmin" class="card quick-links">
      <RouterLink to="/einstellungen/user">{{ t('view.settings.benutzerVerwaltung') }}</RouterLink>
      <RouterLink to="/einstellungen/entwicklung">{{ t('view.settings.entwicklung') }}</RouterLink>
    </div>

    <h2 v-if="auth.istAdmin">{{ t('view.settings.werkzeuge') }}</h2>
    <div v-if="auth.istAdmin" class="card">
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

    <h2>{{ t('view.settings.daten') }}</h2>
    <div class="card quick-links">
      <RouterLink to="/einstellungen/geraet">{{ t('view.settings.geraet') }}</RouterLink>
      <RouterLink v-if="auth.istAdmin" to="/import">{{ t('view.settings.csvImport') }}</RouterLink>
      <RouterLink v-if="auth.istAdmin" to="/einstellungen/backup">{{
        t('view.settings.backup')
      }}</RouterLink>
      <RouterLink v-if="auth.istAdmin" to="/einstellungen/api-keys">{{
        t('view.settings.apiKeys')
      }}</RouterLink>
    </div>

    <h2>{{ t('view.settings.stammdaten') }}</h2>
    <div class="card quick-links">
      <RouterLink v-if="auth.istAdmin" to="/standorte">{{ t('view.standort.h1') }}</RouterLink>
      <RouterLink v-if="settings.settings.akkutauschAktiv" to="/akkutausch">{{
        t('view.akkutausch.h1')
      }}</RouterLink>
      <RouterLink v-if="auth.istAdmin" to="/einstellungen/artikel-typen">{{
        t('view.artikelTypen.h1')
      }}</RouterLink>
      <RouterLink
        v-if="auth.istAdmin && settings.settings.akkutauschAktiv"
        to="/einstellungen/akku-typen"
        >{{ t('view.akkuTypen.h1') }}</RouterLink
      >
      <RouterLink v-if="auth.istAdmin" to="/einstellungen/kommissionen">{{
        t('view.kommissionen.h1')
      }}</RouterLink>
      <RouterLink v-if="auth.istAdmin" to="/einstellungen/hersteller">{{
        t('view.hersteller.h1')
      }}</RouterLink>
      <RouterLink to="/einstellungen/artikel-kataloge">{{
        t('view.settings.artikelKataloge')
      }}</RouterLink>
      <RouterLink to="/etiketten">{{ t('view.barcode.h1') }}</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.quick-links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.quick-links a,
.quick-links button {
  display: inline-flex;
  padding: 0.4rem 0;
  font-weight: 500;
  width: max-content;
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
