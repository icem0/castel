<script setup lang="ts">
// Formular fuer einen Projektakku (Akkutausch).
//
// Projektakkus werden fuer ein Quartal bestellt: Projekt, Menge, Akku-Art
// in Ah, Quartal und Jahr. Das Speichern macht der Eltern-Tab.

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseKapazitaet, typFuerKapazitaet } from '../../domain/akkutausch/berechnung'
import { formatKapazitaet } from '../../domain/akkutausch/formatierung'
import type { AkkuTyp, Projektakku } from '../../domain/akkutausch/types'
import type { ProjektakkuEingabe } from '../../stores/akkutausch'

const props = defineProps<{
  /** Zu bearbeitender Projektakku — leer = Neuanlage. */
  projektakku?: Projektakku | null
  /** Konfigurierte Akku-Groessen (fuer die Live-Erkennung). */
  typen: readonly AkkuTyp[]
  /** Locale fuer Zahlen. */
  locale: string
}>()

const emit = defineEmits<{
  (e: 'save', eingabe: ProjektakkuEingabe): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

const projekt = ref('')
const menge = ref('1')
const artAh = ref('')
const quartal = ref(
  String(
    new Date().getMonth() < 3
      ? 1
      : new Date().getMonth() < 6
        ? 2
        : new Date().getMonth() < 9
          ? 3
          : 4,
  ),
)
const jahr = ref(String(new Date().getFullYear()))
const fehler = ref('')

function fuelleFormular(): void {
  const p = props.projektakku
  projekt.value = p?.projekt ?? ''
  menge.value = p ? String(p.menge) : '1'
  artAh.value = p ? String(p.artAh) : ''
  quartal.value = p ? String(p.quartal) : quartal.value
  jahr.value = p ? String(p.jahr) : jahr.value
  fehler.value = ''
}

watch(() => props.projektakku, fuelleFormular, { immediate: true })

/** Die Akku-Groesse, in die die eingegebene Art faellt. */
const erkannteGroesse = computed(() => {
  const wert = parseKapazitaet(artAh.value)
  if (wert === null) return null
  return typFuerKapazitaet(wert, props.typen)
})

function speichern(): void {
  fehler.value = ''
  const artWert = parseKapazitaet(artAh.value)
  if (artWert === null) {
    fehler.value = t('view.akkutausch.fehlerKapazitaet')
    return
  }
  const mengeWert = Number(menge.value)
  if (!Number.isFinite(mengeWert) || mengeWert < 1) {
    fehler.value = t('view.akkutausch.fehlerAnzahl')
    return
  }
  const quartalWert = Number(quartal.value)
  if (!Number.isFinite(quartalWert) || quartalWert < 1 || quartalWert > 4) {
    fehler.value = t('view.akkutausch.fehlerQuartal')
    return
  }
  const jahrWert = Number(jahr.value)
  if (!Number.isFinite(jahrWert) || jahrWert < 2000 || jahrWert > 2100) {
    fehler.value = t('view.akkutausch.fehlerJahr')
    return
  }
  if (projekt.value.trim() === '') {
    fehler.value = t('view.akkutausch.fehlerProjekt')
    return
  }

  emit('save', {
    id: props.projektakku?.id,
    projekt: projekt.value.trim(),
    menge: Math.trunc(mengeWert),
    artAh: artWert,
    quartal: Math.trunc(quartalWert),
    jahr: Math.trunc(jahrWert),
  })
}
</script>

<template>
  <form class="form projekt-form" @submit.prevent="speichern">
    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldProjekt') }}</span>
        <input v-model="projekt" type="text" autocomplete="off" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldMenge') }}</span>
        <input v-model="menge" type="number" min="1" step="1" required />
      </label>
    </div>

    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldArtAh') }}</span>
        <input v-model="artAh" type="text" inputmode="decimal" placeholder="100" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldQuartal') }}</span>
        <select v-model="quartal">
          <option value="1">{{ t('view.akkutausch.quartal1') }}</option>
          <option value="2">{{ t('view.akkutausch.quartal2') }}</option>
          <option value="3">{{ t('view.akkutausch.quartal3') }}</option>
          <option value="4">{{ t('view.akkutausch.quartal4') }}</option>
        </select>
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldJahr') }}</span>
        <input v-model="jahr" type="number" min="2000" max="2100" step="1" required />
      </label>
    </div>

    <p class="hinweis">
      <span>{{ t('view.akkutausch.erkannteGroesse') }}:</span>
      <strong v-if="erkannteGroesse">
        {{ formatKapazitaet(erkannteGroesse.kapazitaetAh, locale) }}
      </strong>
      <span v-else class="warn-text">{{ t('view.akkutausch.keineGroesse') }}</span>
    </p>

    <p v-if="fehler" class="fehler">{{ fehler }}</p>

    <div class="form-actions">
      <button type="submit" class="primary">{{ t('view.akkutausch.speichern') }}</button>
      <button type="button" @click="emit('cancel')">{{ t('view.akkutausch.abbrechen') }}</button>
    </div>
  </form>
</template>

<style scoped>
.form-row {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.form-row label {
  flex: 1 1 9rem;
  min-width: 9rem;
}

.hinweis {
  margin: 0;
  font-size: 0.9rem;
  color: var(--text-muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: baseline;
}

.warn-text {
  color: var(--warning);
}
</style>
