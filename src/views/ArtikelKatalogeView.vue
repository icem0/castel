<script setup lang="ts">
// Hersteller-Kataloge (DATANORM) unter Einstellungen → Stammdaten.
//
// Drei Bereiche:
// 1. „Katalog durchsuchen" (alle angemeldeten User): Lieferant wählen,
//    suchen, Treffer anklicken → vorbefülltes Artikelformular.
// 2. „Katalog-Datei hochladen" (nur Admin): DATANORM-Datei hochladen,
//    Fortschritt per SSE verfolgen, Import-Historie.
// 3. „Lieferanten verwalten" (nur Admin): Lieferant anlegen, aktiv schalten.
//
// Der Katalog bleibt Server-Sache (bis zu 50k+ Zeilen pro Lieferant); die
// PWA holt nur Treffer auf Abruf. Deshalb ist die Seite online-only — der
// Offline-Zustand wird offen benannt statt mit leeren Treffern zu täuschen.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { ApiError } from '../auth/api'
import type {
  HerstellerArtikel,
  Lieferant,
  LookupAntwort,
  DatanormFormat,
} from '../services/datanorm/lookup'
import { ladeLieferanten, sucheHerstellerArtikel } from '../services/datanorm/lookup'
import {
  anlageLieferant,
  ladeImporte,
  patchLieferant,
  uploadDatanormDatei,
  type DatanormImportZeile,
  type DatanormUploadErgebnis,
} from '../services/datanorm/admin'

const { t, locale } = useI18n()
const router = useRouter()
const auth = useAuthStore()

// ---------------------------------------------------------------------------
// Katalog-Browser (alle User)
// ---------------------------------------------------------------------------

const lieferanten = ref<Lieferant[]>([])
const lieferantId = ref('')
const suchbegriff = ref('')
const treffer = ref<HerstellerArtikel[]>([])
const anzahlTreffer = ref(0)
const gesucht = ref(false)
const laedt = ref(false)
const laedtLieferanten = ref(false)
const fehler = ref('')

const gewaehlterLieferant = computed(
  () => lieferanten.value.find((l) => l.id === lieferantId.value) ?? null,
)

/**
 * Hands the catalogue entry to the article form as prefilled fields.
 *
 * Deliberately not a direct create: the article form is where the user
 * decides on type, packaging unit and status — those are castel-internal
 * concepts a supplier catalogue does not know anything about.
 */
function hinzufuegen(art: HerstellerArtikel): void {
  const preisCent = art.preisNettoCent ?? art.preisBruttoCent
  void router.push({
    name: 'artikel-neu',
    query: {
      katTitel: art.titel,
      katEan: art.ean ?? '',
      katMatchcode: art.matchcode,
      katPreis: preisCent !== null ? String(preisCent / 100) : '',
      katLieferant: gewaehlterLieferant.value?.name ?? '',
    },
  })
}

async function suchen(): Promise<void> {
  if (!lieferantId.value) return
  laedt.value = true
  gesucht.value = true
  fehler.value = ''
  try {
    const antwort: LookupAntwort = await sucheHerstellerArtikel({
      lieferantId: lieferantId.value,
      q: suchbegriff.value.trim() || undefined,
      limit: 25,
      inklDeaktivierte: true,
    })
    treffer.value = antwort.treffer
    anzahlTreffer.value = antwort.total
  } catch (e) {
    treffer.value = []
    anzahlTreffer.value = 0
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laedt.value = false
  }
}

// ---------------------------------------------------------------------------
// Upload (Admin)
// ---------------------------------------------------------------------------

const uploadFile = ref<File | null>(null)
const uploadLieferantId = ref('')
const uploadEncoding = ref<'utf-8' | 'cp850' | 'windows-1252' | ''>('')
/**
 * DATANORM format of the file.
 *
 * 'auto' reads the version from the Vorlaufsatz (or the field count of the
 * first A record). 'v4'/'v5' force it — the escape hatch for suppliers
 * whose export deviates from the standard.
 */
const uploadFormat = ref<DatanormFormat>('auto')
const uploadLaufend = ref(false)
/** Latest SSE tick, mirrored from the server's ImportFortschritt. */
const fortschritt = ref<{ phase: string; prozent: number; hinweis: string } | null>(null)
const uploadFehler = ref('')
const uploadFertig = ref<string | null>(null)
/** Result of the last upload (the server response). */
const uploadErgebnis = ref<DatanormUploadErgebnis | null>(null)

const prozentFortschritt = computed(() => fortschritt.value?.prozent ?? 0)

/** One-line summary of the last import. */
const ergebnisText = computed(() => {
  const e = uploadErgebnis.value
  if (!e) return ''
  if (e.status === 'duplikat') return t('view.artikelKataloge.importDuplikat')
  if (e.status === 'teilfehler') {
    return t('view.artikelKataloge.importTeilfehler', {
      anzahl: e.artikelAnzahl,
      fehler: e.fehlerAnzahl,
    })
  }
  return t('view.artikelKataloge.importErfolg', {
    anzahl: e.artikelAnzahl,
    neu: e.neu,
    aktualisiert: e.aktualisiert,
  })
})

/** Localised label for the status column of the import history. */
function statusText(status: string): string {
  switch (status) {
    case 'erfolg':
      return t('view.artikelKataloge.statusErfolg')
    case 'teilfehler':
      return t('view.artikelKataloge.statusTeilfehler')
    case 'fehler':
      return t('view.artikelKataloge.statusFehler')
    case 'duplikat':
      return t('view.artikelKataloge.statusDuplikat')
    case 'gestartet':
      return t('view.artikelKataloge.statusGestartet')
    default:
      return status
  }
}

/** Turns an upload error into a message the admin can act on. */
function uploadFehlerText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 413) return `${t('view.artikelKataloge.uploadZuGross')} (${e.message})`
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

let eventSource: EventSource | null = null

function schliesseEventSource(): void {
  eventSource?.close()
  eventSource = null
}

async function uploadStarten(): Promise<void> {
  if (!uploadFile.value || !uploadLieferantId.value) return
  schliesseEventSource()
  uploadLaufend.value = true
  fortschritt.value = null
  uploadFehler.value = ''
  uploadFertig.value = null
  uploadErgebnis.value = null
  try {
    const ergebnis = await uploadDatanormDatei(
      uploadFile.value,
      uploadLieferantId.value,
      uploadEncoding.value === '' ? undefined : uploadEncoding.value,
      uploadFormat.value,
    )
    // The import runs inline on the server: the response IS the result.
    // The UI must not wait for an SSE event to unblock — otherwise the
    // button stays on "…" forever whenever the stream does not deliver
    // its closing event.
    uploadLaufend.value = false
    uploadErgebnis.value = ergebnis
    if (ergebnis.status === 'fehler') {
      uploadFehler.value = t('view.artikelKataloge.importFehlgeschlagen')
    } else {
      uploadFertig.value = ergebnis.importId
    }
    void ladeImporteListe()
    // SSE for the progress ticks and the final confirmation.
    if (eventSource === null) {
      eventSource = new EventSource(`/api/datanorm/import/${ergebnis.importId}/progress`)
      eventSource.addEventListener('fortschritt', (e) => {
        const d = JSON.parse((e as MessageEvent<string>).data) as {
          phase?: string
          verarbeitet?: number
          gesamt?: number
          hinweis?: string
        }
        const gesamt = d.gesamt ?? 0
        fortschritt.value = {
          phase: d.phase ?? '',
          prozent: gesamt > 0 ? Math.round(((d.verarbeitet ?? 0) / gesamt) * 100) : 0,
          hinweis: d.hinweis ?? '',
        }
      })
      eventSource.addEventListener('abschluss', () => {
        schliesseEventSource()
        uploadLaufend.value = false
        void ladeImporteListe()
      })
      eventSource.onerror = () => {
        schliesseEventSource()
        uploadLaufend.value = false
      }
    }
  } catch (e) {
    uploadLaufend.value = false
    uploadFehler.value = uploadFehlerText(e)
  }
}

function uploadZuruecksetzen(): void {
  schliesseEventSource()
  uploadFile.value = null
  uploadLieferantId.value = ''
  uploadEncoding.value = ''
  uploadLaufend.value = false
  fortschritt.value = null
  uploadFehler.value = ''
  uploadFertig.value = null
  uploadErgebnis.value = null
}

// ---------------------------------------------------------------------------
// Import-Historie + Lieferanten (Admin)
// ---------------------------------------------------------------------------

const importe = ref<DatanormImportZeile[]>([])
const ladeImporteLaufend = ref(false)

async function ladeImporteListe(): Promise<void> {
  ladeImporteLaufend.value = true
  try {
    importe.value = await ladeImporte(uploadLieferantId.value || undefined)
  } catch (e) {
    uploadFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    ladeImporteLaufend.value = false
  }
}

/**
 * The DATANORM format is a property of the supplier's export — when the
 * admin picks a supplier, its remembered format is proposed.
 */
function uploadLieferantGewechselt(): void {
  const l = lieferanten.value.find((x) => x.id === uploadLieferantId.value)
  uploadFormat.value = l?.format ?? 'auto'
  void ladeImporteListe()
}

const neuLieferantName = ref('')
const neuLieferantMatchcode = ref('')
const neuLieferantOrt = ref('')
const neuLieferantFormat = ref<DatanormFormat>('auto')
const lieferantLaufend = ref(false)
const lieferantFehler = ref('')

async function lieferantAnlegen(): Promise<void> {
  if (neuLieferantName.value.trim() === '') return
  lieferantLaufend.value = true
  lieferantFehler.value = ''
  try {
    await anlageLieferant({
      name: neuLieferantName.value.trim(),
      matchcode: neuLieferantMatchcode.value.trim() || undefined,
      ort: neuLieferantOrt.value.trim() || undefined,
      aktiv: true,
      format: neuLieferantFormat.value,
    })
    neuLieferantName.value = ''
    neuLieferantMatchcode.value = ''
    neuLieferantOrt.value = ''
    neuLieferantFormat.value = 'auto'
    await ladeLieferantenListe()
  } catch (e) {
    lieferantFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    lieferantLaufend.value = false
  }
}

async function aktivUmschalten(l: Lieferant): Promise<void> {
  lieferantLaufend.value = true
  lieferantFehler.value = ''
  try {
    await patchLieferant(l.id, { aktiv: !l.aktiv })
    await ladeLieferantenListe()
  } catch (e) {
    lieferantFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    lieferantLaufend.value = false
  }
}

/** Remembers the supplier's DATANORM format for the next upload. */
async function formatSetzen(l: Lieferant, format: DatanormFormat): Promise<void> {
  if (l.format === format) return
  lieferantLaufend.value = true
  lieferantFehler.value = ''
  try {
    await patchLieferant(l.id, { format })
    await ladeLieferantenListe()
  } catch (e) {
    lieferantFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    lieferantLaufend.value = false
  }
}

// ---------------------------------------------------------------------------
// Helfer + Lifecycle
// ---------------------------------------------------------------------------

function geld(cent: number | null): string {
  if (cent === null) return '—'
  return new Intl.NumberFormat(locale.value, { style: 'currency', currency: 'EUR' }).format(
    cent / 100,
  )
}

function datumWert(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale.value)
}

async function ladeLieferantenListe(): Promise<void> {
  laedtLieferanten.value = true
  fehler.value = ''
  try {
    lieferanten.value = await ladeLieferanten(auth.istAdmin)
    if (lieferantId.value === '' && lieferanten.value.length > 0) {
      lieferantId.value = lieferanten.value[0]!.id
    }
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laedtLieferanten.value = false
  }
}

// Lieferant wechseln → alte Treffer sind meaningless, also verwerfen.
watch(lieferantId, () => {
  treffer.value = []
  anzahlTreffer.value = 0
  gesucht.value = false
})

onMounted(() => {
  void ladeLieferantenListe()
  if (auth.istAdmin) void ladeImporteListe()
})

onBeforeUnmount(schliesseEventSource)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.artikelKataloge.h1') }}</h1>
    </header>

    <div class="card">
      <h2>{{ t('view.artikelKataloge.throughsuche') }}</h2>
      <label class="feld">
        <span>{{ t('view.artikelKataloge.lieferant') }}</span>
        <select v-model="lieferantId" data-testid="katalog-lieferant" :disabled="laedtLieferanten">
          <option value="" disabled>{{ t('view.artikelKataloge.lieferantWaehlen') }}</option>
          <option v-for="l in lieferanten" :key="l.id" :value="l.id">
            {{ l.name }}{{ l.matchcode ? ` (${l.matchcode})` : '' }}
          </option>
        </select>
      </label>

      <label class="feld">
        <span>{{ t('view.artikelKataloge.suche') }}</span>
        <div class="such-zeile">
          <input
            v-model="suchbegriff"
            type="search"
            data-testid="katalog-suche"
            :placeholder="t('view.artikelKataloge.suchePlatzhalter')"
            :disabled="lieferantId === ''"
            @keyup.enter="suchen"
          />
          <button
            type="button"
            class="primary"
            data-testid="katalog-suchen"
            :disabled="lieferantId === '' || laedt"
            @click="suchen"
          >
            {{ laedt ? '…' : t('view.artikelKataloge.suchen') }}
          </button>
        </div>
      </label>

      <p v-if="!laedtLieferanten && lieferanten.length === 0" class="hint">
        {{ t('view.artikelKataloge.keineLieferanten') }}
      </p>

      <p v-if="fehler" class="fehler" role="alert">
        {{ t('view.artikelKataloge.offline') }} ({{ fehler }})
      </p>

      <div v-if="laedt" class="hint">{{ t('view.artikelKataloge.laedt') }}</div>

      <ul v-else-if="gesucht && treffer.length === 0" class="leer">
        <li>{{ t('view.artikelKataloge.keineTreffer') }}</li>
      </ul>

      <template v-else-if="treffer.length > 0">
        <p class="hint">{{ t('view.artikelKataloge.trefferZahl', { anzahl: anzahlTreffer }) }}</p>
        <ul class="treffer">
          <li
            v-for="art in treffer"
            :key="art.id"
            class="treffer-zeile"
            :class="{ zurueckgezogen: art.deaktiviert }"
          >
            <div class="treffer-titel">{{ art.titel }}</div>
            <div class="treffer-meta">
              <code>{{ art.matchcode }}</code>
              <span v-if="art.ean">{{ art.ean }}</span>
              <span>{{ geld(art.preisNettoCent ?? art.preisBruttoCent) }}</span>
              <span v-if="art.mengeneinheit">{{ art.mengeneinheit }}</span>
            </div>
            <p v-if="art.beschreibung" class="beschreibung">{{ art.beschreibung }}</p>
            <span v-if="art.deaktiviert" class="badge">
              {{ t('view.artikelKataloge.nichtMehrLieferbar') }}
            </span>
            <span v-if="art.ersatzMatchcode" class="badge">
              {{ t('view.artikelKataloge.ersatz') }}: {{ art.ersatzMatchcode }}
            </span>
            <button
              type="button"
              class="primary"
              data-testid="katalog-uebernehmen"
              @click="hinzufuegen(art)"
            >
              {{ t('view.artikelKataloge.inArtikelliste') }}
            </button>
          </li>
        </ul>
      </template>
    </div>

    <template v-if="auth.istAdmin">
      <div class="card">
        <h2>{{ t('view.artikelKataloge.upload') }}</h2>
        <label class="feld">
          <span>{{ t('view.artikelKataloge.lieferant') }} *</span>
          <select
            v-model="uploadLieferantId"
            data-testid="upload-lieferant"
            :disabled="uploadLaufend"
            @change="uploadLieferantGewechselt"
          >
            <option value="" disabled>{{ t('view.artikelKataloge.lieferantWaehlen') }}</option>
            <option v-for="l in lieferanten" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
        <label class="feld">
          <span>{{ t('view.artikelKataloge.datei') }} *</span>
          <input
            type="file"
            data-testid="upload-datei"
            :disabled="uploadLaufend"
            @change="uploadFile = ($event.target as HTMLInputElement).files?.[0] ?? null"
          />
          <small v-if="uploadFile" class="hint">{{ uploadFile.name }}</small>
        </label>
        <label class="feld">
          <span>{{ t('view.artikelKataloge.encoding') }}</span>
          <select v-model="uploadEncoding" data-testid="upload-encoding" :disabled="uploadLaufend">
            <option value="">{{ t('view.artikelKataloge.encodingAuto') }}</option>
            <option value="utf-8">UTF-8</option>
            <option value="cp850">CP850 (DATANORM v4)</option>
            <option value="windows-1252">Windows-1252</option>
          </select>
        </label>
        <label class="feld">
          <span>{{ t('view.artikelKataloge.format') }}</span>
          <select v-model="uploadFormat" data-testid="upload-format" :disabled="uploadLaufend">
            <option value="auto">{{ t('view.artikelKataloge.formatAuto') }}</option>
            <option value="v4">DATANORM 4.0</option>
            <option value="v5">DATANORM 5.0</option>
          </select>
          <small class="hint">{{ t('view.artikelKataloge.formatHint') }}</small>
        </label>

        <p v-if="uploadFehler" class="fehler" role="alert">{{ uploadFehler }}</p>

        <div v-if="uploadLaufend || fortschritt" class="fortschritt">
          <div class="balken">
            <div class="fuellung" :style="{ width: `${prozentFortschritt}%` }"></div>
          </div>
          <small class="hint">
            {{ fortschritt?.hinweis ?? t('view.artikelKataloge.importLaeuft') }}
          </small>
        </div>
        <p v-if="uploadFertig" class="hint hint-ok">
          {{ t('view.artikelKataloge.importFertig') }}
        </p>
        <p v-if="uploadErgebnis && ergebnisText" class="hint hint-ok">
          {{ ergebnisText }}
        </p>
        <p v-if="uploadErgebnis && uploadErgebnis.version" class="hint">
          {{
            t('view.artikelKataloge.erkanntesFormat', {
              format: `DATANORM ${uploadErgebnis.version}.0`,
            })
          }}
        </p>
        <ul
          v-if="uploadErgebnis && uploadErgebnis.auffaelligkeiten.length > 0"
          class="auffaelligkeiten"
        >
          <li v-for="a in uploadErgebnis.auffaelligkeiten" :key="a">{{ a }}</li>
        </ul>

        <div class="form-actions">
          <button
            type="button"
            class="primary"
            data-testid="upload-start"
            :disabled="uploadLaufend || uploadFile === null || uploadLieferantId === ''"
            @click="uploadStarten"
          >
            {{ uploadLaufend ? '…' : t('view.artikelKataloge.hochladen') }}
          </button>
          <button type="button" :disabled="uploadLaufend" @click="uploadZuruecksetzen">
            {{ t('view.artikelKataloge.zuruecksetzen') }}
          </button>
        </div>
      </div>

      <div class="card">
        <h2>{{ t('view.artikelKataloge.historie') }}</h2>
        <div v-if="ladeImporteLaufend" class="hint">{{ t('view.artikelKataloge.laedt') }}</div>
        <p v-else-if="importe.length === 0" class="hint">
          {{ t('view.artikelKataloge.historieLeer') }}
        </p>
        <table v-else class="data">
          <thead>
            <tr>
              <th>{{ t('view.artikelKataloge.colDatei') }}</th>
              <th>{{ t('view.artikelKataloge.colStatus') }}</th>
              <th>{{ t('view.artikelKataloge.colArtikel') }}</th>
              <th>{{ t('view.artikelKataloge.colNeu') }}</th>
              <th>{{ t('view.artikelKataloge.colAktualisiert') }}</th>
              <th>{{ t('view.artikelKataloge.colFehler') }}</th>
              <th>{{ t('view.artikelKataloge.colGestartet') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in importe" :key="i.id">
              <td>{{ i.originalDateiname }}</td>
              <td>{{ statusText(i.status) }}</td>
              <td>{{ i.artikelAnzahl }}</td>
              <td>{{ i.artikelNeu }}</td>
              <td>{{ i.artikelAktualisiert }}</td>
              <td>{{ i.fehlerAnzahl }}</td>
              <td>{{ datumWert(i.gestartetAm) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>{{ t('view.artikelKataloge.lieferantenVerwalten') }}</h2>
        <form class="form" @submit.prevent="lieferantAnlegen">
          <div class="row">
            <label>
              <span>{{ t('view.artikelKataloge.name') }} *</span>
              <input
                v-model="neuLieferantName"
                type="text"
                data-testid="lieferant-name"
                :disabled="lieferantLaufend"
                required
              />
            </label>
            <label>
              <span>{{ t('view.artikelKataloge.matchcode') }}</span>
              <input
                v-model="neuLieferantMatchcode"
                type="text"
                data-testid="lieferant-matchcode"
                :disabled="lieferantLaufend"
              />
            </label>
            <label>
              <span>{{ t('view.artikelKataloge.ort') }}</span>
              <input
                v-model="neuLieferantOrt"
                type="text"
                data-testid="lieferant-ort"
                :disabled="lieferantLaufend"
              />
            </label>
            <label>
              <span>{{ t('view.artikelKataloge.format') }}</span>
              <select
                v-model="neuLieferantFormat"
                data-testid="lieferant-format"
                :disabled="lieferantLaufend"
              >
                <option value="auto">{{ t('view.artikelKataloge.formatAuto') }}</option>
                <option value="v4">DATANORM 4.0</option>
                <option value="v5">DATANORM 5.0</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button
              type="submit"
              class="primary"
              data-testid="lieferant-anlegen"
              :disabled="lieferantLaufend || neuLieferantName.trim() === ''"
            >
              {{ t('view.artikelKataloge.lieferantAnlegen') }}
            </button>
          </div>
          <p v-if="lieferantFehler" class="fehler" role="alert">{{ lieferantFehler }}</p>
        </form>

        <table class="data">
          <thead>
            <tr>
              <th>{{ t('view.artikelKataloge.colName') }}</th>
              <th>{{ t('view.artikelKataloge.colMatchcode') }}</th>
              <th>{{ t('view.artikelKataloge.colOrt') }}</th>
              <th>{{ t('view.artikelKataloge.format') }}</th>
              <th>{{ t('view.artikelKataloge.colAktiv') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lieferanten" :key="l.id">
              <td>{{ l.name }}</td>
              <td>{{ l.matchcode ?? '—' }}</td>
              <td>{{ l.ort ?? '—' }}</td>
              <td>
                <select
                  :value="l.format"
                  data-testid="lieferant-format-liste"
                  :disabled="lieferantLaufend"
                  @change="
                    formatSetzen(l, ($event.target as HTMLSelectElement).value as DatanormFormat)
                  "
                >
                  <option value="auto">{{ t('view.artikelKataloge.formatAuto') }}</option>
                  <option value="v4">DATANORM 4.0</option>
                  <option value="v5">DATANORM 5.0</option>
                </select>
              </td>
              <td>
                <label class="schalter">
                  <input
                    type="checkbox"
                    :checked="l.aktiv"
                    :disabled="lieferantLaufend"
                    :aria-label="
                      l.aktiv
                        ? t('view.artikelKataloge.deaktivieren')
                        : t('view.artikelKataloge.aktivieren')
                    "
                    @change="aktivUmschalten(l)"
                  />
                  <span>{{
                    l.aktiv
                      ? t('view.artikelKataloge.aktivJa')
                      : t('view.artikelKataloge.aktivNein')
                  }}</span>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
h2 {
  margin-top: 0;
}
.feld {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
}
.such-zeile {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
}
.leer {
  list-style: none;
  margin: 0;
  padding: 0.6rem 0;
}
.treffer {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.treffer-zeile {
  border: 1px solid var(--border, #d7dde3);
  border-radius: 6px;
  padding: 0.55rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  align-items: flex-start;
}
.treffer-zeile.zurueckgezogen .treffer-titel {
  text-decoration: line-through;
  color: var(--muted, #5b6770);
}
.treffer-titel {
  font-weight: 600;
}
.treffer-meta {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
  font-size: 0.85rem;
  color: var(--muted, #5b6770);
}
.beschreibung {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted, #5b6770);
  white-space: pre-line;
}
.badge {
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: #fdecec;
  color: #97231f;
}
.fortschritt {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-bottom: 0.75rem;
}
.balken {
  width: 100%;
  height: 8px;
  background: #eef2f5;
  border-radius: 4px;
  overflow: hidden;
}
.fuellung {
  height: 100%;
  background: var(--accent, #2f6f9f);
  transition: width 300ms ease;
}
.auffaelligkeiten {
  margin: 0.25rem 0 0.75rem;
  padding-left: 1.1rem;
  font-size: 0.85rem;
  color: var(--warning, #8a6100);
}
.data {
  width: 100%;
  border-collapse: collapse;
}
.data th,
.data td {
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border, #d7dde3);
}
.data th {
  color: var(--muted, #5b6770);
  font-size: 0.85rem;
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.85rem;
}
.schalter {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
</style>
