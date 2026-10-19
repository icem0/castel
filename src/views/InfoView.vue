<script setup lang="ts">
// "Informationen"-Rubrik: enthält die Anleitung zum Einrichten der PWA
// unter iOS und Android. Bewusst statisch und ohne Live-Data — soll
// auch offline / ohne Sync funktionieren.
//
// Oben auf der Seite steht zusätzlich die Onboarding-Toggle-Karte:
// - aktueller Status (aktiv = wird beim Login gezeigt, aus = nicht)
// - Checkbox zum Ein-/Aus-Schalten, wirkt sofort (per User, Cross-Device-Sync)
// - Button "Tutorial jetzt zeigen" zum manuellen Öffnen, falls man es
//   doch nochmal sehen will

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()

const speichernPending = ref(false)
let speichernResetTimer: ReturnType<typeof setTimeout> | null = null

function markiereSpeichern(): void {
  speichernPending.value = true
  if (speichernResetTimer !== null) clearTimeout(speichernResetTimer)
  speichernResetTimer = setTimeout(() => {
    speichernPending.value = false
    speichernResetTimer = null
  }, 1500)
}

async function setzeOnboarding(naechsterWert: boolean): Promise<void> {
  try {
    await settings.setOnboardingSeen(naechsterWert)
    markiereSpeichern()
  } catch {
    // bewusst ignorieren — Settings-Store wirft nur bei unbekanntem Key,
    // was hier nicht passieren kann
  }
}

// Akkordeon-State: jede Sektion ist einklappbar. iOS/Android standard-
// mäßig offen, "Warum installieren?" eingeklappt — damit der Nutzer
// direkt zur Anleitung springt.
const offen = ref<Record<'ios' | 'android' | 'warum' | 'probleme', boolean>>({
  ios: true,
  android: true,
  warum: false,
  probleme: false,
})

function toggle(key: 'ios' | 'android' | 'warum' | 'probleme'): void {
  offen.value[key] = !offen.value[key]
}

const onboardingAus = computed(() => settings.settings.onboardingSeen === true)

async function zeigeErsteSchritteNochmal(): Promise<void> {
  // Marker zurücksetzen, damit App.vue das Tutorial beim nächsten
  // Login / Reload wieder automatisch öffnet.
  await settings.setOnboardingSeen(false)
  markiereSpeichern()
}

function zumDashboard(): void {
  void router.push('/')
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.info.h1') }}</h1>
      <p class="hint">{{ t('view.info.untertitel') }}</p>
    </header>

    <div class="card onboarding-card">
      <div class="onboarding-status" :class="{ aus: onboardingAus }">
        <span class="onboarding-dot" aria-hidden="true"></span>
        <span class="onboarding-status-text">
          {{
            onboardingAus ? t('view.info.onboardingStatusAus') : t('view.info.onboardingStatusAn')
          }}
        </span>
      </div>

      <label class="check onboarding-toggle">
        <input
          type="checkbox"
          :checked="onboardingAus"
          :disabled="speichernPending"
          @change="(e) => setzeOnboarding((e.target as HTMLInputElement).checked)"
        />
        <span>{{ t('view.info.onboardingAusblenden') }}</span>
      </label>
      <p class="hint">{{ t('view.info.onboardingAusblendenHint') }}</p>

      <div class="onboarding-actions">
        <button type="button" :disabled="speichernPending" @click="zeigeErsteSchritteNochmal">
          {{ t('view.info.onboardingErneut') }}
        </button>
      </div>
    </div>

    <div class="card">
      <button type="button" class="acc-head" :aria-expanded="offen.ios" @click="toggle('ios')">
        <span class="acc-icon" aria-hidden="true">{{ offen.ios ? '▾' : '▸' }}</span>
        <span class="acc-title">{{ t('view.info.iosTitel') }}</span>
      </button>
      <div v-if="offen.ios" class="acc-body">
        <ol class="steps">
          <li>{{ t('view.info.iosS1') }}</li>
          <li>{{ t('view.info.iosS2') }}</li>
          <li>{{ t('view.info.iosS3') }}</li>
          <li>{{ t('view.info.iosS4') }}</li>
          <li>{{ t('view.info.iosS5') }}</li>
        </ol>
        <p class="hint">{{ t('view.info.iosHinweis') }}</p>
      </div>
    </div>

    <div class="card">
      <button
        type="button"
        class="acc-head"
        :aria-expanded="offen.android"
        @click="toggle('android')"
      >
        <span class="acc-icon" aria-hidden="true">{{ offen.android ? '▾' : '▸' }}</span>
        <span class="acc-title">{{ t('view.info.androidTitel') }}</span>
      </button>
      <div v-if="offen.android" class="acc-body">
        <p class="hint">{{ t('view.info.androidVariante') }}</p>

        <h3 class="sub">{{ t('view.info.androidChromeTitel') }}</h3>
        <ol class="steps">
          <li>{{ t('view.info.androidChromeS1') }}</li>
          <li>{{ t('view.info.androidChromeS2') }}</li>
          <li>{{ t('view.info.androidChromeS3') }}</li>
        </ol>

        <h3 class="sub">{{ t('view.info.androidSamsungTitel') }}</h3>
        <ol class="steps">
          <li>{{ t('view.info.androidSamsungS1') }}</li>
          <li>{{ t('view.info.androidSamsungS2') }}</li>
          <li>{{ t('view.info.androidSamsungS3') }}</li>
        </ol>

        <h3 class="sub">{{ t('view.info.androidFirefoxTitel') }}</h3>
        <ol class="steps">
          <li>{{ t('view.info.androidFirefoxS1') }}</li>
          <li>{{ t('view.info.androidFirefoxS2') }}</li>
          <li>{{ t('view.info.androidFirefoxS3') }}</li>
        </ol>
      </div>
    </div>

    <div class="card">
      <button type="button" class="acc-head" :aria-expanded="offen.warum" @click="toggle('warum')">
        <span class="acc-icon" aria-hidden="true">{{ offen.warum ? '▾' : '▸' }}</span>
        <span class="acc-title">{{ t('view.info.warumTitel') }}</span>
      </button>
      <div v-if="offen.warum" class="acc-body">
        <ul class="bullets">
          <li>{{ t('view.info.warum1') }}</li>
          <li>{{ t('view.info.warum2') }}</li>
          <li>{{ t('view.info.warum3') }}</li>
          <li>{{ t('view.info.warum4') }}</li>
        </ul>
      </div>
    </div>

    <div class="card">
      <button
        type="button"
        class="acc-head"
        :aria-expanded="offen.probleme"
        @click="toggle('probleme')"
      >
        <span class="acc-icon" aria-hidden="true">{{ offen.probleme ? '▾' : '▸' }}</span>
        <span class="acc-title">{{ t('view.info.problemeTitel') }}</span>
      </button>
      <div v-if="offen.probleme" class="acc-body">
        <dl class="faq">
          <dt>{{ t('view.info.faq1Frage') }}</dt>
          <dd>{{ t('view.info.faq1Antwort') }}</dd>

          <dt>{{ t('view.info.faq2Frage') }}</dt>
          <dd>{{ t('view.info.faq2Antwort') }}</dd>

          <dt>{{ t('view.info.faq3Frage') }}</dt>
          <dd>{{ t('view.info.faq3Antwort') }}</dd>
        </dl>
      </div>
    </div>

    <div class="card actions">
      <button type="button" class="primary" @click="zumDashboard">
        {{ t('view.info.zumDashboard') }}
      </button>
      <button type="button" @click="zeigeErsteSchritteNochmal">
        {{ t('view.info.onboardingErneut') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.onboarding-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-left: 4px solid var(--accent);
}
.onboarding-card .onboarding-status.aus {
  border-left-color: var(--text-muted);
}
.onboarding-status {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  color: var(--text-strong);
}
.onboarding-dot {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--bg-card);
}
.onboarding-status.aus .onboarding-dot {
  background: var(--text-muted);
}
.onboarding-toggle {
  margin-top: 0.25rem;
}
.onboarding-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.4rem;
}
.onboarding-actions button {
  padding: 0.45rem 0.9rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text);
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}
.onboarding-actions button:disabled {
  opacity: 0.6;
  cursor: progress;
}
.onboarding-actions button:hover:not(:disabled) {
  border-color: var(--accent-border);
  color: var(--text-strong);
}

.acc-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: transparent;
  border: none;
  padding: 0.4rem 0;
  font: inherit;
  font-weight: 600;
  font-size: 1rem;
  color: var(--text-strong);
  cursor: pointer;
  text-align: left;
}
.acc-head:hover {
  color: var(--accent);
}
.acc-icon {
  font-family: var(--mono);
  font-size: 0.85rem;
  color: var(--text-muted);
  width: 1rem;
  display: inline-block;
}
.acc-title {
  flex: 1;
}
.acc-body {
  padding: 0.25rem 1.5rem 0.6rem 1.5rem;
}

.steps {
  margin: 0.25rem 0 0.6rem;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  line-height: 1.45;
}
.steps li::marker {
  color: var(--accent);
  font-weight: 600;
}

.bullets {
  margin: 0.25rem 0 0.4rem;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  line-height: 1.45;
}

.faq {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.4rem 0.85rem;
  margin: 0.25rem 0 0.4rem;
}
.faq dt {
  font-weight: 600;
  color: var(--text-strong);
}
.faq dd {
  margin: 0;
  color: var(--text);
  line-height: 1.45;
}

.sub {
  margin: 0.6rem 0 0.2rem;
  font-size: 0.95rem;
  color: var(--text-strong);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.actions button {
  padding: 0.5rem 0.9rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text);
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}
.actions button.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.actions button.primary:hover {
  filter: brightness(1.08);
}
.actions button:hover:not(.primary) {
  background: var(--bg-card);
  border-color: var(--accent-border);
  color: var(--text-strong);
}
</style>
