<script setup lang="ts">
// Tab "Planung" des Akkutausch-Tools.
//
// Zeigt fuer das gewaehlte Quartal, wie viele Akkus je Groesse getauscht
// werden muessen:
//   soll      = Bedarf (Geraete faellig im Quartal + Projektakkus)
//   bestand   = verfuegbarer Bestand des Akku-Artikels (alle Standorte)
//   reserve   = Mindestbestand am Hauptlager (bleibt liegen)
//   benoetigt = max(0, soll - (bestand - reserve))
//
// Aus der Planung entsteht die Bestellliste (CSV + Druckansicht).

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useArtikelStore } from '../../stores/artikel'
import { useSettingsStore } from '../../stores/settings'
import {
  csvDatei,
  formatKapazitaet,
  formatKapazitaetBereich,
  formatZahl,
} from '../../domain/akkutausch/formatierung'
import type { PlanwarnungCode } from '../../domain/akkutausch/types'

const { t } = useI18n()
const store = useAkkutauschStore()
const artikelStore = useArtikelStore()
const settings = useSettingsStore()

const locale = computed(() => settings.settings.sprache)

const jahre = computed(() => {
  const aktuell = new Date().getFullYear()
  return [aktuell - 2, aktuell - 1, aktuell, aktuell + 1, aktuell + 2]
})

/** Letzter Tag des gewaehlten Quartals (= Stichtag der Planung). */
const stichtag = computed(() => {
  const monat = store.quartal * 3
  const letzterTag = new Date(Date.UTC(store.jahr, monat, 0)).getUTCDate()
  return `${store.jahr}-${String(monat).padStart(2, '0')}-${String(letzterTag).padStart(2, '0')}`
})

/** Akku-Groessen, deren Artikel im Artikelstamm fehlt. */
function artikelFehlt(artikelId: string | null): boolean {
  if (!artikelId) return true
  return artikelStore.byId(artikelId) === undefined
}

/** Labels for the battery data that may still be missing. */
function feldLabel(key: string): string {
  switch (key) {
    case 'einbaudatum':
      return t('view.akkutausch.feldEinbaudatum')
    case 'intervallJahre':
      return t('view.akkutausch.feldIntervall')
    case 'kapazitaetAh':
      return t('view.akkutausch.feldKapazitaet')
    case 'anzahl':
      return t('view.akkutausch.feldAnzahl')
    default:
      return key
  }
}

function warnungText(code: PlanwarnungCode, bezug: string, wert?: string): string {
  switch (code) {
    case 'netzteil_ungueltiges_datum':
      return t('view.akkutausch.warnungDatum', { bezug })
    case 'netzteil_unvollstaendig':
      return t('view.akkutausch.warnungUnvollstaendig', {
        bezug,
        wert: (wert ?? '')
          .split(',')
          .filter((f) => f !== '')
          .map(feldLabel)
          .join(', '),
      })
    case 'netzteil_keine_groesse':
      return t('view.akkutausch.warnungGroesseNetzteil', { bezug, wert })
    case 'projektakku_keine_groesse':
      return t('view.akkutausch.warnungGroesseProjekt', { bezug, wert })
    case 'typ_ohne_artikel':
      return t('view.akkutausch.warnungKeinArtikel', { bezug })
  }
}

const gesamtMenge = computed(() =>
  store.planung.bestellzeilen.reduce((summe, z) => summe + z.menge, 0),
)

function drucken(): void {
  window.print()
}

function csvExportieren(): void {
  const zeilen = store.planung.bestellzeilen.map((z) => [
    formatKapazitaetBereich(z.von, z.bis, locale.value),
    formatZahl(z.kapazitaetAh, locale.value),
    formatZahl(z.menge, locale.value),
  ])
  const csv = csvDatei(zeilen, [
    t('view.akkutausch.csvGroesse'),
    t('view.akkutausch.csvNennkapazitaet'),
    t('view.akkutausch.csvMenge'),
  ])
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `akkutausch-bestellliste-${store.jahr}-q${store.quartal}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="planung-tab">
    <div class="card">
      <div class="filter-bar">
        <label>
          <span>{{ t('view.akkutausch.quartal') }}</span>
          <select v-model.number="store.quartal">
            <option :value="1">{{ t('view.akkutausch.quartal1') }}</option>
            <option :value="2">{{ t('view.akkutausch.quartal2') }}</option>
            <option :value="3">{{ t('view.akkutausch.quartal3') }}</option>
            <option :value="4">{{ t('view.akkutausch.quartal4') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.akkutausch.jahr') }}</span>
          <select v-model.number="store.jahr">
            <option v-for="j in jahre" :key="j" :value="j">{{ j }}</option>
          </select>
        </label>
        <span class="stichtag">{{ t('view.akkutausch.stichtag') }}: {{ stichtag }}</span>
      </div>
    </div>

    <div v-if="store.typen.length === 0" class="card fehler">
      {{ t('view.akkutausch.keineTypen') }}
    </div>

    <div v-if="store.planung.warnungen.length > 0" class="card warn-card">
      <h2 class="card-titel">{{ t('view.akkutausch.warnungen') }}</h2>
      <ul>
        <li v-for="(w, i) in store.planung.warnungen" :key="i">
          {{ warnungText(w.code, w.bezug, w.wert) }}
        </li>
      </ul>
    </div>

    <table v-if="store.typen.length > 0" class="data">
      <thead>
        <tr>
          <th>{{ t('view.akkutausch.groesse') }}</th>
          <th>{{ t('view.akkutausch.soll') }}</th>
          <th>{{ t('view.akkutausch.bestand') }}</th>
          <th>{{ t('view.akkutausch.reserve') }}</th>
          <th>{{ t('view.akkutausch.verfuegbar') }}</th>
          <th>{{ t('view.akkutausch.benoetigt') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="zeile in store.planung.zeilen" :key="zeile.typ.id">
          <td>
            {{ formatKapazitaet(zeile.typ.kapazitaetAh, locale) }}
            <span class="band-hinweis">
              {{ formatKapazitaetBereich(zeile.typ.von, zeile.typ.bis, locale) }}
            </span>
            <span v-if="artikelFehlt(zeile.typ.artikelId)" class="warn-inline">
              {{ t('view.akkutausch.keinArtikelKurz') }}
            </span>
          </td>
          <td>{{ zeile.soll }}</td>
          <td>{{ zeile.bestand }}</td>
          <td>{{ zeile.reserve }}</td>
          <td>{{ zeile.verfuegbar }}</td>
          <td :class="{ 'num-plus': zeile.benoetigt > 0 }">{{ zeile.benoetigt }}</td>
        </tr>
      </tbody>
    </table>

    <div class="card bestellliste">
      <h2 class="card-titel">{{ t('view.akkutausch.bestellliste') }}</h2>
      <table v-if="store.planung.bestellzeilen.length > 0" class="data">
        <thead>
          <tr>
            <th>{{ t('view.akkutausch.groesse') }}</th>
            <th>{{ t('view.akkutausch.nennkapazitaet') }}</th>
            <th>{{ t('view.akkutausch.menge') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="z in store.planung.bestellzeilen" :key="z.typId">
            <td>{{ formatKapazitaetBereich(z.von, z.bis, locale) }}</td>
            <td>{{ formatKapazitaet(z.kapazitaetAh, locale) }}</td>
            <td>{{ z.menge }}</td>
          </tr>
          <tr class="summe-zeile">
            <td colspan="2">{{ t('view.akkutausch.gesamt') }}</td>
            <td>{{ gesamtMenge }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">{{ t('view.akkutausch.keinBedarf') }}</p>

      <div v-if="store.planung.bestellzeilen.length > 0" class="form-actions">
        <button type="button" @click="csvExportieren">{{ t('view.akkutausch.csvExport') }}</button>
        <button type="button" @click="drucken">{{ t('view.akkutausch.drucken') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}

.stichtag {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.warn-card ul {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--warning);
  font-size: 0.9rem;
}

.warn-inline {
  display: block;
  color: var(--warning);
  font-size: 0.8rem;
}

.band-hinweis {
  display: block;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.summe-zeile td {
  font-weight: 600;
}

.fehler {
  color: var(--danger);
}

@media print {
  .planung-tab .card:not(.bestellliste) {
    display: none;
  }

  .bestellliste {
    border: none;
    background: none;
  }
}
</style>
