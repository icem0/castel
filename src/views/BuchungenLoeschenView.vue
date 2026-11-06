<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '../auth/api'

const { t } = useI18n()

type BulkBuchung = {
  id: string
  artikelId: string
  artikelTitel: string | null
  standortId: string
  standortName: string | null
  typ: string
  menge: number
  erstelltAm: string
  storno: boolean
  projekt: string | null
}

type BulkFilterOptions = {
  artikel: { id: string; titel: string }[]
  standorte: { id: string; name: string }[]
  typen: string[]
  projekte: string[]
}

const bulkFilter = reactive({
  artikelId: '',
  standortId: '',
  typ: '',
  datumVon: '',
  datumBis: '',
  storno: '',
  projekt: '',
})
const bulkBuchungen = ref<BulkBuchung[]>([])
const bulkOptionen = ref<BulkFilterOptions>({
  artikel: [],
  standorte: [],
  typen: [],
  projekte: [],
})
const bulkAuswahl = ref<string[]>([])
const bulkLadePhase = ref<'idle' | 'laufend' | 'fertig' | 'fehler'>('idle')
const bulkLadeFehler = ref<string | null>(null)
const bulkDeletePhase = ref<'idle' | 'bestaetigen' | 'laufend' | 'fertig' | 'fehler'>('idle')
const bulkDeleteFehler = ref<string | null>(null)
const bulkDeleteErfolg = ref<string | null>(null)
const bulkDeleteAnzahl = ref(0)

const bulkAlleAusgewaehlt = computed(
  () =>
    bulkBuchungen.value.length > 0 &&
    bulkBuchungen.value.every((b) => bulkAuswahl.value.includes(b.id)),
)

function bulkFilterBody(): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (bulkFilter.artikelId) body.artikelId = bulkFilter.artikelId
  if (bulkFilter.standortId) body.standortId = bulkFilter.standortId
  if (bulkFilter.typ) body.typ = bulkFilter.typ
  if (bulkFilter.datumVon) body.datumVon = new Date(bulkFilter.datumVon).toISOString()
  if (bulkFilter.datumBis) body.datumBis = new Date(bulkFilter.datumBis).toISOString()
  if (bulkFilter.storno !== '') body.storno = bulkFilter.storno === 'true'
  if (bulkFilter.projekt) body.projekt = bulkFilter.projekt
  return body
}

async function bulkLaden(): Promise<void> {
  bulkLadePhase.value = 'laufend'
  bulkLadeFehler.value = null
  try {
    const res = await apiFetch<{
      buchungen: BulkBuchung[]
      filterOptions: BulkFilterOptions
    }>('/api/admin/buchungen/filter', { method: 'POST', body: bulkFilterBody() })
    bulkBuchungen.value = res.buchungen
    bulkOptionen.value = res.filterOptions
    bulkAuswahl.value = []
    bulkLadePhase.value = 'fertig'
  } catch (e) {
    bulkLadeFehler.value = e instanceof Error ? e.message : String(e)
    bulkLadePhase.value = 'fehler'
  }
}

function bulkAlleUmschalten(): void {
  bulkAuswahl.value = bulkAlleAusgewaehlt.value ? [] : bulkBuchungen.value.map((b) => b.id)
}

function bulkLoeschenFrage(): void {
  if (bulkAuswahl.value.length === 0) return
  bulkDeleteAnzahl.value = bulkAuswahl.value.length
  bulkDeletePhase.value = 'bestaetigen'
  bulkDeleteFehler.value = null
  bulkDeleteErfolg.value = null
}

function bulkLoeschenAbbrechen(): void {
  bulkDeletePhase.value = 'idle'
  bulkDeleteFehler.value = null
}

async function bulkLoeschenBestaetigen(): Promise<void> {
  bulkDeletePhase.value = 'laufend'
  bulkDeleteFehler.value = null
  try {
    const res = await apiFetch<{ deletedCount: number }>('/api/admin/buchungen/bulk-delete', {
      method: 'POST',
      body: { ids: bulkAuswahl.value, bestaetigt: true },
    })
    bulkDeleteErfolg.value = t('view.development.bulkLoeschErgebnis', {
      anzahl: res.deletedCount,
    })
    bulkAuswahl.value = []
    bulkDeletePhase.value = 'fertig'
    await bulkLaden()
  } catch (e) {
    bulkDeleteFehler.value = e instanceof Error ? e.message : String(e)
    bulkDeletePhase.value = 'fehler'
  }
}

function bulkTypLabel(typ: string): string {
  return t(`view.buchung.form.typen.${typ}`)
}

function formatBulkDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => {
  void bulkLaden()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.development.bulkTitel') }}</h1>
      <p class="hint">{{ t('view.development.bulkHint') }}</p>
    </header>

    <div class="card">
      <p class="hint">{{ t('view.development.bulkHint') }}</p>
      <div class="filter-bar">
        <select v-model="bulkFilter.artikelId" :aria-label="t('view.development.bulkArtikel')">
          <option value="">{{ t('view.development.bulkAlleArtikel') }}</option>
          <option v-for="a in bulkOptionen.artikel" :key="a.id" :value="a.id">
            {{ a.titel }}
          </option>
        </select>
        <select v-model="bulkFilter.standortId" :aria-label="t('view.development.bulkStandort')">
          <option value="">{{ t('view.development.bulkAlleStandorte') }}</option>
          <option v-for="s in bulkOptionen.standorte" :key="s.id" :value="s.id">
            {{ s.name }}
          </option>
        </select>
        <select v-model="bulkFilter.typ" :aria-label="t('view.development.bulkTyp')">
          <option value="">{{ t('view.development.bulkAlleTypen') }}</option>
          <option v-for="typ in bulkOptionen.typen" :key="typ" :value="typ">
            {{ bulkTypLabel(typ) }}
          </option>
        </select>
        <select v-model="bulkFilter.storno" :aria-label="t('view.development.bulkStorno')">
          <option value="">{{ t('view.development.bulkStornoAlle') }}</option>
          <option value="false">{{ t('view.development.bulkStornoNein') }}</option>
          <option value="true">{{ t('view.development.bulkStornoJa') }}</option>
        </select>
        <select v-model="bulkFilter.projekt" :aria-label="t('view.development.bulkProjekt')">
          <option value="">{{ t('view.development.bulkAlleProjekte') }}</option>
          <option v-for="p in bulkOptionen.projekte" :key="p" :value="p">{{ p }}</option>
        </select>
        <label class="bulk-datum">
          <span>{{ t('view.development.bulkVon') }}</span>
          <input v-model="bulkFilter.datumVon" type="datetime-local" />
        </label>
        <label class="bulk-datum">
          <span>{{ t('view.development.bulkBis') }}</span>
          <input v-model="bulkFilter.datumBis" type="datetime-local" />
        </label>
        <button type="button" :disabled="bulkLadePhase === 'laufend'" @click="bulkLaden">
          {{
            bulkLadePhase === 'laufend'
              ? t('view.development.bulkLaedt')
              : t('view.development.bulkLaden')
          }}
        </button>
      </div>

      <p v-if="bulkLadeFehler" class="wert-fehler">{{ bulkLadeFehler }}</p>
      <p v-if="bulkLadePhase === 'fertig' && bulkBuchungen.length === 0" class="hint">
        {{ t('view.development.bulkKeine') }}
      </p>

      <template v-if="bulkBuchungen.length > 0">
        <p class="hint">
          {{
            t('view.development.bulkGefunden', {
              anzahl: bulkBuchungen.length,
              ausgewaehlt: bulkAuswahl.length,
            })
          }}
        </p>
        <div class="actions">
          <button type="button" @click="bulkAlleUmschalten">
            {{
              bulkAlleAusgewaehlt
                ? t('view.development.bulkAuswahlAufheben')
                : t('view.development.bulkAlleAuswaehlen')
            }}
          </button>
          <button
            type="button"
            class="danger"
            :disabled="bulkAuswahl.length === 0"
            @click="bulkLoeschenFrage"
          >
            {{ t('view.development.bulkLoeschenBtn', { anzahl: bulkAuswahl.length }) }}
          </button>
        </div>
        <div class="bulk-tabelle">
          <table class="data">
            <thead>
              <tr>
                <th></th>
                <th>{{ t('view.development.bulkSpalteDatum') }}</th>
                <th>{{ t('view.development.bulkSpalteArtikel') }}</th>
                <th>{{ t('view.development.bulkSpalteStandort') }}</th>
                <th>{{ t('view.development.bulkSpalteTyp') }}</th>
                <th>{{ t('view.development.bulkSpalteMenge') }}</th>
                <th>{{ t('view.development.bulkSpalteProjekt') }}</th>
                <th>{{ t('view.development.bulkSpalteStorno') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in bulkBuchungen" :key="b.id">
                <td>
                  <input v-model="bulkAuswahl" type="checkbox" :value="b.id" />
                </td>
                <td>{{ formatBulkDatum(b.erstelltAm) }}</td>
                <td>{{ b.artikelTitel ?? b.artikelId }}</td>
                <td>{{ b.standortName ?? b.standortId }}</td>
                <td>{{ bulkTypLabel(b.typ) }}</td>
                <td class="num" :class="b.menge >= 0 ? 'num-plus' : 'num-minus'">
                  {{ b.menge }}
                </td>
                <td>{{ b.projekt ?? '—' }}</td>
                <td>{{ b.storno ? t('view.development.bulkStornoJa') : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <div v-if="bulkDeletePhase !== 'idle'" class="confirm" role="alertdialog">
      <template v-if="bulkDeletePhase === 'fertig'">
        <p class="hint hint-ok">{{ bulkDeleteErfolg }}</p>
        <p class="hint hint-warn">{{ t('view.development.bulkGeisterWarnung') }}</p>
        <div class="actions">
          <button type="button" @click="bulkLoeschenAbbrechen">
            {{ t('view.development.bulkSchliessen') }}
          </button>
        </div>
      </template>
      <template v-else>
        <p>
          <strong>{{ t('view.development.bulkLoeschFrage', { anzahl: bulkDeleteAnzahl }) }}</strong>
        </p>
        <p class="hint">
          {{ t('view.development.bulkLoeschDetail', { anzahl: bulkDeleteAnzahl }) }}
        </p>
        <p class="hint hint-danger">{{ t('view.development.bulkLoeschWarnung') }}</p>
        <p v-if="bulkDeleteFehler" class="wert-fehler">{{ bulkDeleteFehler }}</p>
        <div class="actions">
          <button
            type="button"
            class="danger"
            :disabled="bulkDeletePhase === 'laufend'"
            @click="bulkLoeschenBestaetigen"
          >
            {{
              bulkDeletePhase === 'laufend'
                ? t('view.development.bulkLoescht')
                : t('view.development.bulkLoeschBestaetigen')
            }}
          </button>
          <button
            type="button"
            :disabled="bulkDeletePhase === 'laufend'"
            @click="bulkLoeschenAbbrechen"
          >
            {{ t('view.common.abbrechen') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.confirm {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.confirm p {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
}
.confirm .hint {
  color: var(--text-muted);
  font-size: 0.78rem !important;
}
.hint-ok {
  color: var(--success);
  font-weight: 600;
}
.wert-fehler {
  color: var(--danger);
  font-weight: 600;
}
.bulk-datum {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--text-muted);
  font-size: 0.78rem;
}
.bulk-tabelle {
  margin-top: 0.75rem;
  overflow-x: auto;
}
</style>
