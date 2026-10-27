<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useArtikelStandortMindestbestandStore } from '../stores/artikelStandortMindestbestand'
import { DEFAULT_AKKU_GROESSEN } from '../domain/akkutausch/defaults'
import { parseKapazitaet, pruefeTypen } from '../domain/akkutausch/berechnung'
import { formatKapazitaet, formatKapazitaetBereich } from '../domain/akkutausch/formatierung'
import type { AkkuTyp } from '../domain/akkutausch/types'
import { neueUuid } from '../domain/ids'
import ArtikelSucheSelect from '../components/ArtikelSucheSelect.vue'

const { t } = useI18n()
const settings = useSettingsStore()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const mindestbestandStore = useArtikelStandortMindestbestandStore()

/** Artikeltyp der automatisch angelegten Akku-Artikel. */
const AKKU_ARTIKEL_TYP = 'Akku'

const locale = computed(() => settings.settings.sprache)
const typen = computed<AkkuTyp[]>(() => settings.settings.akkuTypen)
/** Das Hauptlager (Standard-Standort) — dort wirkt der Mindestbestand. */
const hauptlager = computed(() => standortStore.standardlager)

const neuerVon = ref('1,0')
const neuerBis = ref('1,9')
const neuerNominal = ref('')
const artikelAuswahl = ref('')
const artikelAutomatisch = ref(true)

const fehler = ref('')
const status = ref('')
let statusTimer: ReturnType<typeof setTimeout> | null = null

/** Entwurfswerte der Mindestbestands-Eingabefelder (je Akku-Typ). */
const reserveEntwurf = ref<Record<string, number | null>>({})

onMounted(() => {
  artikelStore.start()
  standortStore.start()
  mindestbestandStore.start()
})

watch(
  () => mindestbestandStore.eintraege,
  () => {
    reserveEntwurf.value = {}
  },
  { deep: true },
)

function statusMeldung(text: string): void {
  status.value = text
  if (statusTimer !== null) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    status.value = ''
    statusTimer = null
  }, 2500)
}

function artikelTitel(von: number, bis: number): string {
  return `Akku ${formatKapazitaetBereich(von, bis, locale.value)}`
}

function artikelZu(typ: AkkuTyp) {
  if (!typ.artikelId) return undefined
  return artikelStore.byId(typ.artikelId)
}

function artikelArchiviert(typ: AkkuTyp): boolean {
  return artikelStore.byId(typ.artikelId ?? '')?.status === 'archiviert'
}

/** Reserve (Mindestbestand am Hauptlager) eines Akku-Typs. */
function reserveWert(typ: AkkuTyp): number {
  const entwurf = reserveEntwurf.value[typ.id]
  if (entwurf !== undefined && entwurf !== null) return entwurf
  if (!typ.artikelId || !hauptlager.value) return 0
  return mindestbestandStore.wertFuer(typ.artikelId, hauptlager.value.id)
}

async function reserveSpeichern(typ: AkkuTyp): Promise<void> {
  const artikelId = typ.artikelId
  const standortId = hauptlager.value?.id
  if (!artikelId || !standortId) return
  const entwurf = reserveEntwurf.value[typ.id]
  const wert = typeof entwurf === 'number' && Number.isFinite(entwurf) ? entwurf : 0
  await mindestbestandStore.setzen(artikelId, standortId, wert)
  statusMeldung(t('view.akkuTypen.mindestbestandGespeichert'))
}

/** Legt einen Akku-Artikel an — der Artikel bleibt normal bearbeitbar. */
async function artikelAnlegen(von: number, bis: number): Promise<string> {
  const artikel = await artikelStore.anlegen({
    titel: artikelTitel(von, bis),
    typ: AKKU_ARTIKEL_TYP,
    verpackungseinheit: 1,
    etikettenNeu: false,
  })
  return artikel.id
}

async function typAnlegen(): Promise<void> {
  fehler.value = ''
  const von = parseKapazitaet(neuerVon.value)
  const bis = parseKapazitaet(neuerBis.value)
  if (von === null || bis === null) {
    fehler.value = t('view.akkuTypen.fehlerKapazitaet')
    return
  }
  const nominalText = neuerNominal.value.trim()
  const nominal = nominalText === '' ? von : parseKapazitaet(nominalText)
  if (nominal === null) {
    fehler.value = t('view.akkuTypen.fehlerKapazitaet')
    return
  }

  const neuerTyp: AkkuTyp = {
    id: neueUuid(),
    kapazitaetAh: nominal,
    von,
    bis,
    artikelId: null,
  }
  const kandidaten = [...typen.value, neuerTyp]
  if (pruefeTypen(kandidaten).length > 0) {
    fehler.value = t('view.akkuTypen.fehlerBereich')
    return
  }

  if (artikelAutomatisch.value) {
    neuerTyp.artikelId = await artikelAnlegen(von, bis)
  } else {
    neuerTyp.artikelId = artikelAuswahl.value === '' ? null : artikelAuswahl.value
  }

  await settings.setAkkuTypen(kandidaten)
  neuerVon.value = '1,0'
  neuerBis.value = '1,9'
  neuerNominal.value = ''
  artikelAuswahl.value = ''
  statusMeldung(t('view.akkuTypen.gespeichert'))
}

async function standardGroessenUebernehmen(): Promise<void> {
  fehler.value = ''
  const fehlend = DEFAULT_AKKU_GROESSEN.filter(
    (d) => !typen.value.some((t) => t.von === d.von && t.bis === d.bis),
  )
  if (fehlend.length === 0) {
    statusMeldung(t('view.akkuTypen.standardBereitsVorhanden'))
    return
  }
  const frage = t('view.akkuTypen.standardFrage', { anzahl: fehlend.length })
  if (!window.confirm(frage)) return

  const neu: AkkuTyp[] = []
  for (const d of fehlend) {
    const artikelId = await artikelAnlegen(d.von, d.bis)
    neu.push({
      id: neueUuid(),
      kapazitaetAh: d.kapazitaetAh,
      von: d.von,
      bis: d.bis,
      artikelId,
    })
  }
  await settings.setAkkuTypen([...typen.value, ...neu])
  statusMeldung(t('view.akkuTypen.gespeichert'))
}

/** Verknüpft einen vorhandenen Artikel mit einem Akku-Typ. */
async function artikelVerknuepfen(typ: AkkuTyp, artikelId: string): Promise<void> {
  const neu = typen.value.map((t) => (t.id === typ.id ? { ...t, artikelId: artikelId || null } : t))
  await settings.setAkkuTypen(neu)
}

/** Legt einen fehlenden Artikel neu an und verknüpft ihn wieder. */
async function artikelNeuAnlegen(typ: AkkuTyp): Promise<void> {
  const artikelId = await artikelAnlegen(typ.von, typ.bis)
  await artikelVerknuepfen(typ, artikelId)
  statusMeldung(t('view.akkuTypen.artikelNeuAngelegt'))
}

async function typEntfernen(typ: AkkuTyp): Promise<void> {
  const frage = t('view.akkuTypen.entfernenFrage', {
    bereich: formatKapazitaetBereich(typ.von, typ.bis, locale.value),
  })
  if (!window.confirm(frage)) return
  await settings.setAkkuTypen(typen.value.filter((t) => t.id !== typ.id))
  statusMeldung(t('view.akkuTypen.gespeichert'))
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.akkuTypen.h1') }}</h1>
    </header>

    <p class="hint">{{ t('view.akkuTypen.hint') }}</p>

    <div v-if="!hauptlager" class="card fehler">
      {{ t('view.akkuTypen.keinHauptlager') }}
    </div>

    <div class="card">
      <h2 class="card-titel">{{ t('view.akkuTypen.neuerTyp') }}</h2>
      <form class="form" @submit.prevent="typAnlegen">
        <div class="form-row">
          <label>
            <span>{{ t('view.akkuTypen.von') }}</span>
            <input v-model="neuerVon" type="text" inputmode="decimal" placeholder="1,0" />
          </label>
          <label>
            <span>{{ t('view.akkuTypen.bis') }}</span>
            <input v-model="neuerBis" type="text" inputmode="decimal" placeholder="1,9" />
          </label>
          <label>
            <span>{{ t('view.akkuTypen.nominal') }}</span>
            <input
              v-model="neuerNominal"
              type="text"
              inputmode="decimal"
              :placeholder="t('view.akkuTypen.nominalLeer')"
            />
          </label>
        </div>

        <label class="check">
          <input v-model="artikelAutomatisch" type="checkbox" />
          <span>{{ t('view.akkuTypen.artikelAutomatisch') }}</span>
        </label>

        <label v-if="!artikelAutomatisch">
          <span>{{ t('view.akkuTypen.artikelAuswahl') }}</span>
          <ArtikelSucheSelect
            v-model="artikelAuswahl"
            :items="artikelStore.artikel.filter((a) => a.status !== 'archiviert')"
          />
        </label>

        <p v-if="fehler" class="fehler">{{ fehler }}</p>

        <div class="form-actions">
          <button type="submit" class="primary">{{ t('view.akkuTypen.anlegen') }}</button>
          <button type="button" @click="standardGroessenUebernehmen">
            {{ t('view.akkuTypen.standardUebernehmen') }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="typen.length > 0" class="card">
      <table class="data">
        <thead>
          <tr>
            <th>{{ t('view.akkuTypen.bereich') }}</th>
            <th>{{ t('view.akkuTypen.nominal') }}</th>
            <th>{{ t('view.akkuTypen.artikel') }}</th>
            <th>{{ t('view.akkuTypen.mindestbestandHauptlager') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="typ in typen" :key="typ.id">
            <td>{{ formatKapazitaetBereich(typ.von, typ.bis, locale) }}</td>
            <td>{{ formatKapazitaet(typ.kapazitaetAh, locale) }}</td>
            <td>
              <RouterLink v-if="artikelZu(typ)" :to="`/artikel/${typ.artikelId}`">
                {{ artikelZu(typ)?.titel }}
              </RouterLink>
              <span v-else-if="!typ.artikelId" class="row-meta">
                {{ t('view.akkuTypen.keinArtikel') }}
              </span>
              <template v-else>
                <span class="fehler">{{ t('view.akkuTypen.artikelFehlt') }}</span>
                <button type="button" class="link-button" @click="artikelNeuAnlegen(typ)">
                  {{ t('view.akkuTypen.artikelNeuAnlegen') }}
                </button>
              </template>
              <span v-if="artikelArchiviert(typ)" class="row-meta">
                {{ t('view.akkuTypen.artikelArchiviert') }}
              </span>
            </td>
            <td>
              <input
                v-if="typ.artikelId && hauptlager"
                v-model.number="reserveEntwurf[typ.id]"
                type="number"
                min="0"
                step="1"
                class="input-kompakt"
                @focus="reserveEntwurf[typ.id] = reserveWert(typ)"
                @change="reserveSpeichern(typ)"
              />
              <span v-else class="row-meta">—</span>
            </td>
            <td>
              <div class="actions-cell">
                <button type="button" class="danger" @click="typEntfernen(typ)">
                  {{ t('view.akkuTypen.entfernen') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else class="empty-state">{{ t('view.akkuTypen.leer') }}</p>

    <p v-if="status" class="status-ok">{{ status }}</p>
  </section>
</template>

<style scoped>
.form-row {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.form-row label {
  flex: 1 1 8rem;
  min-width: 8rem;
}

.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}

.fehler {
  color: var(--danger);
  font-size: 0.9rem;
}

.status-ok {
  color: var(--success);
  font-size: 0.9rem;
}

.input-kompakt {
  width: 6rem;
}

.link-button {
  background: none;
  border: none;
  color: var(--accent, #2563eb);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}

.row-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
}
</style>
