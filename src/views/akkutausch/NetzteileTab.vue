<script setup lang="ts">
// Tab "Netzteile" des Akkutausch-Tools.
//
// Liste der eingebauten Geraete mit Suche, Filter ("faellig im Quartal")
// und Sortierung. Schreibaktionen sind Admin-only — Mitarbeiter sehen
// die Liste nur lesend.

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { formatDatum, formatKapazitaet } from '../../domain/akkutausch/formatierung'
import { quartalVonDatum } from '../../domain/akkutausch/berechnung'
import type { Netzteil } from '../../domain/akkutausch/types'
import NetzteilForm from './NetzteilForm.vue'

const { t } = useI18n()
const store = useAkkutauschStore()
const auth = useAuthStore()
const settings = useSettingsStore()

const locale = computed(() => settings.settings.sprache)
const suche = ref('')
const nurFaellig = ref(false)
const sortierung = ref<'faelligkeit' | 'bezeichnung'>('faelligkeit')
const bearbeitet = ref<Netzteil | null>(null)
const formOffen = ref(false)

const gefiltert = computed(() => {
  const q = suche.value.trim().toLowerCase()
  const liste = store.aktiveNetzteile.filter((n) => {
    if (q !== '') {
      const haystack = `${n.anlage} ${n.objekt} ${n.name} ${n.gruppe ?? ''}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    if (nurFaellig.value) {
      const faellig = store.faelligkeitVon(n)
      if (!faellig) return false
      if (quartalVonDatum(faellig) !== store.quartal) return false
      if (Number(faellig.slice(0, 4)) !== store.jahr) return false
    }
    return true
  })
  return liste.sort((a, b) => {
    if (sortierung.value === 'bezeichnung') {
      return `${a.anlage} ${a.objekt} ${a.name}`.localeCompare(
        `${b.anlage} ${b.objekt} ${b.name}`,
        locale.value,
      )
    }
    const fa = store.faelligkeitVon(a) ?? '9999-12-31'
    const fb = store.faelligkeitVon(b) ?? '9999-12-31'
    if (fa !== fb) return fa < fb ? -1 : 1
    return a.name.localeCompare(b.name, locale.value)
  })
})

function neuesNetzteil(): void {
  bearbeitet.value = null
  formOffen.value = true
}

function netzteilBearbeiten(n: Netzteil): void {
  bearbeitet.value = n
  formOffen.value = true
}

function formSchliessen(): void {
  formOffen.value = false
  bearbeitet.value = null
}

async function speichern(eingabe: Parameters<typeof store.netzteilSpeichern>[0]): Promise<void> {
  await store.netzteilSpeichern(eingabe)
  formSchliessen()
}

async function loeschen(n: Netzteil): Promise<void> {
  const frage = t('view.akkutausch.loeschenFrage', { name: n.name })
  if (!window.confirm(frage)) return
  await store.netzteilLoeschen(n.id)
}
</script>

<template>
  <div class="netzteile-tab">
    <div v-if="auth.istAdmin && !formOffen" class="card">
      <button type="button" class="primary" @click="neuesNetzteil">
        {{ t('view.akkutausch.neuesNetzteil') }}
      </button>
    </div>

    <div v-if="formOffen" class="card">
      <h2 class="card-titel">
        {{
          bearbeitet ? t('view.akkutausch.netzteilBearbeiten') : t('view.akkutausch.netzteilNeu')
        }}
      </h2>
      <NetzteilForm
        :netzteil="bearbeitet"
        :typen="store.typen"
        :locale="locale"
        @save="speichern"
        @cancel="formSchliessen"
      />
    </div>

    <div class="filter-bar">
      <input v-model="suche" type="search" :placeholder="t('view.akkutausch.suchePlatzhalter')" />
      <label class="check">
        <input v-model="nurFaellig" type="checkbox" />
        <span>{{ t('view.akkutausch.nurFaellig') }}</span>
      </label>
      <select v-model="sortierung">
        <option value="faelligkeit">{{ t('view.akkutausch.sortierungFaelligkeit') }}</option>
        <option value="bezeichnung">{{ t('view.akkutausch.sortierungBezeichnung') }}</option>
      </select>
    </div>

    <table v-if="gefiltert.length > 0" class="data">
      <thead>
        <tr>
          <th>{{ t('view.akkutausch.feldAnlage') }}</th>
          <th>{{ t('view.akkutausch.feldObjekt') }}</th>
          <th>{{ t('view.akkutausch.feldName') }}</th>
          <th>{{ t('view.akkutausch.feldKapazitaet') }}</th>
          <th>{{ t('view.akkutausch.faelligkeit') }}</th>
          <th v-if="auth.istAdmin"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="n in gefiltert" :key="n.id">
          <td>{{ n.anlage }}</td>
          <td>{{ n.objekt }}</td>
          <td>{{ n.name }}</td>
          <td>{{ formatKapazitaet(n.kapazitaetAh, locale) }}</td>
          <td>
            {{ store.faelligkeitVon(n) ? formatDatum(store.faelligkeitVon(n) ?? '', locale) : '—' }}
          </td>
          <td v-if="auth.istAdmin">
            <div class="actions-cell">
              <button type="button" @click="netzteilBearbeiten(n)">
                {{ t('view.akkutausch.bearbeiten') }}
              </button>
              <button type="button" class="danger" @click="loeschen(n)">
                {{ t('view.akkutausch.loeschen') }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else class="empty-state">{{ t('view.akkutausch.keineNetzteile') }}</p>
  </div>
</template>

<style scoped>
.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}
</style>
