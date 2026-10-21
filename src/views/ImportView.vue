<script setup lang="ts">
// CSV-Import-Wizard für Artikel-Stammdaten.
// Schritt 1: Datei wählen → Schritt 2: Mapping → Schritt 3: Validierung → Schritt 4: Import.
// Bewegungen/Buchungen werden NICHT importiert — sie entstehen in der App.

import { ref, computed, watch } from 'vue'
import { parseCsv, type ParsedCsv } from '../services/import/csv-parser'
import {
  ARTIKEL_FELD_BESCHREIBUNG,
  defaultArtikelMapping,
  type ArtikelFeld,
  type ArtikelMapping,
} from '../services/import/mapping'
import {
  validiereArtikelMapping,
  validiereArtikelDaten,
  type ValidierungsErgebnis,
} from '../services/import/validierung'
import { ImportValidierungError } from '../domain/errors'
import { importArtikelAusCsv, type ImportBericht } from '../services/import/import'

// Schritt 1
const datei = ref<File | null>(null)

const parsed = ref<ParsedCsv | null>(null)
const mapping = ref<ArtikelMapping>({})

const validierung = ref<ValidierungsErgebnis | null>(null)
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

async function onDateiChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null
  datei.value = file
  if (!file) return
  try {
    const text = await file.text()
    const parsedCsv = parseCsv(text)
    if (parsedCsv.headers.length === 0) {
      fehler.value = 'CSV-Datei: keine Spalten erkannt. Ist die Datei eine CSV?'
      datei.value = null
      parsed.value = null
      return
    }
    parsed.value = parsedCsv
    mapping.value = defaultArtikelMapping(parsedCsv.headers)
    bericht.value = null
    fehler.value = ''
  } catch (err) {
    fehler.value = `CSV-Datei konnte nicht gelesen werden: ${
      err instanceof Error ? err.message : String(err)
    }`
    datei.value = null
    parsed.value = null
  }
}

function validieren(): void {
  validierung.value = null
  if (!parsed.value) return
  const mappingCheck = validiereArtikelMapping(
    mapping.value,
    parsed.value.rows,
    parsed.value.headers,
  )
  const datenCheck = validiereArtikelDaten(mapping.value, parsed.value.rows, parsed.value.headers)
  validierung.value = mergeErgebnisse(mappingCheck, datenCheck)
}

function mergeErgebnisse(a: ValidierungsErgebnis, b: ValidierungsErgebnis): ValidierungsErgebnis {
  return { ok: a.ok && b.ok, probleme: [...a.probleme, ...b.probleme] }
}

function fehlermeldung(e: unknown): string {
  if (e instanceof ImportValidierungError) {
    return e.message
  }
  if (e instanceof Error) {
    return e.message
  }
  return String(e)
}

watch(
  () => [parsed.value, mapping.value],
  () => validieren(),
  { deep: true },
)

const validOk = computed(() => {
  const v = validierung.value
  return v ? v.ok : false
})

const importHinweis = computed<string>(() => {
  const v = validierung.value
  if (!v) return 'Validierung: nicht geprüft'
  if (v.ok) return ''
  return `Validierung: ${v.probleme.length} Problem(e)`
})

async function importAusfuehren(): Promise<void> {
  if (!parsed.value) return
  laufend.value = true
  fehler.value = ''
  try {
    bericht.value = await importArtikelAusCsv({
      rows: parsed.value.rows,
      headers: parsed.value.headers,
      mapping: mapping.value,
    })
  } catch (e) {
    fehler.value = fehlermeldung(e)
  } finally {
    laufend.value = false
  }
}
</script>

<template>
  <section class="view">
    <h1>Daten-Import</h1>
    <p>Import von Artikel-Stammdaten aus einer CSV-Datei.</p>

    <h2>1. Datei wählen</h2>
    <div class="row">
      <label>
        <span>CSV-Datei</span>
        <input type="file" accept=".csv,text/csv" @change="onDateiChange" />
        <small v-if="datei" class="hint hint-ok">
          ✓ {{ datei.name }} ({{ parsed?.rowCount ?? 0 }} Zeilen)
        </small>
        <small v-else class="hint hint-warn">noch nicht geladen</small>
      </label>
    </div>

    <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>

    <div v-if="parsed" class="card">
      <h2>2. Mapping</h2>
      <p class="hint">
        Ordne jede Spalte der CSV einem Dexie-Feld zu oder wähle
        <em>— ignorieren —</em>. Spalten ohne Mapping werden nicht importiert.
      </p>
      <table class="data">
        <thead>
          <tr>
            <th>CSV-Spalte</th>
            <th>Dexie-Feld</th>
            <th>Format &amp; Bedeutung</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="h in parsed.headers" :key="h">
            <td>{{ h }}</td>
            <td>
              <select v-model="mapping[h]">
                <option :value="null">— ignorieren —</option>
                <option v-for="f in artikelFeldOptionen" :key="f" :value="f">{{ f }}</option>
              </select>
            </td>
            <td class="beschreibung">
              <template v-if="mapping[h] && mapping[h]">
                <div class="format">
                  {{ ARTIKEL_FELD_BESCHREIBUNG[mapping[h] as ArtikelFeld].format }}
                </div>
                <div class="bedeutung">
                  {{ ARTIKEL_FELD_BESCHREIBUNG[mapping[h] as ArtikelFeld].bedeutung }}
                </div>
              </template>
              <span v-else class="muted">Spalte wird ignoriert</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="parsed" class="actions" :aria-busy="laufend || undefined">
      <button
        type="button"
        :disabled="!validOk || laufend"
        class="primary"
        @click="importAusfuehren"
      >
        {{ laufend ? 'Importiere…' : 'Artikel importieren' }}
      </button>
      <button type="button" :disabled="laufend" @click="validieren">Erneut validieren</button>
      <p v-if="!validOk" class="hint hint-warn">{{ importHinweis }}</p>
    </div>

    <div v-if="validierung" class="validation">
      <h2>3. Validierungs-Report</h2>
      <p v-if="validierung.ok">✓ OK — alle Zeilen sehen importierbar aus.</p>
      <ul v-else>
        <li v-for="(p, i) in validierung.probleme" :key="i">{{ p.meldung }}</li>
      </ul>
    </div>

    <div v-if="bericht" class="report">
      <h2>4. Ergebnis</h2>
      <ul>
        <li>Artikel angelegt: {{ bericht.artikelAngelegt }}</li>
        <li v-if="bericht.konflikte.length">
          Konflikte: {{ bericht.konflikte.length }}
          <ul>
            <li v-for="(c, i) in bericht.konflikte" :key="i">{{ c }}</li>
          </ul>
        </li>
      </ul>
    </div>

    <p class="hint">Offline-first · Keine Cloud-Aufrufe</p>
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
.beschreibung {
  font-size: 0.85rem;
  color: var(--fg-muted);
}
.beschreibung .format {
  color: var(--fg);
  font-weight: 500;
}
.beschreibung .bedeutung {
  margin-top: 0.15rem;
}
.beschreibung .muted {
  color: var(--fg-muted);
  font-style: italic;
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
