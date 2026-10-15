<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useArtikelTypen } from '../composables/useArtikelTypen'

const { t } = useI18n()
const settings = useSettingsStore()
const { typVerwendungen } = useArtikelTypen()

const lokaleTypListe = ref<string[]>([])
const neueEingabe = ref('')
const ungueltigeEingabe = ref('')
const typSpeicherStatus = ref('')
let typStatusTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => settings.settings.artikelTypen,
  (list) => {
    lokaleTypListe.value = [...list]
  },
  { immediate: true },
)

function typHinzufuegen(): void {
  const wert = neueEingabe.value.trim()
  if (!wert) {
    ungueltigeEingabe.value = t('view.artikelTypen.fehlerLeer')
    return
  }
  if (lokaleTypListe.value.includes(wert)) {
    ungueltigeEingabe.value = `"${wert}" ${t('view.artikelTypen.fehlerDuplikat')}`
    return
  }
  lokaleTypListe.value.push(wert)
  neueEingabe.value = ''
  ungueltigeEingabe.value = ''
  void typenSpeichern()
}

function typEntfernen(typ: string): void {
  const eintrag = typVerwendungen.value.find((x) => x.typ === typ)
  if (eintrag && eintrag.anzahl > 0) return
  lokaleTypListe.value = lokaleTypListe.value.filter((x) => x !== typ)
  void typenSpeichern()
}

function typHoch(typ: string): void {
  const idx = lokaleTypListe.value.indexOf(typ)
  if (idx <= 0) return
  const liste = [...lokaleTypListe.value]
  const vorher = liste[idx - 1]
  const aktuell = liste[idx]
  if (!vorher || !aktuell) return
  liste[idx - 1] = aktuell
  liste[idx] = vorher
  lokaleTypListe.value = liste
  void typenSpeichern()
}

function typRunter(typ: string): void {
  const idx = lokaleTypListe.value.indexOf(typ)
  if (idx < 0 || idx >= lokaleTypListe.value.length - 1) return
  const liste = [...lokaleTypListe.value]
  const nachher = liste[idx + 1]
  const aktuell = liste[idx]
  if (!nachher || !aktuell) return
  liste[idx] = nachher
  liste[idx + 1] = aktuell
  lokaleTypListe.value = liste
  void typenSpeichern()
}

function typUebernehmen(typ: string): void {
  if (lokaleTypListe.value.includes(typ)) return
  lokaleTypListe.value.push(typ)
  void typenSpeichern()
}

async function typenSpeichern(): Promise<void> {
  await settings.setArtikelTypen(lokaleTypListe.value)
  typSpeicherStatus.value = t('view.artikelTypen.speicherStatus')
  if (typStatusTimer !== null) clearTimeout(typStatusTimer)
  typStatusTimer = setTimeout(() => {
    typSpeicherStatus.value = ''
    typStatusTimer = null
  }, 1500)
}

function anzahlLabel(anzahl: number): string {
  return anzahl === 1
    ? t('view.artikelTypen.anzahlEins')
    : t('view.artikelTypen.anzahlViele', { n: anzahl })
}

onBeforeUnmount(() => {
  if (typStatusTimer !== null) {
    clearTimeout(typStatusTimer)
    typStatusTimer = null
  }
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.artikelTypen.h1') }}</h1>
    </header>

    <p class="hint">{{ t('view.artikelTypen.hint') }}</p>

    <div class="card">
      <form class="form new-type" @submit.prevent="typHinzufuegen">
        <label>
          <span>{{ t('view.artikelTypen.neuerTyp') }}</span>
          <input
            v-model="neueEingabe"
            type="text"
            placeholder="z. B. Verteilerdose"
            autocomplete="off"
          />
        </label>
        <button type="submit" class="primary">
          {{ t('view.artikelTypen.hinzufuegen') }}
        </button>
      </form>
      <p v-if="ungueltigeEingabe" class="fehler">{{ ungueltigeEingabe }}</p>
    </div>

    <h3>{{ t('view.artikelTypen.konfigurierte') }}</h3>
    <ul v-if="lokaleTypListe.length > 0" class="typ-list">
      <li v-for="(typ, idx) in lokaleTypListe" :key="typ" class="card typ-row">
        <span class="typ-name">{{ typ }}</span>
        <span class="typ-meta">
          {{ anzahlLabel(typVerwendungen.find((x) => x.typ === typ)?.anzahl ?? 0) }}
        </span>
        <span class="typ-actions">
          <button
            type="button"
            :disabled="idx === 0"
            :title="idx === 0 ? t('view.artikelTypen.istOben') : t('view.artikelTypen.nachOben')"
            @click="typHoch(typ)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="idx === lokaleTypListe.length - 1"
            :title="
              idx === lokaleTypListe.length - 1
                ? t('view.artikelTypen.istUnten')
                : t('view.artikelTypen.nachUnten')
            "
            @click="typRunter(typ)"
          >
            ↓
          </button>
          <button
            type="button"
            class="danger"
            :disabled="(typVerwendungen.find((x) => x.typ === typ)?.anzahl ?? 0) > 0"
            :title="
              (typVerwendungen.find((x) => x.typ === typ)?.anzahl ?? 0) > 0
                ? t('view.artikelTypen.entfernenGenutzt')
                : t('view.artikelTypen.entfernen')
            "
            @click="typEntfernen(typ)"
          >
            {{ t('view.artikelTypen.entfernen') }}
          </button>
        </span>
      </li>
    </ul>
    <p v-else class="empty-state">{{ t('view.artikelTypen.leer') }}</p>

    <template v-if="typVerwendungen.some((x) => x.verwaist)">
      <h3>{{ t('view.artikelTypen.verwaiste') }}</h3>
      <ul class="typ-list">
        <li
          v-for="eintrag in typVerwendungen.filter((x) => x.verwaist)"
          :key="eintrag.typ"
          class="card typ-row"
        >
          <span class="typ-name">{{ eintrag.typ }}</span>
          <span class="typ-meta">{{ anzahlLabel(eintrag.anzahl) }}</span>
          <span class="typ-actions">
            <button type="button" class="primary" @click="typUebernehmen(eintrag.typ)">
              {{ t('view.artikelTypen.uebernehmen') }}
            </button>
          </span>
        </li>
      </ul>
    </template>

    <p v-if="typSpeicherStatus" class="hint hint-ok" role="status" aria-live="polite">
      {{ typSpeicherStatus }}
    </p>
  </section>
</template>

<style scoped>
.new-type {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
  align-items: end;
}
.new-type label {
  margin: 0;
}

.typ-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.typ-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.7rem 1rem;
}

.typ-name {
  font-weight: 600;
  color: var(--text-strong);
}

.typ-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.typ-actions {
  display: flex;
  gap: 0.3rem;
}

@media (max-width: 640px) {
  .typ-row {
    grid-template-columns: 1fr;
  }
  .typ-actions {
    justify-content: flex-end;
  }
}
</style>
