<script setup lang="ts">
// Onboarding-Modal: wird beim ersten Login eines Users automatisch
// gezeigt ("Erste Schritte"). Per-User-Sicht via
// `settings.settings.onboardingSeen` (siehe stores/settings.ts).
//
// Der Modal-Trigger sitzt in App.vue: er öffnet das Tutorial einmalig,
// sobald ein Login stattgefunden hat UND der eingeloggte User das
// Tutorial noch nicht gesehen hat. Sobald der User den Modal
// schließt (egal über welchen Button), wird `setOnboardingSeen(true)`
// aufgerufen und das Tutorial erscheint nicht mehr automatisch.
//
// "Mehr erfahren" ruft die /info-Route auf — der Modal bleibt dort
// nicht offen; der User liest die ausführliche Anleitung in der
// eigenen View.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'

const props = defineProps<{
  offen: boolean
}>()

const emit = defineEmits<{
  (e: 'schliessen'): void
}>()

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()

type Plattform = 'ios' | 'android' | 'desktop'

// Welches Tab standardmäßig fokussiert wird. Wir raten grob nach
// User-Agent; unbekannte Geräte landen auf "android" (am häufigsten).
function erkennePlattform(): Plattform {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'desktop'
}

const plattform = ref<Plattform>(erkennePlattform())
const schritt = ref(0) // 0..N-1, innerhalb der plattform-spezifischen Schritte

const schritte = computed((): string[] => {
  switch (plattform.value) {
    case 'ios':
      return [
        t('onboarding.ios.s1'),
        t('onboarding.ios.s2'),
        t('onboarding.ios.s3'),
        t('onboarding.ios.s4'),
        t('onboarding.ios.s5'),
      ]
    case 'android':
      return [t('onboarding.android.s1'), t('onboarding.android.s2'), t('onboarding.android.s3')]
    case 'desktop':
      return [t('onboarding.desktop.s1'), t('onboarding.desktop.s2')]
    default:
      return []
  }
})

watch(
  () => props.offen,
  (istOffen) => {
    if (istOffen) {
      schritt.value = 0
    }
  },
)

// ESC schließt das Tutorial (zählt als "gesehen").
function onKeydown(e: KeyboardEvent): void {
  if (!props.offen) return
  if (e.key === 'Escape') {
    e.preventDefault()
    void abschliessen()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown)
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeydown)
  }
})

async function abschliessen(): Promise<void> {
  // Marker setzen, damit das Tutorial beim nächsten Login nicht
  // wieder erscheint. Best-effort: Fehler beim Schreiben dürfen das
  // Schließen nicht blockieren.
  try {
    await settings.setOnboardingSeen(true)
  } catch {
    // bewusst ignorieren
  }
  emit('schliessen')
}

async function spaeter(): Promise<void> {
  // Gleicher Marker wie "Verstanden" — wir blenden das Modal aus,
  // und der User kann es später manuell über /info erneut starten
  // (Button "Tutorial erneut zeigen" setzt den Marker zurück).
  await abschliessen()
}

function weiter(): void {
  if (schritt.value < schritte.value.length - 1) {
    schritt.value += 1
  } else {
    void abschliessen()
  }
}

function zurueck(): void {
  if (schritt.value > 0) {
    schritt.value -= 1
  }
}

async function mehrErfahren(): Promise<void> {
  await abschliessen()
  await router.push('/info')
}

const istLetzter = computed(() => schritt.value === schritte.value.length - 1)
const istErster = computed(() => schritt.value === 0)

function plattformLabel(p: Plattform): string {
  if (p === 'ios') return t('onboarding.tab.ios')
  if (p === 'android') return t('onboarding.tab.android')
  return t('onboarding.tab.desktop')
}

console.log('[onboarding] OnboardingTutorial rendert. props.offen =', props.offen)
</script>

<template>
  <div
    v-if="offen"
    class="onb-overlay"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="'onb-title'"
  >
    <div class="onb-card">
      <header class="onb-head">
        <h2 :id="'onb-title'">{{ t('onboarding.titel') }}</h2>
        <button
          type="button"
          class="onb-close"
          :aria-label="t('onboarding.schliessen')"
          @click="abschliessen"
        >
          ×
        </button>
      </header>

      <p class="onb-sub">{{ t('onboarding.untertitel') }}</p>

      <div class="onb-tabs" role="tablist">
        <button
          v-for="p in ['ios', 'android', 'desktop'] as const"
          :key="p"
          type="button"
          role="tab"
          class="onb-tab"
          :class="{ active: plattform === p }"
          :aria-selected="plattform === p"
          @click="plattform = p"
        >
          {{ plattformLabel(p) }}
        </button>
      </div>

      <ol class="onb-steps" role="tabpanel">
        <li
          v-for="(s, idx) in schritte"
          :key="idx"
          :class="{ aktiv: idx === schritt, done: idx < schritt }"
        >
          <span class="onb-step-nr" aria-hidden="true">{{ idx + 1 }}</span>
          <span class="onb-step-text">{{ s }}</span>
        </li>
      </ol>

      <div class="onb-progress" aria-hidden="true">
        <span
          v-for="(_, idx) in schritte"
          :key="idx"
          class="dot"
          :class="{ aktiv: idx === schritt, done: idx < schritt }"
        ></span>
      </div>

      <footer class="onb-foot">
        <button type="button" class="ghost" @click="spaeter">
          {{ t('onboarding.spaeter') }}
        </button>
        <div class="onb-nav">
          <button type="button" :disabled="istErster" @click="zurueck">
            {{ t('onboarding.zurueck') }}
          </button>
          <button type="button" class="primary" @click="weiter">
            {{ istLetzter ? t('onboarding.fertig') : t('onboarding.weiter') }}
          </button>
        </div>
      </footer>

      <button type="button" class="onb-mehr" @click="mehrErfahren">
        {{ t('onboarding.mehrErfahren') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.onb-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  padding: 1rem;
  z-index: 1100;
  animation: onb-fade 0.18s ease-out;
}

@keyframes onb-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.onb-card {
  width: 100%;
  max-width: 30rem;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  padding: 1.2rem 1.3rem 1rem;
  box-shadow: var(--shadow-pop);
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.onb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.onb-head h2 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text-strong);
}

.onb-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.4rem;
  line-height: 1;
  padding: 0.1rem 0.4rem;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.onb-close:hover {
  background: var(--bg-input);
  color: var(--text-strong);
}

.onb-sub {
  margin: 0;
  font-size: 0.88rem;
  color: var(--text-muted);
}

.onb-tabs {
  display: flex;
  gap: 0.25rem;
  background: var(--bg-input);
  padding: 0.2rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.onb-tab {
  flex: 1;
  background: transparent;
  border: none;
  padding: 0.4rem 0.5rem;
  font-size: 0.85rem;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-weight: 500;
}
.onb-tab:hover {
  color: var(--text-strong);
}
.onb-tab.active {
  background: var(--bg-card);
  color: var(--text-strong);
  border: 1px solid var(--border-strong);
}

.onb-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-height: 6rem;
}
.onb-steps li {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.55rem 0.7rem;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 0.9rem;
  line-height: 1.45;
  opacity: 0.55;
  transition:
    background 0.15s,
    opacity 0.15s,
    transform 0.15s;
}
.onb-steps li.done {
  opacity: 0.7;
}
.onb-steps li.aktiv {
  background: var(--accent-bg);
  color: var(--text-strong);
  opacity: 1;
  transform: translateX(2px);
}

.onb-step-nr {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 0.75rem;
  font-weight: 600;
  flex-shrink: 0;
}
.onb-steps li.aktiv .onb-step-nr {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.onb-step-text {
  flex: 1;
}

.onb-progress {
  display: flex;
  justify-content: center;
  gap: 0.4rem;
}
.onb-progress .dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--border-strong);
  transition: background 0.15s;
}
.onb-progress .dot.done {
  background: var(--accent);
  opacity: 0.6;
}
.onb-progress .dot.aktiv {
  background: var(--accent);
}

.onb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.onb-nav {
  display: flex;
  gap: 0.4rem;
  margin-left: auto;
}

.onb-foot button {
  padding: 0.45rem 0.85rem;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-input);
  color: var(--text);
  font-family: inherit;
  font-size: 0.88rem;
  cursor: pointer;
}
.onb-foot button:hover:not(:disabled) {
  background: var(--bg-card);
  border-color: var(--accent-border);
  color: var(--text-strong);
}
.onb-foot button.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.onb-foot button.primary:hover:not(:disabled) {
  filter: brightness(1.08);
}
.onb-foot button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.onb-foot button.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}
.onb-foot button.ghost:hover {
  color: var(--text-strong);
}

.onb-mehr {
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0.2rem 0;
  font-family: inherit;
  text-align: left;
}
.onb-mehr:hover {
  text-decoration: underline;
}

@media (max-width: 480px) {
  .onb-card {
    padding: 1rem 1rem 0.85rem;
  }
  .onb-foot {
    flex-direction: column;
    align-items: stretch;
  }
  .onb-nav {
    margin-left: 0;
  }
}
</style>
