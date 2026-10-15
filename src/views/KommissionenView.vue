<script setup lang="ts">
// Kommissionen-Verwaltung (Admin-only).
//
// Quelle: `einstellungen.kommissionen` (JSON-Array, konfigurierbar) +
//         distinct(projekt) aus `buchungen` (für historische Werte, die
//         nicht mehr in der Liste stehen — analog zu useArtikelTypen).
//
// Reihenfolge = Anzeige-Reihenfolge. Wird als freier Text in der
// Buchungsmaske (`Buchung.projekt`) verwendet.

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useBuchungStore } from '../stores/buchung'

const { t } = useI18n()
const settings = useSettingsStore()
const buchungStore = useBuchungStore()

interface KommissionVerwendung {
  name: string
  /** Wie viele Buchungen referenzieren diese Kommission. */
  anzahl: number
  /** True, wenn der Name aus den Einstellungen kommt. */
  konfiguriert: boolean
  /** True, wenn der Name nur in Buchungen existiert (nicht in der Liste). */
  verwaist: boolean
}

const lokaleListe = ref<string[]>([])
const neueEingabe = ref('')
const ungueltigeEingabe = ref('')
const speicherStatus = ref('')
let statusTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => settings.settings.kommissionen,
  (list) => {
    lokaleListe.value = [...list]
  },
  { immediate: true },
)

const verwendungen = computed<KommissionVerwendung[]>(() => {
  const konfiguriert = settings.settings.kommissionen
  const counts = new Map<string, number>()
  for (const b of buchungStore.buchungen) {
    const name = b.projekt?.trim()
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const verwaiste = [...counts.keys()].filter((n) => !konfiguriert.includes(n)).sort()

  const result: KommissionVerwendung[] = []
  for (const name of konfiguriert) {
    result.push({ name, anzahl: counts.get(name) ?? 0, konfiguriert: true, verwaist: false })
  }
  for (const name of verwaiste) {
    result.push({ name, anzahl: counts.get(name) ?? 0, konfiguriert: false, verwaist: true })
  }
  return result
})

function hinzufuegen(): void {
  const wert = neueEingabe.value.trim()
  if (!wert) {
    ungueltigeEingabe.value = t('view.kommissionen.fehlerLeer')
    return
  }
  if (lokaleListe.value.includes(wert)) {
    ungueltigeEingabe.value = `"${wert}" ${t('view.kommissionen.fehlerDuplikat')}`
    return
  }
  lokaleListe.value.push(wert)
  neueEingabe.value = ''
  ungueltigeEingabe.value = ''
  void speichern()
}

function entfernen(name: string): void {
  const eintrag = verwendungen.value.find((x) => x.name === name)
  if (eintrag && eintrag.anzahl > 0) return
  lokaleListe.value = lokaleListe.value.filter((x) => x !== name)
  void speichern()
}

function hoch(name: string): void {
  const idx = lokaleListe.value.indexOf(name)
  if (idx <= 0) return
  const liste = [...lokaleListe.value]
  const vorher = liste[idx - 1]
  const aktuell = liste[idx]
  if (!vorher || !aktuell) return
  liste[idx - 1] = aktuell
  liste[idx] = vorher
  lokaleListe.value = liste
  void speichern()
}

function runter(name: string): void {
  const idx = lokaleListe.value.indexOf(name)
  if (idx < 0 || idx >= lokaleListe.value.length - 1) return
  const liste = [...lokaleListe.value]
  const nachher = liste[idx + 1]
  const aktuell = liste[idx]
  if (!nachher || !aktuell) return
  liste[idx] = nachher
  liste[idx + 1] = aktuell
  lokaleListe.value = liste
  void speichern()
}

function uebernehmen(name: string): void {
  if (lokaleListe.value.includes(name)) return
  lokaleListe.value.push(name)
  void speichern()
}

async function speichern(): Promise<void> {
  await settings.setKommissionen(lokaleListe.value)
  speicherStatus.value = t('view.kommissionen.speicherStatus')
  if (statusTimer !== null) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    speicherStatus.value = ''
    statusTimer = null
  }, 1500)
}

function anzahlLabel(anzahl: number): string {
  return anzahl === 1
    ? t('view.kommissionen.anzahlEins')
    : t('view.kommissionen.anzahlViele', { n: anzahl })
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
      <h1>{{ t('view.kommissionen.h1') }}</h1>
    </header>

    <p class="hint">{{ t('view.kommissionen.hint') }}</p>

    <div class="card">
      <form class="form new-kommission" @submit.prevent="hinzufuegen">
        <label>
          <span>{{ t('view.kommissionen.neueKommission') }}</span>
          <input
            v-model="neueEingabe"
            type="text"
            placeholder="z. B. Projekt Müller"
            autocomplete="off"
          />
        </label>
        <button type="submit" class="primary">
          {{ t('view.kommissionen.hinzufuegen') }}
        </button>
      </form>
      <p v-if="ungueltigeEingabe" class="fehler">{{ ungueltigeEingabe }}</p>
    </div>

    <h3>{{ t('view.kommissionen.konfigurierte') }}</h3>
    <ul v-if="lokaleListe.length > 0" class="kommission-list">
      <li v-for="(name, idx) in lokaleListe" :key="name" class="card row">
        <span class="row-title">{{ name }}</span>
        <span class="row-meta">
          {{ anzahlLabel(verwendungen.find((x) => x.name === name)?.anzahl ?? 0) }}
        </span>
        <span class="row-actions">
          <button
            type="button"
            :disabled="idx === 0"
            :title="idx === 0 ? t('view.kommissionen.istOben') : t('view.kommissionen.nachOben')"
            @click="hoch(name)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="idx === lokaleListe.length - 1"
            :title="
              idx === lokaleListe.length - 1
                ? t('view.kommissionen.istUnten')
                : t('view.kommissionen.nachUnten')
            "
            @click="runter(name)"
          >
            ↓
          </button>
          <button
            type="button"
            class="danger"
            :disabled="(verwendungen.find((x) => x.name === name)?.anzahl ?? 0) > 0"
            :title="
              (verwendungen.find((x) => x.name === name)?.anzahl ?? 0) > 0
                ? t('view.kommissionen.entfernenGenutzt')
                : t('view.kommissionen.entfernen')
            "
            @click="entfernen(name)"
          >
            {{ t('view.kommissionen.entfernen') }}
          </button>
        </span>
      </li>
    </ul>
    <p v-else class="empty-state">{{ t('view.kommissionen.leer') }}</p>

    <template v-if="verwendungen.some((x) => x.verwaist)">
      <h3>{{ t('view.kommissionen.verwaiste') }}</h3>
      <ul class="kommission-list">
        <li
          v-for="eintrag in verwendungen.filter((x) => x.verwaist)"
          :key="eintrag.name"
          class="card row"
        >
          <span class="row-title">{{ eintrag.name }}</span>
          <span class="row-meta">{{ anzahlLabel(eintrag.anzahl) }}</span>
          <span class="row-actions">
            <button type="button" class="primary" @click="uebernehmen(eintrag.name)">
              {{ t('view.kommissionen.uebernehmen') }}
            </button>
          </span>
        </li>
      </ul>
    </template>

    <p v-if="speicherStatus" class="hint hint-ok" role="status" aria-live="polite">
      {{ speicherStatus }}
    </p>
  </section>
</template>

<style scoped>
.new-kommission {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  align-items: end;
}
.new-kommission label {
  margin: 0;
}

.kommission-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.7rem 1rem;
}

.row-title {
  font-weight: 600;
  color: var(--text-strong);
}

.row-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.row-actions {
  display: flex;
  gap: 0.3rem;
}

@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
  }
  .row-actions {
    justify-content: flex-end;
  }
}
</style>
