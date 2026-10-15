<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useStandortStore } from '../stores/standort'
import { useAuthStore } from '../stores/auth'
import { useArtikelTypen } from '../composables/useArtikelTypen'

const { t } = useI18n()
const router = useRouter()
const settings = useSettingsStore()
const standort = useStandortStore()
const auth = useAuthStore()
const { typVerwendungen } = useArtikelTypen()

const sprache = ref(settings.settings.sprache)
const standardId = ref<string>(settings.settings.standardStandortId ?? '')

watch(
  () => settings.settings,
  (s) => {
    sprache.value = s.sprache
    standardId.value = s.standardStandortId ?? ''
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
    await settings.setSprache(sprache.value)
    await settings.setStandardStandort(standardId.value || null)
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
    ungueltigeEingabe.value = t('view.settings.typVerwaltung.fehlerLeer')
    return
  }
  if (lokaleTypListe.value.includes(wert)) {
    ungueltigeEingabe.value = `"${wert}" ${t('view.settings.typVerwaltung.fehlerDuplikat')}`
    return
  }
  lokaleTypListe.value.push(wert)
  neueEingabe.value = ''
  ungueltigeEingabe.value = ''
  void typenSpeichern()
}

function typEntfernen(typ: string): void {
  const eintrag = typVerwendungen.value.find((t) => t.typ === typ)
  if (eintrag && eintrag.anzahl > 0) return
  lokaleTypListe.value = lokaleTypListe.value.filter((t) => t !== typ)
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
  typSpeicherStatus.value = t('view.settings.typVerwaltung.speicherStatus')
  if (typStatusTimer !== null) clearTimeout(typStatusTimer)
  typStatusTimer = setTimeout(() => {
    typSpeicherStatus.value = ''
    typStatusTimer = null
  }, 1500)
}

function anzahlLabel(anzahl: number): string {
  return anzahl === 1
    ? t('view.settings.typVerwaltung.anzahlEins')
    : t('view.settings.typVerwaltung.anzahlViele', { n: anzahl })
}

onBeforeUnmount(() => {
  if (statusTimer !== null) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  if (typStatusTimer !== null) {
    clearTimeout(typStatusTimer)
    typStatusTimer = null
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
        <label>
          <span>{{ t('view.settings.sprache') }}</span>
          <select v-model="sprache" :disabled="laufend">
            <option value="de">{{ t('view.settings.sprachen.de') }}</option>
            <option value="en">{{ t('view.settings.sprachen.en') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.settings.standardStandort') }}</span>
          <select v-model="standardId" :disabled="laufend">
            <option value="">— {{ t('view.settings.nichtGelegt') }} —</option>
            <option v-for="s in standorte" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
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

    <h2>Account</h2>
    <div class="card quick-links">
      <div class="readonly">
        <span class="label">{{ t('view.settings.benutzer') }}</span>
        <span class="value">{{ auth.anzeigename || '—' }}</span>
      </div>
      <RouterLink to="/passwort-aendern">Passwort ändern</RouterLink>
      <button type="button" class="danger" @click="abmelden">Abmelden</button>
    </div>

    <h2 v-if="auth.istAdmin">Administration</h2>
    <div v-if="auth.istAdmin" class="card quick-links">
      <RouterLink to="/einstellungen/user">Benutzer-Verwaltung</RouterLink>
    </div>

    <h2>Daten</h2>
    <div class="card quick-links">
      <RouterLink to="/import">CSV-Import &amp; Backup</RouterLink>
    </div>

    <h2>Stammdaten</h2>
    <div class="card quick-links">
      <RouterLink to="/standorte">{{ t('view.standort.h1') }}</RouterLink>
    </div>

    <h2>{{ t('view.settings.typVerwaltung.titel') }}</h2>
    <p class="hint">{{ t('view.settings.typVerwaltung.hint') }}</p>

    <div class="card">
      <form class="form new-type" @submit.prevent="typHinzufuegen">
        <label>
          <span>{{ t('view.settings.typVerwaltung.neuerTyp') }}</span>
          <input
            v-model="neueEingabe"
            type="text"
            placeholder="z. B. Verteilerdose"
            autocomplete="off"
          />
        </label>
        <button type="submit" class="primary">
          {{ t('view.settings.typVerwaltung.hinzufuegen') }}
        </button>
      </form>
      <p v-if="ungueltigeEingabe" class="fehler">{{ ungueltigeEingabe }}</p>
    </div>

    <h3>{{ t('view.settings.typVerwaltung.konfigurierte') }}</h3>
    <ul v-if="lokaleTypListe.length > 0" class="typ-list">
      <li v-for="(typ, idx) in lokaleTypListe" :key="typ" class="card typ-row">
        <span class="typ-name">{{ typ }}</span>
        <span class="typ-meta">
          {{ anzahlLabel(typVerwendungen.find((t) => t.typ === typ)?.anzahl ?? 0) }}
        </span>
        <span class="typ-actions">
          <button
            type="button"
            :disabled="idx === 0"
            :title="
              idx === 0
                ? t('view.settings.typVerwaltung.istOben')
                : t('view.settings.typVerwaltung.nachOben')
            "
            @click="typHoch(typ)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="idx === lokaleTypListe.length - 1"
            :title="
              idx === lokaleTypListe.length - 1
                ? t('view.settings.typVerwaltung.istUnten')
                : t('view.settings.typVerwaltung.nachUnten')
            "
            @click="typRunter(typ)"
          >
            ↓
          </button>
          <button
            type="button"
            class="danger"
            :disabled="(typVerwendungen.find((t) => t.typ === typ)?.anzahl ?? 0) > 0"
            :title="
              (typVerwendungen.find((t) => t.typ === typ)?.anzahl ?? 0) > 0
                ? t('view.settings.typVerwaltung.entfernenGenutzt')
                : t('view.settings.typVerwaltung.entfernen')
            "
            @click="typEntfernen(typ)"
          >
            {{ t('view.settings.typVerwaltung.entfernen') }}
          </button>
        </span>
      </li>
    </ul>
    <p v-else class="empty-state">{{ t('view.settings.typVerwaltung.leer') }}</p>

    <template v-if="typVerwendungen.some((t) => t.verwaist)">
      <h3>{{ t('view.settings.typVerwaltung.verwaiste') }}</h3>
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
              {{ t('view.settings.typVerwaltung.uebernehmen') }}
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
