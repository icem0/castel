<script setup lang="ts">
// Tab "Projektakkus" des Akkutausch-Tools.
//
// Projektbatterien, die fuer ein Quartal bestellt werden. Hinzufuegen darf
// jede Rolle — Bearbeiten und Loeschen bleiben Admins vorbehalten.

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { formatKapazitaet } from '../../domain/akkutausch/formatierung'
import type { Projektakku } from '../../domain/akkutausch/types'
import ProjektakkuForm from './ProjektakkuForm.vue'

const { t } = useI18n()
const store = useAkkutauschStore()
const auth = useAuthStore()
const settings = useSettingsStore()

const locale = computed(() => settings.settings.sprache)
const suche = ref('')
const bearbeitet = ref<Projektakku | null>(null)
const formOffen = ref(false)

const gefiltert = computed(() => {
  const q = suche.value.trim().toLowerCase()
  return store.aktiveProjekte
    .filter((p) => (q === '' ? true : p.projekt.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (a.jahr !== b.jahr) return a.jahr - b.jahr
      if (a.quartal !== b.quartal) return a.quartal - b.quartal
      return a.projekt.localeCompare(b.projekt, locale.value)
    })
})

function neuerProjektakku(): void {
  bearbeitet.value = null
  formOffen.value = true
}

function projektakkuBearbeiten(p: Projektakku): void {
  bearbeitet.value = p
  formOffen.value = true
}

function formSchliessen(): void {
  formOffen.value = false
  bearbeitet.value = null
}

async function speichern(eingabe: Parameters<typeof store.projektSpeichern>[0]): Promise<void> {
  await store.projektSpeichern(eingabe)
  formSchliessen()
}

async function loeschen(p: Projektakku): Promise<void> {
  const frage = t('view.akkutausch.projektLoeschenFrage', { projekt: p.projekt })
  if (!window.confirm(frage)) return
  await store.projektLoeschen(p.id)
}
</script>

<template>
  <div class="projekt-tab">
    <div v-if="!formOffen" class="card">
      <button type="button" class="primary" @click="neuerProjektakku">
        {{ t('view.akkutausch.neuerProjektakku') }}
      </button>
    </div>

    <div v-if="formOffen" class="card">
      <h2 class="card-titel">
        {{ bearbeitet ? t('view.akkutausch.projektBearbeiten') : t('view.akkutausch.projektNeu') }}
      </h2>
      <ProjektakkuForm
        :projektakku="bearbeitet"
        :typen="store.typen"
        :locale="locale"
        @save="speichern"
        @cancel="formSchliessen"
      />
    </div>

    <div class="filter-bar">
      <input v-model="suche" type="search" :placeholder="t('view.akkutausch.projektSuche')" />
    </div>

    <table v-if="gefiltert.length > 0" class="data">
      <thead>
        <tr>
          <th>{{ t('view.akkutausch.feldProjekt') }}</th>
          <th>{{ t('view.akkutausch.feldArtAh') }}</th>
          <th>{{ t('view.akkutausch.feldMenge') }}</th>
          <th>{{ t('view.akkutausch.feldQuartal') }}</th>
          <th>{{ t('view.akkutausch.feldJahr') }}</th>
          <th v-if="auth.istAdmin"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in gefiltert" :key="p.id">
          <td>{{ p.projekt }}</td>
          <td>{{ formatKapazitaet(p.artAh, locale) }}</td>
          <td>{{ p.menge }}</td>
          <td>{{ p.quartal }}</td>
          <td>{{ p.jahr }}</td>
          <td v-if="auth.istAdmin">
            <div class="actions-cell">
              <button type="button" @click="projektakkuBearbeiten(p)">
                {{ t('view.akkutausch.bearbeiten') }}
              </button>
              <button type="button" class="danger" @click="loeschen(p)">
                {{ t('view.akkutausch.loeschen') }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-else class="empty-state">{{ t('view.akkutausch.keineProjektakkus') }}</p>
  </div>
</template>

<style scoped>
.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}
</style>
