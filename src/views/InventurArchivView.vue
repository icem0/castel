<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'
import { exportArchivPdf } from '../services/inventur/archiv-pdf'

const { t } = useI18n()
const auth = useAuthStore()

const apiBase = getApiBaseUrl()
const token = jwtLesen() ?? null

const darfLesen = computed(() => auth.hat('inventur.lesen'))
const darfExportieren = computed(() => auth.hat('inventur.export'))

const archivItems = ref<
  Array<{
    id: string
    typ: string
    menge: number
    erstelltAm: string
    kommentar: string | null
    artikelId: string
    standortId: string
    artikelTitel: string | null
    standortName: string | null
    erstelltVon: string | null
    projekt: string | null
    storno: boolean
    storniertDurch: string | null
  }>
>([])
const archivTotal = ref(0)
const archivOffset = ref(0)
const archivLimit = ref(20)
const archivLaden = ref(false)
const archivFehler = ref<string | null>(null)

const filterVon = ref<string>('')
const filterBis = ref<string>('')
const filterTyp = ref<string>('')
const filterProjekt = ref<string>('')
const filterArtikel = ref<string>('')
const filterStandort = ref<string>('')
const filterErstelltVon = ref<string>('')

const pageSizes = [20, 50, 100]

async function archivLadenFunc(offset: number): Promise<void> {
  if (!darfLesen.value) return
  archivLaden.value = true
  archivFehler.value = null
  try {
    const res = await fetch(`${apiBase}/api/inventur/archiv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({
        limit: archivLimit.value,
        offset,
        von: filterVon.value || undefined,
        bis: filterBis.value || undefined,
        typ: filterTyp.value || undefined,
        erstelltVon: filterErstelltVon.value || undefined,
        projekt: filterProjekt.value || undefined,
        artikelId: filterArtikel.value || undefined,
        standortId: filterStandort.value || undefined,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      archivFehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    archivItems.value = offset === 0 ? data.items : [...archivItems.value, ...data.items]
    archivTotal.value = data.total
    archivOffset.value = offset
  } catch (e) {
    archivFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaden.value = false
  }
}

watch(
  [
    filterVon,
    filterBis,
    filterTyp,
    filterProjekt,
    filterArtikel,
    filterStandort,
    filterErstelltVon,
    archivLimit,
  ],
  () => {
    archivLadenFunc(0)
  },
)

function formatDatum(iso: string): string {
  return iso.slice(0, 10)
}

function formatTyp(typ: string): string {
  const map: Record<string, string> = {
    eingang: 'Einzug',
    ausgang: 'Ausgang',
    inventur: 'Inventur',
    storno: 'Storno',
    kommission: 'Kommission',
    umbuchung: 'Umbuchung',
  }
  return map[typ] ?? typ
}

function formatStorno(item: { storno: boolean; storniertDurch: string | null }): string {
  if (!item.storno) return ''
  return item.storniertDurch ? `storniert durch ${item.storniertDurch}` : 'storniert'
}

async function exporteiereCsv(): Promise<void> {
  if (!darfExportieren.value) return
  archivLaden.value = true
  try {
    const res = await fetch(`${apiBase}/api/inventur/archiv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({
        limit: 10000,
        offset: 0,
        von: filterVon.value || undefined,
        bis: filterBis.value || undefined,
        typ: filterTyp.value || undefined,
        erstelltVon: filterErstelltVon.value || undefined,
        projekt: filterProjekt.value || undefined,
        artikelId: filterArtikel.value || undefined,
        standortId: filterStandort.value || undefined,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      archivFehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    const zeilen: string[] = []
    zeilen.push(
      [
        'Datum',
        'Typ',
        'Menge',
        'Artikel',
        'Standort',
        'Kommission / Projekt',
        'Gebucht von',
        'Kommentar',
        'Storno',
      ]
        .map((c) => `"${c}"`)
        .join(';'),
    )
    for (const item of data.items) {
      zeilen.push(
        [
          formatDatum(item.erstelltAm),
          formatTyp(item.typ),
          item.menge,
          item.artikelTitel ?? item.artikelId,
          item.standortName ?? item.standortId,
          item.projekt ?? '',
          item.erstelltVon ?? '',
          (item.kommentar ?? '').replace(/"/g, '""'),
          item.storno ? 'JA' : 'NEIN',
        ]
          .map((c) => `"${c}"`)
          .join(';'),
      )
    }
    const csv = zeilen.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `inventur-archiv-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch (e) {
    archivFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaden.value = false
  }
}

async function exporteierePdf(): Promise<void> {
  if (!darfExportieren.value) return
  archivLaden.value = true
  try {
    const res = await fetch(`${apiBase}/api/inventur/archiv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({
        limit: 10000,
        offset: 0,
        von: filterVon.value || undefined,
        bis: filterBis.value || undefined,
        typ: filterTyp.value || undefined,
        erstelltVon: filterErstelltVon.value || undefined,
        projekt: filterProjekt.value || undefined,
        artikelId: filterArtikel.value || undefined,
        standortId: filterStandort.value || undefined,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      archivFehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    const mitPreise = auth.hat('einkaufspreis')
    await exportArchivPdf(data.items, mitPreise)
  } catch (e) {
    archivFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaden.value = false
  }
}
</script>

<template>
  <div v-if="darfLesen" class="card">
    <h2>{{ t('view.inventurArchiv.archivTitel') }}</h2>
    <p>{{ t('view.inventurArchiv.archivHint') }}</p>

    <div class="archiv-filter">
      <label>{{ t('view.inventurArchiv.filterVon') }}:</label>
      <input v-model="filterVon" type="date" />
      <label>{{ t('view.inventurArchiv.filterBis') }}:</label>
      <input v-model="filterBis" type="date" />
      <label>{{ t('view.inventurArchiv.filterTyp') }}:</label>
      <select v-model="filterTyp">
        <option value="">{{ t('view.inventurArchiv.filterTypAlle') }}</option>
        <option value="eingang">{{ t('view.inventurArchiv.typEingang') }}</option>
        <option value="ausgang">{{ t('view.inventurArchiv.typAusgang') }}</option>
        <option value="inventur">{{ t('view.inventurArchiv.typInventur') }}</option>
        <option value="storno">{{ t('view.inventurArchiv.typStorno') }}</option>
        <option value="kommission">{{ t('view.inventurArchiv.typKommission') }}</option>
        <option value="umbuchung">{{ t('view.inventurArchiv.typUmbuchung') }}</option>
      </select>
      <label>{{ t('view.inventurArchiv.filterProjekt') }}:</label>
      <input
        v-model="filterProjekt"
        type="text"
        :placeholder="t('view.inventurArchiv.filterProjektPh')"
      />
      <label>{{ t('view.inventurArchiv.filterArtikel') }}:</label>
      <input
        v-model="filterArtikel"
        type="text"
        :placeholder="t('view.inventurArchiv.filterArtikelPh')"
      />
      <label>{{ t('view.inventurArchiv.filterStandort') }}:</label>
      <input
        v-model="filterStandort"
        type="text"
        :placeholder="t('view.inventurArchiv.filterStandortPh')"
      />
      <label>{{ t('view.inventurArchiv.filterErstelltVon') }}:</label>
      <input
        v-model="filterErstelltVon"
        type="text"
        :placeholder="t('view.inventurArchiv.filterErstelltVonPh')"
      />
      <span class="separator"></span>
      <label>{{ t('view.inventurArchiv.zeilenProSeite') }}:</label>
      <select v-model="archivLimit">
        <option v-for="s in pageSizes" :key="s" :value="s">{{ s }}</option>
      </select>
      <button type="button" class="btn" :disabled="archivLaden" @click="archivLadenFunc(0)">
        {{ t('view.inventurArchiv.aktualisieren') }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="archivLaden || !darfExportieren"
        @click="exporteiereCsv"
      >
        {{ t('view.inventurArchiv.exportCsv') }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="archivLaden || !darfExportieren"
        @click="exporteierePdf"
      >
        {{ t('view.inventurArchiv.exportPdf') }}
      </button>
    </div>

    <div v-if="archivLaden" class="hint">{{ t('view.inventurArchiv.laedtArchiv') }}</div>
    <div v-if="archivFehler" class="fehler">{{ archivFehler }}</div>

    <div class="archiv-sort">
      {{ t('view.inventurArchiv.sortiert') }}
    </div>

    <table v-if="archivItems.length > 0" class="archiv-tabelle">
      <thead>
        <tr>
          <th>{{ t('view.inventurArchiv.colDatum') }}</th>
          <th>{{ t('view.inventurArchiv.colTyp') }}</th>
          <th>{{ t('view.inventurArchiv.colMenge') }}</th>
          <th>{{ t('view.inventurArchiv.colArtikel') }}</th>
          <th>{{ t('view.inventurArchiv.colStandort') }}</th>
          <th>{{ t('view.inventurArchiv.colKommission') }}</th>
          <th>{{ t('view.inventurArchiv.colGebuchtVon') }}</th>
          <th>{{ t('view.inventurArchiv.colKommentar') }}</th>
          <th>{{ t('view.inventurArchiv.colStorno') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in archivItems" :key="item.id">
          <td>{{ formatDatum(item.erstelltAm) }}</td>
          <td>{{ formatTyp(item.typ) }}</td>
          <td class="zahl">{{ item.menge }}</td>
          <td>{{ item.artikelTitel ?? item.artikelId.slice(0, 8) }}…</td>
          <td>{{ item.standortName ?? item.standortId.slice(0, 8) }}…</td>
          <td>{{ item.projekt ?? '' }}</td>
          <td>{{ item.erstelltVon ?? '' }}</td>
          <td>{{ item.kommentar ?? '' }}</td>
          <td>{{ formatStorno(item) }}</td>
        </tr>
      </tbody>
    </table>

    <div v-if="archivItems.length === 0 && !archivLaden && !archivFehler" class="hint">
      {{ t('view.inventurArchiv.keineEinträge') }}
    </div>

    <div class="archiv-pagination">
      <span>{{
        t('view.inventurArchiv.eintraege', {
          von: archivOffset + 1,
          bis: Math.min(archivOffset + archivItems.length, archivTotal),
          total: archivTotal,
        })
      }}</span>
      <button
        type="button"
        class="btn klein"
        :disabled="archivOffset === 0 || archivLaden"
        @click="archivLadenFunc(Math.max(0, archivOffset - archivLimit))"
      >
        {{ t('view.inventurArchiv.zurueck') }}
      </button>
      <button
        type="button"
        class="btn klein"
        :disabled="archivOffset + archivItems.length >= archivTotal || archivLaden"
        @click="archivLadenFunc(archivOffset + archivLimit)"
      >
        {{ t('view.inventurArchiv.weiter') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.archiv-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.archiv-filter label {
  font-size: 0.9em;
}
.archiv-filter input,
.archiv-filter select {
  font-size: 0.9em;
  padding: 4px 6px;
}
.separator {
  padding: 0 8px;
  color: #666;
}
.archiv-tabelle {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.archiv-tabelle th,
.archiv-tabelle td {
  border: 1px solid #ccc;
  padding: 6px 8px;
  text-align: left;
}
.archiv-tabelle th {
  background: #f5f5f5;
  position: sticky;
  top: 0;
}
.archiv-tabelle td.zahl {
  text-align: right;
}
.archiv-pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 0.9em;
}
.archiv-sort {
  font-size: 0.85em;
  color: #666;
  margin: 8px 0 4px 0;
  font-style: italic;
}
</style>
