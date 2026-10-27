<script setup lang="ts">
// Tab "Netzteile" des Akkutausch-Tools.
//
// Liste der eingebauten Geraete mit Suche, Filter ("faellig im Quartal")
// und Sortierung. Schreibaktionen sind Admin-only — Mitarbeiter sehen
// die Liste nur lesend.

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { formatDatum, formatKapazitaet } from '../../domain/akkutausch/formatierung'
import { quartalVonDatum } from '../../domain/akkutausch/berechnung'
import type { Netzteil } from '../../domain/akkutausch/types'
import { ImportValidierungError } from '../../domain/errors'
import { parseCsv } from '../../services/import/csv-parser'
import {
  defaultNetzteilMapping,
  NETZTEIL_FELD_BESCHREIBUNG,
  type NetzteilFeld,
  type NetzteilMapping,
} from '../../services/import/netzteil-mapping'
import {
  bereiteNetzteilCsvAuf,
  importNetzteileAusCsv,
  pruefeNetzteilImport,
  type NetzteilCsvDaten,
  type NetzteilImportBericht,
  type NetzteilImportPruefung,
} from '../../services/import/netzteil-import'
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

const importOffen = ref(false)
const importDatei = ref<File | null>(null)
const importDaten = ref<NetzteilCsvDaten | null>(null)
const importMapping = ref<NetzteilMapping>({})
const importPruefung = ref<NetzteilImportPruefung | null>(null)
const importBericht = ref<NetzteilImportBericht | null>(null)
const importLaeuft = ref(false)
const importFehler = ref('')

const netzteilFeldOptionen: NetzteilFeld[] = [
  'anlage',
  'objekt',
  'name',
  'einbaudatum',
  'intervallJahre',
  'kapazitaetAh',
  'anzahl',
  'gruppe',
  'plz',
  'vdsAnerkennung',
  'faelligkeit',
]

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

const importValidOk = computed(() => {
  const v = importPruefung.value
  return v ? v.ok : false
})

const importHinweis = computed(() => {
  const v = importPruefung.value
  if (!v) return t('view.akkutausch.netzteilImportValidierung')
  if (!v.ok) return t('view.akkutausch.netzteilImportProbleme', { anzahl: v.probleme.length })
  return t('view.akkutausch.netzteilImportZusammenfassung', {
    anzahl: v.importierbar,
    uebersprungen: v.uebersprungen,
    unvollstaendig: v.unvollstaendig,
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

function importeroeffnen(): void {
  importOffen.value = true
  importDatei.value = null
  importDaten.value = null
  importMapping.value = {}
  importPruefung.value = null
  importBericht.value = null
  importLaeuft.value = false
  importFehler.value = ''
}

function importerSchliessen(): void {
  importOffen.value = false
  importDatei.value = null
  importDaten.value = null
  importMapping.value = {}
  importPruefung.value = null
  importBericht.value = null
  importLaeuft.value = false
  importFehler.value = ''
}

async function importerDateiAendern(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0] ?? null
  importDatei.value = file
  importBericht.value = null
  importFehler.value = ''

  if (!file) {
    importDaten.value = null
    importMapping.value = {}
    importPruefung.value = null
    return
  }

  try {
    const parsedCsv = parseCsv(await file.text())
    if (parsedCsv.headers.length === 0) {
      importDaten.value = null
      importMapping.value = {}
      importPruefung.value = null
      importFehler.value = t('view.akkutausch.netzteilImportKeineSpalten')
      return
    }

    const daten = bereiteNetzteilCsvAuf(parsedCsv.headers, parsedCsv.rows)
    importDaten.value = daten
    importMapping.value = defaultNetzteilMapping(daten.headers)
    validiereNetzteilImport()
  } catch (err) {
    importDaten.value = null
    importMapping.value = {}
    importPruefung.value = null
    importFehler.value = fehlermeldung(err)
  }
}

function validiereNetzteilImport(): void {
  const daten = importDaten.value
  if (!daten) {
    importPruefung.value = null
    return
  }
  importPruefung.value = pruefeNetzteilImport(
    importMapping.value,
    daten.rows,
    daten.headers,
    daten.zeilenOffset,
  )
}

async function importerAusfuehren(): Promise<void> {
  const daten = importDaten.value
  if (!daten) return
  importLaeuft.value = true
  importFehler.value = ''
  try {
    importBericht.value = await importNetzteileAusCsv({
      rows: daten.rows,
      headers: daten.headers,
      mapping: importMapping.value,
      zeilenOffset: daten.zeilenOffset,
    })
  } catch (e) {
    importFehler.value = fehlermeldung(e)
  } finally {
    importLaeuft.value = false
  }
}

function fehlermeldung(e: unknown): string {
  if (e instanceof ImportValidierungError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

watch(
  () => [importDaten.value, importMapping.value],
  () => validiereNetzteilImport(),
  { deep: true },
)
</script>

<template>
  <div class="netzteile-tab">
    <div v-if="auth.istAdmin && !formOffen" class="card">
      <button type="button" class="primary" @click="neuesNetzteil">
        {{ t('view.akkutausch.neuesNetzteil') }}
      </button>
      <button type="button" @click="importeroeffnen">
        {{ t('view.akkutausch.netzteilImportieren') }}
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

    <div v-if="importOffen && !formOffen" class="card">
      <h2 class="card-titel">{{ t('view.akkutausch.netzteilImportTitel') }}</h2>
      <p>{{ t('view.akkutausch.netzteilImportHinweis') }}</p>

      <div class="filter-bar">
        <label>
          <span>{{ t('view.akkutausch.netzteilImportDatei') }}</span>
          <input type="file" accept=".csv,text/csv" @change="importerDateiAendern" />
        </label>
      </div>

      <p v-if="importDatei && importDaten" class="hint">
        {{ importDatei.name }} ({{
          t('view.akkutausch.netzteilImportZeilen', {
            anzahl: importDaten.rows.length,
          })
        }})
        <span v-if="importDaten.hinweis"> — {{ importDaten.hinweis }}</span>
      </p>

      <p v-if="importFehler" class="fehler">{{ importFehler }}</p>

      <div v-if="importDaten" class="card">
        <h3 class="card-titel">{{ t('view.akkutausch.netzteilImportMapping') }}</h3>
        <table class="data">
          <thead>
            <tr>
              <th>{{ t('view.akkutausch.netzteilImportSpalte') }}</th>
              <th>{{ t('view.akkutausch.netzteilImportFeld') }}</th>
              <th>{{ t('view.akkutausch.netzteilImportFormatBedeutung') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in importDaten.headers" :key="h">
              <td>{{ h }}</td>
              <td>
                <select v-model="importMapping[h]">
                  <option :value="null">{{ t('view.akkutausch.netzteilImportIgnorieren') }}</option>
                  <option v-for="f in netzteilFeldOptionen" :key="f" :value="f">{{ f }}</option>
                </select>
              </td>
              <td class="beschreibung">
                <template v-if="importMapping[h]">
                  <div class="format">
                    {{ NETZTEIL_FELD_BESCHREIBUNG[importMapping[h] as NetzteilFeld].format }}
                  </div>
                  <div class="bedeutung">
                    {{ NETZTEIL_FELD_BESCHREIBUNG[importMapping[h] as NetzteilFeld].bedeutung }}
                  </div>
                </template>
                <span v-else>{{ t('view.akkutausch.netzteilImportIgnoriert') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="importDaten" class="hint">{{ importHinweis }}</p>

      <ul v-if="importPruefung && !importPruefung.ok">
        <li v-for="(p, i) in importPruefung.probleme" :key="i">{{ p.meldung }}</li>
      </ul>

      <details v-if="importPruefung && importPruefung.befunde.length" class="befunde">
        <summary>
          {{
            t('view.akkutausch.netzteilImportBefunde', { anzahl: importPruefung.befunde.length })
          }}
        </summary>
        <ul>
          <li
            v-for="(b, i) in importPruefung.befunde"
            :key="i"
            :class="{ fehler: b.art === 'uebersprungen' }"
          >
            {{ b.meldung }}
          </li>
        </ul>
      </details>

      <div class="actions-cell">
        <button
          type="button"
          class="primary"
          :disabled="!importValidOk || importLaeuft"
          @click="importerAusfuehren"
        >
          {{
            importLaeuft
              ? t('view.akkutausch.netzteilImportLaeuft')
              : t('view.akkutausch.netzteilImportAusfuehren')
          }}
        </button>
        <button type="button" :disabled="importLaeuft" @click="validiereNetzteilImport">
          {{ t('view.akkutausch.netzteilImportErneut') }}
        </button>
        <button type="button" :disabled="importLaeuft" @click="importerSchliessen">
          {{ t('view.akkutausch.abbrechen') }}
        </button>
      </div>

      <div v-if="importBericht" class="card">
        <h3 class="card-titel">{{ t('view.akkutausch.netzteilImportErgebnis') }}</h3>
        <ul>
          <li>
            {{
              t('view.akkutausch.netzteilImportAngelegt', {
                anzahl: importBericht.netzteilAngelegt,
              })
            }}
          </li>
          <li>
            {{
              t('view.akkutausch.netzteilImportAktualisiert', {
                anzahl: importBericht.netzteilAktualisiert,
              })
            }}
          </li>
          <li>
            {{
              t('view.akkutausch.netzteilImportUebersprungen', {
                anzahl: importBericht.netzteilUebersprungen,
              })
            }}
          </li>
          <li>
            {{
              t('view.akkutausch.netzteilImportReparierteZeilen', {
                anzahl: importBericht.reparierteZeilen,
              })
            }}
          </li>
          <li>
            {{
              t('view.akkutausch.netzteilImportUebersprungeneZeilen', {
                anzahl: importBericht.uebersprungeneZeilen,
              })
            }}
          </li>
          <li>
            {{
              t('view.akkutausch.netzteilImportUnvollstaendigeZeilen', {
                anzahl: importBericht.unvollstaendigeZeilen,
              })
            }}
          </li>
        </ul>

        <details v-if="importBericht.befunde.length" class="befunde">
          <summary>
            {{
              t('view.akkutausch.netzteilImportBefunde', { anzahl: importBericht.befunde.length })
            }}
          </summary>
          <ul>
            <li
              v-for="(b, i) in importBericht.befunde"
              :key="i"
              :class="{ fehler: b.art === 'uebersprungen' }"
            >
              {{ b.meldung }}
            </li>
          </ul>
        </details>

        <template v-if="importBericht.warnungen.length">
          <h4>{{ t('view.akkutausch.netzteilImportWarnungen') }}</h4>
          <ul>
            <li v-for="(w, i) in importBericht.warnungen" :key="i">{{ w }}</li>
          </ul>
        </template>

        <template v-if="importBericht.konflikte.length">
          <h4>{{ t('view.akkutausch.netzteilImportKonflikte') }}</h4>
          <ul>
            <li v-for="(c, i) in importBericht.konflikte" :key="i">{{ c }}</li>
          </ul>
        </template>
      </div>
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

.beschreibung {
  font-size: 0.85rem;
  color: var(--text-muted);
}

.beschreibung .format {
  color: var(--text);
  font-weight: 500;
}

.beschreibung .bedeutung {
  margin-top: 0.15rem;
}

.befunde {
  margin: 0.5rem 0;
}

.befunde summary {
  cursor: pointer;
  font-weight: 500;
}

.befunde ul {
  max-height: 18rem;
  overflow-y: auto;
  margin-top: 0.5rem;
}
</style>
