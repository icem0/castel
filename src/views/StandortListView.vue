<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStandortStore } from '../stores/standort'
import type { StandortTyp } from '../db/types'

const { t } = useI18n()
const standortStore = useStandortStore()

interface Form {
  name: string
  typ: StandortTyp
  projekt: string
}

const leeresFormular = (): Form => ({
  name: '',
  typ: 'lager',
  projekt: '',
})

const formularOffen = ref(false)
const formular = ref<Form>(leeresFormular())
const fehler = ref('')
const laufend = ref(false)

function reset(): void {
  formular.value = leeresFormular()
  fehler.value = ''
}

async function anlegen(): Promise<void> {
  if (laufend.value) return
  fehler.value = ''
  if (!formular.value.name.trim()) {
    fehler.value = 'Name fehlt.'
    return
  }
  laufend.value = true
  try {
    await standortStore.anlegen({
      name: formular.value.name.trim(),
      typ: formular.value.typ,
      projekt: formular.value.projekt.trim() || null,
    })
    formularOffen.value = false
    reset()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

async function setStandard(id: string): Promise<void> {
  try {
    await standortStore.setStandard(id)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function archivieren(id: string): Promise<void> {
  if (!confirm('Archivieren?')) return
  try {
    await standortStore.archivieren(id)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function wiederherstellen(id: string): Promise<void> {
  try {
    await standortStore.wiederherstellen(id)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function loeschen(id: string): Promise<void> {
  if (!confirm('Standort unwiderruflich löschen?')) return
  try {
    await standortStore.loeschen(id)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

const typOptionen: StandortTyp[] = ['lager', 'auto', 'baustelle', 'extern']
const sichtbareStandorte = computed(() => [...standortStore.aktive, ...standortStore.archivierte])
const istLeer = computed(() => sichtbareStandorte.value.length === 0 && !formularOffen.value)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.standort.h1') }}</h1>
      <button type="button" class="primary" @click="formularOffen = !formularOffen">
        {{ formularOffen ? t('view.common.abbrechen') : t('view.standort.neu') }}
      </button>
    </header>

    <div v-if="formularOffen" class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="anlegen">
        <label>
          <span>{{ t('view.standort.form.name') }}</span>
          <input v-model="formular.name" required autocomplete="off" :disabled="laufend" />
        </label>
        <label>
          <span>{{ t('view.standort.form.typ') }}</span>
          <select v-model="formular.typ" :disabled="laufend">
            <option v-for="opt in typOptionen" :key="opt" :value="opt">
              {{ t(`view.standort.typen.${opt}`) }}
            </option>
          </select>
        </label>
        <label>
          <span>{{ t('view.standort.form.kommission') }}</span>
          <input v-model="formular.projekt" autocomplete="off" :disabled="laufend" />
        </label>

        <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>

        <div class="form-actions">
          <button type="submit" class="primary" :disabled="!formular.name.trim() || laufend">
            {{ laufend ? '…' : t('view.standort.form.speichern') }}
          </button>
          <button type="button" :disabled="laufend" @click="((formularOffen = false), reset())">
            {{ t('view.standort.form.abbrechen') }}
          </button>
        </div>
      </form>
    </div>

    <p v-if="fehler && !formularOffen" class="fehler" role="alert">{{ fehler }}</p>

    <p v-if="istLeer" class="empty-state">
      {{ t('view.standort.leer') }}
    </p>

    <table v-if="!istLeer" class="data">
      <thead>
        <tr>
          <th>{{ t('view.standort.spalten.name') }}</th>
          <th>{{ t('view.standort.spalten.typ') }}</th>
          <th>{{ t('view.standort.spalten.kommission') }}</th>
          <th>{{ t('view.standort.spalten.standard') }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in sichtbareStandorte" :key="s.id" :class="{ archived: s.archiviert }">
          <td>{{ s.name }}</td>
          <td>
            <span class="badge">{{ t(`view.standort.typen.${s.typ}`) }}</span>
          </td>
          <td>{{ s.projekt ?? '—' }}</td>
          <td>
            <span v-if="s.standard" class="badge accent">{{ t('view.common.ja') }}</span>
            <span v-else class="muted">{{ t('view.common.nein') }}</span>
          </td>
          <td class="actions-cell">
            <button v-if="!s.archiviert && !s.standard" type="button" @click="setStandard(s.id)">
              {{ t('view.standort.spalten.standard') }}
            </button>
            <button v-if="!s.archiviert" type="button" @click="archivieren(s.id)">
              {{ t('view.artikel.detail.archivieren') }}
            </button>
            <button v-if="!s.archiviert" type="button" class="danger" @click="loeschen(s.id)">
              {{ t('view.standort.loeschen') }}
            </button>
            <button v-else type="button" @click="wiederherstellen(s.id)">
              {{ t('view.standort.wiederherstellen') }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.data tr.archived td {
  color: var(--text-muted, #888);
  text-decoration: line-through;
}
</style>
