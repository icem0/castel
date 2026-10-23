<script setup lang="ts">
// Minimum-stock notification settings. Extracted from the minimum-stock
// panel so all notification configuration lives on the settings page.
// Future channels (messenger, e-mail, ...) can be added alongside this
// block without touching the event list.

import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../../stores/settings'
import { useMindestbestandAlarm } from '../../composables/useMindestbestandAlarm'

const { t } = useI18n()
const settings = useSettingsStore()
const alarm = useMindestbestandAlarm()

const soundAn = computed(() => settings.settings.mindestbestandSoundAn)
const lautstaerke = computed(() => settings.settings.mindestbestandLautstaerke)
const wiederholen = computed(() => settings.settings.mindestbestandWiederholen)
const permission = computed(() => alarm.permission.value)

const speichert = ref(false)

async function speichern(fn: () => Promise<void>): Promise<void> {
  speichert.value = true
  try {
    await fn()
  } finally {
    speichert.value = false
  }
}

async function onSoundAn(an: boolean): Promise<void> {
  await speichern(() => settings.setMindestbestandSoundAn(an))
}

async function onLautstaerke(ereignis: Event): Promise<void> {
  const ziel = ereignis.target as HTMLInputElement | null
  const wert = Number.parseInt(ziel?.value ?? '70', 10)
  if (!Number.isFinite(wert)) return
  await speichern(() => settings.setMindestbestandLautstaerke(wert))
}

async function onWiederholen(an: boolean): Promise<void> {
  await speichern(() => settings.setMindestbestandWiederholen(an))
}

async function testen(): Promise<void> {
  await alarm.signalTesten()
}

/**
 * Requests the notification permission. Must originate from a real user
 * gesture (button click), otherwise browsers reject the call.
 */
async function permissionAnfordern(): Promise<void> {
  if (typeof Notification === 'undefined') return
  try {
    await Notification.requestPermission()
  } catch {
    // Already denied or blocked — the state is shown via `permission`.
  }
}
</script>

<template>
  <div class="alarm-block">
    <h3 class="alarm-block-titel">{{ t('view.mindestbestand.title') }}</h3>

    <label class="alarm-zeile">
      <input
        type="checkbox"
        :checked="soundAn"
        :disabled="speichert"
        @change="onSoundAn(($event.target as HTMLInputElement).checked)"
      />
      <span class="alarm-zeile-text">
        <span class="alarm-zeile-label">{{ t('view.mindestbestand.soundAn') }}</span>
        <span class="alarm-zeile-hint">{{ t('view.mindestbestand.soundAnHint') }}</span>
      </span>
    </label>

    <label v-if="soundAn" class="alarm-zeile alarm-zeile-indent">
      <span class="alarm-zeile-label">{{ t('view.mindestbestand.lautstaerke') }}</span>
      <span class="alarm-slider-zeile">
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          :value="lautstaerke"
          :disabled="speichert"
          :aria-label="t('view.mindestbestand.lautstaerke')"
          @input="onLautstaerke"
        />
        <span class="alarm-slider-wert">{{ lautstaerke }} %</span>
      </span>
    </label>

    <label v-if="soundAn" class="alarm-zeile alarm-zeile-indent">
      <input
        type="checkbox"
        :checked="wiederholen"
        :disabled="speichert"
        @change="onWiederholen(($event.target as HTMLInputElement).checked)"
      />
      <span class="alarm-zeile-text">
        <span class="alarm-zeile-label">{{ t('view.mindestbestand.wiederholen') }}</span>
        <span class="alarm-zeile-hint">{{ t('view.mindestbestand.wiederholenHint') }}</span>
      </span>
    </label>

    <div class="alarm-aktionen">
      <button type="button" :disabled="!soundAn || speichert" @click="testen">
        {{ t('view.mindestbestand.testen') }}
      </button>
      <RouterLink to="/einstellungen/mindestbestand" class="alarm-link">
        {{ t('view.mindestbestand.alleEreignisse') }}
      </RouterLink>
    </div>

    <p class="alarm-permission-hinweis" :class="`state-${permission}`">
      <template v-if="permission === 'unsupported'">
        {{ t('view.mindestbestand.permUnsupported') }}
      </template>
      <template v-else-if="permission === 'denied'">
        {{ t('view.mindestbestand.permDenied') }}
      </template>
      <template v-else-if="permission === 'default'">
        {{ t('view.mindestbestand.permDefault') }}
        <button type="button" class="link-btn" @click="permissionAnfordern">
          {{ t('view.mindestbestand.permAnfordern') }}
        </button>
      </template>
      <template v-else>
        {{ t('view.mindestbestand.permGranted') }}
      </template>
    </p>
    <p class="alarm-technik-hinweis">{{ t('view.mindestbestand.technikHinweis') }}</p>
  </div>
</template>

<style scoped>
.alarm-block-titel {
  margin: 0 0 0.7rem;
  font-size: 0.95rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}
.alarm-zeile {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.45rem 0;
  cursor: pointer;
}
.alarm-zeile input[type='checkbox'] {
  margin-top: 0.2rem;
  width: 1.05rem;
  height: 1.05rem;
  flex: 0 0 auto;
  accent-color: var(--accent);
}
.alarm-zeile-indent {
  padding-left: 1.65rem;
  flex-wrap: wrap;
}
.alarm-zeile-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.alarm-zeile-label {
  font-size: 0.9rem;
  color: var(--text-strong);
}
.alarm-zeile-hint {
  font-size: 0.78rem;
  color: var(--text-muted);
}
.alarm-slider-zeile {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex: 1;
  min-width: 12rem;
}
.alarm-slider-zeile input[type='range'] {
  flex: 1;
  accent-color: var(--accent);
  min-width: 8rem;
}
.alarm-slider-wert {
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
  color: var(--text-muted);
  min-width: 3rem;
  text-align: right;
}
.alarm-aktionen {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-top: 0.6rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
.alarm-aktionen button {
  padding: 0.4rem 0.85rem;
  font-size: 0.85rem;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  font-family: inherit;
}
.alarm-aktionen button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.alarm-aktionen button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.alarm-link {
  font-size: 0.85rem;
  font-weight: 500;
}
.alarm-permission-hinweis {
  margin: 0.6rem 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.alarm-permission-hinweis.state-granted {
  color: var(--success, #16a34a);
}
.alarm-permission-hinweis.state-denied,
.alarm-permission-hinweis.state-unsupported {
  color: var(--text-muted);
}
.alarm-technik-hinweis {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  color: var(--text-muted);
  opacity: 0.85;
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: inherit;
  padding: 0 0 0 0.35rem;
  text-decoration: underline;
}
</style>
