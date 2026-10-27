<script setup lang="ts">
// Formular fuer ein eingebautes Netzteil (Akkutausch).
//
// Live-Berechnungen:
//   - "Erkannte Groesse": die Akku-Groesse, in die die eingegebene
//     Kapazitaet faellt (aus den konfigurierten `akkuTypen`).
//   - "Faelligkeit": Einbaudatum + Wechselintervall (Monatsende wird
//     geklemmt, 29.02. + 1 Jahr = 28.02.).
//
// Das Speichern macht der Eltern-Tab (der Store kennt die Outbox).

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  faelligkeit,
  parseDatum,
  parseKapazitaet,
  typFuerKapazitaet,
} from '../../domain/akkutausch/berechnung'
import {
  formatDatum,
  formatKapazitaet,
  formatKapazitaetBereich,
} from '../../domain/akkutausch/formatierung'
import type { AkkuTyp, Netzteil } from '../../domain/akkutausch/types'
import type { NetzteilEingabe } from '../../stores/akkutausch'

const props = defineProps<{
  /** Zu bearbeitendes Netzteil — leer = Neuanlage. */
  netzteil?: Netzteil | null
  /** Konfigurierte Akku-Groessen (fuer die Live-Erkennung). */
  typen: readonly AkkuTyp[]
  /** Locale fuer Zahlen/Datum. */
  locale: string
}>()

const emit = defineEmits<{
  (e: 'save', eingabe: NetzteilEingabe): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

const anlage = ref('')
const objekt = ref('')
const name = ref('')
const einbaudatum = ref('')
const intervall = ref('5')
const kapazitaet = ref('')
const anzahl = ref('1')
const gruppe = ref('')
const plz = ref('')
const vdsAnerkennung = ref('')
const bemerkung = ref('')
const fehler = ref('')

function fuelleFormular(): void {
  const n = props.netzteil
  anlage.value = n?.anlage ?? ''
  objekt.value = n?.objekt ?? ''
  name.value = n?.name ?? ''
  einbaudatum.value = n?.einbaudatum ?? ''
  intervall.value = n ? String(n.intervallJahre) : '5'
  kapazitaet.value = n ? String(n.kapazitaetAh) : ''
  anzahl.value = n ? String(n.anzahl) : '1'
  gruppe.value = n?.gruppe ?? ''
  plz.value = n?.plz ?? ''
  vdsAnerkennung.value = n?.vdsAnerkennung ?? ''
  bemerkung.value = n?.bemerkung ?? ''
  fehler.value = ''
}

watch(() => props.netzteil, fuelleFormular, { immediate: true })

/** Die Akku-Groesse, in die die eingegebene Kapazitaet faellt. */
const erkannteGroesse = computed(() => {
  const wert = parseKapazitaet(kapazitaet.value)
  if (wert === null) return null
  return typFuerKapazitaet(wert, props.typen)
})

/** Faelligkeit des Akkutausches (ISO-Datum) oder `null`. */
const faellig = computed(() => {
  const jahre = Number(intervall.value)
  if (!Number.isFinite(jahre) || jahre <= 0) return null
  return faelligkeit(einbaudatum.value, jahre)
})

function speichern(): void {
  fehler.value = ''
  const kapazitaetWert = parseKapazitaet(kapazitaet.value)
  if (kapazitaetWert === null) {
    fehler.value = t('view.akkutausch.fehlerKapazitaet')
    return
  }
  const datum = parseDatum(einbaudatum.value)
  if (!datum) {
    fehler.value = t('view.akkutausch.fehlerDatum')
    return
  }
  const intervallWert = Number(intervall.value)
  if (!Number.isFinite(intervallWert) || intervallWert < 1) {
    fehler.value = t('view.akkutausch.fehlerIntervall')
    return
  }
  const anzahlWert = Number(anzahl.value)
  if (!Number.isFinite(anzahlWert) || anzahlWert < 1) {
    fehler.value = t('view.akkutausch.fehlerAnzahl')
    return
  }
  if (anlage.value.trim() === '' || objekt.value.trim() === '' || name.value.trim() === '') {
    fehler.value = t('view.akkutausch.fehlerPflichtfelder')
    return
  }

  emit('save', {
    id: props.netzteil?.id,
    anlage: anlage.value.trim(),
    objekt: objekt.value.trim(),
    name: name.value.trim(),
    einbaudatum: datum,
    intervallJahre: Math.trunc(intervallWert),
    kapazitaetAh: kapazitaetWert,
    anzahl: Math.trunc(anzahlWert),
    gruppe: gruppe.value.trim() === '' ? null : gruppe.value.trim(),
    plz: plz.value.trim() === '' ? null : plz.value.trim(),
    vdsAnerkennung: vdsAnerkennung.value.trim() === '' ? null : vdsAnerkennung.value.trim(),
    bemerkung: bemerkung.value.trim() === '' ? null : bemerkung.value.trim(),
  })
}
</script>

<template>
  <form class="form netzteil-form" @submit.prevent="speichern">
    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldAnlage') }}</span>
        <input v-model="anlage" type="text" autocomplete="off" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldObjekt') }}</span>
        <input v-model="objekt" type="text" autocomplete="off" required />
      </label>
    </div>

    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldName') }}</span>
        <input v-model="name" type="text" autocomplete="off" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldGruppe') }}</span>
        <input v-model="gruppe" type="text" autocomplete="off" />
      </label>
    </div>

    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldEinbaudatum') }}</span>
        <input v-model="einbaudatum" type="date" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldIntervall') }}</span>
        <input v-model="intervall" type="number" min="1" step="1" required />
      </label>
    </div>

    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldKapazitaet') }}</span>
        <input v-model="kapazitaet" type="text" inputmode="decimal" placeholder="12,5" required />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldAnzahl') }}</span>
        <input v-model="anzahl" type="number" min="1" step="1" required />
      </label>
    </div>

    <p class="hinweis">
      <span>{{ t('view.akkutausch.erkannteGroesse') }}:</span>
      <strong v-if="erkannteGroesse">
        {{ formatKapazitaet(erkannteGroesse.kapazitaetAh, locale) }}
        ({{ formatKapazitaetBereich(erkannteGroesse.von, erkannteGroesse.bis, locale) }})
      </strong>
      <span v-else class="warn-text">{{ t('view.akkutausch.keineGroesse') }}</span>
      <span class="trenner">·</span>
      <span>{{ t('view.akkutausch.faelligkeit') }}:</span>
      <strong v-if="faellig">{{ formatDatum(faellig, locale) }}</strong>
      <span v-else class="warn-text">—</span>
    </p>

    <div class="form-row">
      <label>
        <span>{{ t('view.akkutausch.feldPlz') }}</span>
        <input v-model="plz" type="text" inputmode="numeric" autocomplete="off" />
      </label>
      <label>
        <span>{{ t('view.akkutausch.feldVds') }}</span>
        <input v-model="vdsAnerkennung" type="text" autocomplete="off" />
      </label>
    </div>

    <label>
      <span>{{ t('view.akkutausch.feldBemerkung') }}</span>
      <textarea v-model="bemerkung" rows="2"></textarea>
    </label>

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
  flex: 1 1 10rem;
  min-width: 10rem;
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

.trenner {
  margin: 0 0.35rem;
}
</style>
