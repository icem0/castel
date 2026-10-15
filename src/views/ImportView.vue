<script setup lang="ts">
// CSV-Import-Wizard gemäß PLAN §11.
// Schritt 1: Datei wählen → Schritt 2: Mapping → Schritt 3: Validierung → Schritt 4: Import.

import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { parseCsv, type ParsedCsv } from '../services/import/csv-parser'
import {
  defaultArtikelMapping,
  defaultWarenMapping,
  type ArtikelFeld,
  type ArtikelMapping,
  type WarenFeld,
  type WarenMapping,
} from '../services/import/mapping'
import {
  validiereArtikelMapping,
  validiereWarenMapping,
  type ValidierungsErgebnis,
} from '../services/import/validierung'
import {
  importArtikelAusCsv,
  importWarenAusCsv,
  type ImportBericht,
} from '../services/import/import'
import { exportVollBackup, backupAlsText } from '../services/import/export'

const { t } = useI18n()

// Schritt 1
const lagerDatei = ref<File | null>(null)
const warenDatei = ref<File | null>(null)

const lagerParsed = ref<ParsedCsv | null>(null)
const warenParsed = ref<ParsedCsv | null>(null)
const lagerMapping = ref<ArtikelMapping>({})
const warenMapping = ref<WarenMapping>({})

const validierung = ref<{ lager: ValidierungsErgebnis | null; waren: ValidierungsErgebnis | null }>(
  { lager: null, waren: null },
)
const bericht = ref<ImportBericht | null>(null)
const laufend = ref(false)
const fehler = ref('')

const artikelFeldOptionen: ArtikelFeld[] = [
  'sharePointId',
  'titel',
  'foto',
  'status',
  'typ',
  'lieferant',
  'verpackungseinheit',
  'mindestbestand',
  'nachbestellHinweis',
  'bestellnummer',
  'barcode',
  'listenpreis',
  'geaendertAm',
]
const warenFeldOptionen: WarenFeld[] = [
  'typ',
  'erstelltAm',
  'erstelltVon',
  'menge',
  'kommentar',
  'mitteilungAn',
  'projekt',
  'artikelTitle',
  'standortName',
]

async function onLagerDateiChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null
  lagerDatei.value = file
  if (!file) return
  try {
    const text = await file.text()
    const parsed = parseCsv(text)
    if (parsed.headers.length === 0) {
      fehler.value = 'Lager.csv: keine Spalten erkannt. Ist die Datei eine CSV?'
      lagerDatei.value = null
      lagerParsed.value = null
      return
    }
    lagerParsed.value = parsed
    lagerMapping.value = defaultArtikelMapping(parsed.headers)
    bericht.value = null
    fehler.value = ''
  } catch (err) {
    fehler.value = `Lager.csv konnte nicht gelesen werden: ${
      err instanceof Error ? err.message : String(err)
    }`
    lagerDatei.value = null
    lagerParsed.value = null
  }
}

async function onWarenDateiChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null
  warenDatei.value = file
  if (!file) return
  try {
    const text = await file.text()
    const parsed = parseCsv(text)
    if (parsed.headers.length === 0) {
      fehler.value = 'Warenfluss.csv: keine Spalten erkannt. Ist die Datei eine CSV?'
      warenDatei.value = null
      warenParsed.value = null
      return
    }
    warenParsed.value = parsed
    warenMapping.value = defaultWarenMapping(parsed.headers)
    bericht.value = null
    fehler.value = ''
  } catch (err) {
    fehler.value = `Warenfluss.csv konnte nicht gelesen werden: ${
      err instanceof Error ? err.message : String(err)
    }`
    warenDatei.value = null
    warenParsed.value = null
  }
}

function validieren(): void {
  validierung.value = { lager: null, waren: null }
  if (lagerParsed.value) {
    validierung.value.lager = validiereArtikelMapping(
      lagerMapping.value,
      lagerParsed.value.rows,
      lagerParsed.value.headers,
    )
  }
  if (warenParsed.value) {
    validierung.value.waren = validiereWarenMapping(
      warenMapping.value,
      warenParsed.value.rows,
      warenParsed.value.headers,
    )
  }
}

// Sobald Dateien geladen sind oder das Mapping sich ändert, automatisch validieren.
// Damit muss der User nicht erst auf „Validieren" klicken.
watch(
  () => [lagerParsed.value, warenParsed.value, lagerMapping.value, warenMapping.value],
  () => validieren(),
  { deep: true },
)

const lagerOk = computed(() => {
  const v = validierung.value.lager
  return v ? v.ok : false
})

const warenOk = computed(() => {
  const v = validierung.value.waren
  return v ? v.ok : false
})

const importHinweis = computed<string>(() => {
  const v = validierung.value
  const teile: string[] = []
  if (!v.lager) teile.push('Lager: nicht geprüft')
  else if (!v.lager.ok) teile.push(`Lager: ${v.lager.probleme.length} Problem(e)`)
  if (!v.waren) teile.push('Warenfluss: nicht geprüft')
  else if (!v.waren.ok) teile.push(`Warenfluss: ${v.waren.probleme.length} Problem(e)`)
  if (teile.length === 0) return ''
  return 'Validierung – ' + teile.join(' · ')
})

async function importNurArtikel(): Promise<void> {
  if (!lagerParsed.value) return
  laufend.value = true
  fehler.value = ''
  try {
    bericht.value = await importArtikelAusCsv({
      rows: lagerParsed.value.rows,
      headers: lagerParsed.value.headers,
      mapping: lagerMapping.value,
    })
  } catch (e) {
    fehler.value = String(e)
  } finally {
    laufend.value = false
  }
}

async function importNurWaren(): Promise<void> {
  if (!warenParsed.value) return
  laufend.value = true
  fehler.value = ''
  try {
    bericht.value = await importWarenAusCsv({
      rows: warenParsed.value.rows,
      headers: warenParsed.value.headers,
      mapping: warenMapping.value,
      hauptLagerName: 'Hauptlager',
    })
  } catch (e) {
    fehler.value = String(e)
  } finally {
    laufend.value = false
  }
}

async function backupSpeichern(): Promise<void> {
  const backup = await exportVollBackup()
  const text = backupAlsText(backup)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `castel-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="view">
    <h1>Daten-Import</h1>
    <p>Import aus SharePoint-CSVs (Lager + Warenfluss) oder Backup der aktuellen Daten.</p>

    <h2>1. Dateien wählen</h2>
    <div class="row">
      <label>
        <span>Lager.csv</span>
        <input type="file" accept=".csv,text/csv" @change="onLagerDateiChange" />
        <small v-if="lagerDatei" class="hint hint-ok">
          ✓ {{ lagerDatei.name }} ({{ lagerParsed?.rowCount ?? 0 }} Zeilen)
        </small>
        <small v-else class="hint hint-warn">noch nicht geladen</small>
      </label>
      <label>
        <span>Warenfluss.csv</span>
        <input type="file" accept=".csv,text/csv" @change="onWarenDateiChange" />
        <small v-if="warenDatei" class="hint hint-ok">
          ✓ {{ warenDatei.name }} ({{ warenParsed?.rowCount ?? 0 }} Zeilen)
        </small>
        <small v-else class="hint hint-warn">noch nicht geladen</small>
      </label>
      <button type="button" :disabled="laufend" @click="backupSpeichern">Backup exportieren</button>
    </div>

    <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>

    <div v-if="lagerParsed" class="card">
      <h2>2a. Mapping Lager</h2>
      <table class="data">
        <thead>
          <tr>
            <th>Spalte</th>
            <th>Dexie-Feld</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in lagerParsed.headers" :key="h">
            <td>{{ h }}</td>
            <td>
              <select v-model="lagerMapping[h]">
                <option :value="null">— ignorieren —</option>
                <option v-for="f in artikelFeldOptionen" :key="f" :value="f">{{ f }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="warenParsed" class="card">
      <h2>2b. Mapping Warenfluss</h2>
      <table class="data">
        <thead>
          <tr>
            <th>Spalte</th>
            <th>Dexie-Feld</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in warenParsed.headers" :key="h">
            <td>{{ h }}</td>
            <td>
              <select v-model="warenMapping[h]">
                <option :value="null">— ignorieren —</option>
                <option v-for="f in warenFeldOptionen" :key="f" :value="f">{{ f }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="lagerParsed || warenParsed" class="actions" :aria-busy="laufend || undefined">
      <button
        type="button"
        :disabled="!lagerOk || laufend"
        class="primary"
        @click="importNurArtikel"
      >
        {{ laufend ? 'Importiere…' : 'Artikel importieren' }}
      </button>
      <button type="button" :disabled="!warenOk || laufend" class="primary" @click="importNurWaren">
        {{ laufend ? 'Importiere…' : 'Buchungen importieren' }}
      </button>
      <button type="button" :disabled="laufend" @click="validieren">Erneut validieren</button>
      <p v-if="!(lagerOk && warenOk)" class="hint hint-warn">{{ importHinweis }}</p>
    </div>

    <div v-if="validierung.lager || validierung.waren" class="validation">
      <h2>3. Validierungs-Report</h2>
      <div v-if="validierung.lager">
        <h3>Lager</h3>
        <p v-if="validierung.lager.ok">✓ OK</p>
        <ul v-else>
          <li v-for="(p, i) in validierung.lager.probleme" :key="i">{{ p.meldung }}</li>
        </ul>
      </div>
      <div v-if="validierung.waren">
        <h3>Warenfluss</h3>
        <p v-if="validierung.waren.ok">✓ OK</p>
        <ul v-else>
          <li v-for="(p, i) in validierung.waren.probleme" :key="i">{{ p.meldung }}</li>
        </ul>
      </div>
    </div>

    <div v-if="bericht" class="report">
      <h2>4. Ergebnis</h2>
      <ul>
        <li>Artikel angelegt: {{ bericht.artikelAngelegt }}</li>
        <li>Buchungen angelegt: {{ bericht.buchungenAngelegt }}</li>
        <li v-if="bericht.konflikte.length">
          Konflikte: {{ bericht.konflikte.length }}
          <ul>
            <li v-for="(c, i) in bericht.konflikte" :key="i">{{ c }}</li>
          </ul>
        </li>
      </ul>
    </div>

    <p class="hint">{{ t('app.title') }} · Offline-first · Keine Cloud-Aufrufe</p>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
.row {
  display: flex;
  gap: 1rem;
  align-items: end;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.row label {
  display: grid;
  gap: 0.25rem;
}
.mapping {
  margin: 1rem 0;
}
.validation,
.report {
  margin-top: 1rem;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin: 1rem 0;
  flex-wrap: wrap;
  align-items: center;
}
.actions p {
  margin: 0;
}
</style>
