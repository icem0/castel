<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useHerstellerStore } from '../stores/hersteller'
import { useStandortStore } from '../stores/standort'
import { useBuchungStore } from '../stores/buchung'
import { useAuthStore } from '../stores/auth'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import { useBarcodeRender } from '../composables/useBarcodeRender'
import HerstellerKatalogDrawer, {
  type UebernahmeFelder,
} from '../components/HerstellerKatalogDrawer.vue'
import { centZuEuro, euroZuCent, formatiereCent } from '../domain/geld'
import type { Artikel, ArtikelStatus, Buchung } from '../db/types'
import FotoUpload from './components/FotoUpload.vue'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const artikelStore = useArtikelStore()
const herstellerStore = useHerstellerStore()
const standortStore = useStandortStore()
const buchungStore = useBuchungStore()
const auth = useAuthStore()
const { alleWaehlbaren } = useArtikelTypen()

const artikelId = computed<string>(() => String(route.params.id ?? ''))
const artikel = computed<Artikel | undefined>(() => artikelStore.byId(artikelId.value))

const herstellerName = computed<string | null>(() => {
  const id = artikel.value?.herstellerId
  return id ? (herstellerStore.byId(id)?.name ?? null) : null
})

const barcodeQuelle = computed<string | null | undefined>(() => artikel.value?.barcode)
const { el: barcodeEl, fehler: barcodeFehler } = useBarcodeRender(barcodeQuelle, {
  height: 50,
  displayValue: false,
})

const bestaende = computed<Array<{ name: string; menge: number; standortId: string }>>(() => {
  if (!artikel.value) return []
  const map = buchungStore.getBestandProStandort(artikel.value.id)
  return standortStore.aktive
    .map((s) => ({ standortId: s.id, name: s.name, menge: map.get(s.id) ?? 0 }))
    .filter((x) => x.menge !== 0)
})

const historie = computed<Buchung[]>(() => {
  if (!artikel.value) return []
  return buchungStore.byArtikel(artikel.value.id).slice().reverse()
})

function nameStandort(id: string): string {
  return standortStore.byId(id)?.name ?? '—'
}

const archivLaufend = ref(false)
const archivFehler = ref('')

async function archivieren(): Promise<void> {
  if (!artikel.value || archivLaufend.value) return
  if (!confirm(t('view.artikel.detail.archivierenFrage'))) return
  archivLaufend.value = true
  archivFehler.value = ''
  try {
    await artikelStore.archivieren(artikel.value.id)
    void router.push('/artikel')
  } catch (e) {
    archivFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaufend.value = false
  }
}

// ---------- Löschen (Admin) ----------

const loeschenLaufend = ref(false)
const loeschenFehler = ref('')
const hatBuchungen = computed<boolean>(() =>
  artikel.value ? buchungStore.byArtikel(artikel.value.id).length > 0 : false,
)
const kannLoeschen = computed<boolean>(
  () => auth.istAdmin && !hatBuchungen.value && !loeschenLaufend.value,
)

async function loeschen(): Promise<void> {
  if (!artikel.value || !kannLoeschen.value) return
  if (!confirm(t('view.artikel.detail.loeschenFrage'))) return
  loeschenLaufend.value = true
  loeschenFehler.value = ''
  try {
    await artikelStore.loeschen(artikel.value.id)
    void router.push('/artikel')
  } catch (e) {
    loeschenFehler.value = t('view.artikel.detail.loeschenFehler', {
      msg: e instanceof Error ? e.message : String(e),
    })
  } finally {
    loeschenLaufend.value = false
  }
}

// ---------- Bearbeiten ----------

interface BearbeitungsForm {
  titel: string
  typ: string
  status: ArtikelStatus
  herstellerId: string
  lieferant: string
  verpackungseinheit: number
  mindestbestand: number | null
  bestellnummer: string
  barcode: string
  listenpreis: number | null
  /** Netto-Einkaufspreis je VE in Euro (UI-Einheit). Nur Admins. */
  einkaufspreis: number | null
}

const bearbeitet = ref(false)
const formular = ref<BearbeitungsForm | null>(null)
const bearbeitFehler = ref('')
const bearbeitLaufend = ref(false)

const statusOptionen: ArtikelStatus[] = [
  'verfuegbar',
  'reserviert',
  'gesperrt',
  'ausgesondert',
  'archiviert',
]

function bearbeitenStart(): void {
  const a = artikel.value
  if (!a) return
  formular.value = {
    titel: a.titel,
    typ: a.typ,
    status: a.status,
    herstellerId: a.herstellerId ?? '',
    lieferant: a.lieferant ?? '',
    verpackungseinheit: a.verpackungseinheit ?? 1,
    mindestbestand: a.mindestbestand,
    bestellnummer: a.bestellnummer ?? '',
    barcode: a.barcode ?? '',
    listenpreis: a.listenpreis,
    einkaufspreis: centZuEuro(a.einkaufspreis),
  }
  bearbeitFehler.value = ''
  bearbeitet.value = true
}

function waehleHersteller(): void {
  const f = formular.value
  if (!f) return
  const h = herstellerStore.byId(f.herstellerId)
  if (h) f.lieferant = h.name
}

// ---------- Catalogue takeover (same drawer as the "new article" form) ----------

const katalogDrawerOffen = ref(false)

/** Current edit values — drives the diff preview inside the drawer. */
const drawerWerte = computed<UebernahmeFelder>(() => {
  const f = formular.value
  return {
    titel: f?.titel ?? '',
    barcode: f?.barcode ?? '',
    bestellnummer: f?.bestellnummer ?? '',
    lieferant: f?.lieferant ?? '',
    listenpreis: f?.listenpreis ?? null,
    verpackungseinheit: f?.verpackungseinheit ?? 1,
  }
})

/**
 * Another article already owns the barcode currently in the form.
 *
 * Catalogues ship the same EANs with every upload, so a takeover can quietly
 * give two articles the same code. Here (unlike the create form) the current
 * article is excluded — its own barcode is not a conflict.
 */
const barcodeKonflikt = computed<{ id: string; titel: string } | null>(() => {
  const f = formular.value
  const a = artikel.value
  const code = f?.barcode.trim() ?? ''
  if (!a || code === '') return null
  const andere = artikelStore.artikel.find((x) => x.id !== a.id && x.barcode === code)
  return andere ? { id: andere.id, titel: andere.titel } : null
})

/** Copies the ticked catalogue fields into the edit form without saving. */
function felderUebernehmen(felder: Partial<UebernahmeFelder>): void {
  const f = formular.value
  if (!f) return
  if (felder.titel !== undefined) f.titel = felder.titel
  if (felder.barcode !== undefined) f.barcode = felder.barcode
  if (felder.bestellnummer !== undefined) f.bestellnummer = felder.bestellnummer
  if (felder.listenpreis !== undefined) f.listenpreis = felder.listenpreis
  if (felder.lieferant !== undefined) {
    f.lieferant = felder.lieferant
    // The catalogue only knows a supplier name. If the article has no
    // manufacturer yet, link an identically named master-data entry.
    if (!f.herstellerId) {
      const match = herstellerStore.byName(felder.lieferant.trim())
      if (match) f.herstellerId = match.id
    }
  }
}

function katalogSchliessen(): void {
  katalogDrawerOffen.value = false
}

function bearbeitenAbbrechen(): void {
  bearbeitet.value = false
  formular.value = null
  katalogDrawerOffen.value = false
  bearbeitFehler.value = ''
}

async function bearbeitenSpeichern(): Promise<void> {
  const a = artikel.value
  const f = formular.value
  if (!a || !f || bearbeitLaufend.value) return
  bearbeitFehler.value = ''
  if (!f.titel.trim()) {
    bearbeitFehler.value = t('view.artikel.form.pflicht') + ': ' + t('view.artikel.form.titel')
    return
  }
  bearbeitLaufend.value = true
  try {
    await artikelStore.aktualisieren(a.id, {
      titel: f.titel.trim(),
      typ: f.typ,
      status: f.status,
      herstellerId: f.herstellerId || null,
      lieferant: f.lieferant.trim() || null,
      verpackungseinheit: f.verpackungseinheit,
      mindestbestand: f.mindestbestand,
      bestellnummer: f.bestellnummer.trim() || null,
      barcode: f.barcode.trim() || null,
      listenpreis: f.listenpreis,
      // Vertraulich: Nicht-Admins schicken das Feld gar nicht mit, damit
      // ein lokal vorhandener Alt-Wert nicht versehentlich ueberschrieben
      // wird. Der Server ignoriert es zusaetzlich fuer Nicht-Admins.
      ...(auth.istAdmin ? { einkaufspreis: euroZuCent(f.einkaufspreis) } : {}),
    })
    bearbeitet.value = false
    formular.value = null
    katalogDrawerOffen.value = false
  } catch (e) {
    bearbeitFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    bearbeitLaufend.value = false
  }
}

function formatDatum(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => {
  artikelStore.start()
  herstellerStore.start()
})
</script>

<template>
  <section v-if="artikel" class="view">
    <header class="view-head">
      <h1>
        {{ artikel.titel }}
        <span v-if="artikel.status === 'archiviert'" class="badge">
          {{ t('view.artikel.detail.archiviert') }}
        </span>
      </h1>
      <div class="header-actions">
        <template v-if="!bearbeitet">
          <RouterLink :to="`/buchung/neu?artikelId=${artikel.id}`" class="btn primary">
            {{ t('view.artikel.detail.buchen') }}
          </RouterLink>
          <RouterLink :to="`/etiketten?artikelId=${artikel.id}`" class="btn">
            {{ t('view.artikel.detail.etikettDrucken') }}
          </RouterLink>
          <button
            type="button"
            class="btn"
            data-testid="artikel-detail-bearbeiten"
            @click="bearbeitenStart"
          >
            {{ t('view.artikel.detail.bearbeiten') }}
          </button>
          <button
            v-if="artikel.status !== 'archiviert'"
            type="button"
            class="danger"
            :disabled="archivLaufend"
            @click="archivieren"
          >
            {{ archivLaufend ? '…' : t('view.artikel.detail.archivieren') }}
          </button>
          <button
            v-if="auth.istAdmin"
            type="button"
            class="danger"
            :disabled="!kannLoeschen"
            :title="hatBuchungen ? t('view.artikel.detail.loeschenHatBuchungen') : undefined"
            @click="loeschen"
          >
            {{ loeschenLaufend ? '…' : t('view.artikel.detail.loeschen') }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="archivFehler" class="fehler" role="alert">{{ archivFehler }}</p>
    <p v-if="loeschenFehler" class="fehler" role="alert">{{ loeschenFehler }}</p>

    <div v-if="!bearbeitet" class="card">
      <dl class="meta">
        <div>
          <dt>{{ t('view.artikel.spalten.typ') }}</dt>
          <dd>{{ artikel.typ }}</dd>
        </div>
        <div>
          <dt>{{ t('view.artikel.spalten.status') }}</dt>
          <dd>{{ t(`view.artikel.status.${artikel.status}`) }}</dd>
        </div>
        <div v-if="herstellerName">
          <dt>{{ t('view.artikel.form.hersteller') }}</dt>
          <dd>{{ herstellerName }}</dd>
        </div>
        <div v-if="artikel.lieferant">
          <dt>{{ t('view.artikel.form.lieferant') }}</dt>
          <dd>{{ artikel.lieferant }}</dd>
        </div>
        <div v-if="artikel.bestellnummer">
          <dt>{{ t('view.artikel.form.bestellnummer') }}</dt>
          <dd>{{ artikel.bestellnummer }}</dd>
        </div>
        <div v-if="artikel.barcode">
          <dt>{{ t('view.artikel.form.barcode') }}</dt>
          <dd class="barcode-row">
            <code>{{ artikel.barcode }}</code>
            <svg ref="barcodeEl"></svg>
            <span v-if="barcodeFehler" class="fehler hint">{{ barcodeFehler }}</span>
          </dd>
        </div>
        <div v-if="artikel.listenpreis != null">
          <dt>{{ t('view.artikel.form.listenpreis') }}</dt>
          <dd>{{ artikel.listenpreis.toFixed(2) }} €</dd>
        </div>
        <div v-if="auth.istAdmin && artikel.einkaufspreis != null">
          <dt>{{ t('view.artikel.form.einkaufspreis') }}</dt>
          <dd>{{ formatiereCent(artikel.einkaufspreis, locale) }}</dd>
        </div>
        <div v-if="artikel.mindestbestand != null">
          <dt>{{ t('view.artikel.form.mindestbestand') }}</dt>
          <dd>{{ artikel.mindestbestand }}</dd>
        </div>
      </dl>
    </div>

    <div v-else-if="formular" class="card">
      <form
        class="form"
        :aria-busy="bearbeitLaufend || undefined"
        @submit.prevent="bearbeitenSpeichern"
      >
        <label>
          <span>{{ t('view.artikel.form.titel') }} *</span>
          <input v-model="formular.titel" required autocomplete="off" :disabled="bearbeitLaufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.typ') }} {{ t('view.artikel.form.typOptional') }}</span>
          <select v-model="formular.typ" :disabled="bearbeitLaufend">
            <option value="">{{ t('view.artikel.form.typKeiner') }}</option>
            <option v-for="typ in alleWaehlbaren" :key="typ" :value="typ">{{ typ }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.artikel.form.status') }}</span>
          <select
            v-model="formular.status"
            :disabled="bearbeitLaufend || !auth.istAdmin"
            data-testid="artikel-detail-status"
          >
            <option v-for="s in statusOptionen" :key="s" :value="s">
              {{ t(`view.artikel.status.${s}`) }}
            </option>
          </select>
          <small v-if="!auth.istAdmin" class="hint muted">
            {{ t('view.artikel.detail.statusAdminHint') }}
          </small>
        </label>
        <label>
          <span>{{ t('view.artikel.form.hersteller') }}</span>
          <select
            v-model="formular.herstellerId"
            :disabled="bearbeitLaufend"
            @change="waehleHersteller"
          >
            <option value="">{{ t('view.artikel.form.herstellerKeiner') }}</option>
            <option v-for="h in herstellerStore.hersteller" :key="h.id" :value="h.id">
              {{ h.name }}
            </option>
          </select>
        </label>
        <label>
          <span>{{ t('view.artikel.form.lieferant') }}</span>
          <input v-model="formular.lieferant" autocomplete="off" :disabled="bearbeitLaufend" />
        </label>

        <div class="katalog-aktion">
          <button
            type="button"
            class="btn-katalog"
            data-testid="artikel-detail-katalog-oeffnen"
            :disabled="bearbeitLaufend"
            @click="katalogDrawerOffen = true"
          >
            {{ t('datanorm.drawer.oeffnen') }}
          </button>
          <small class="hint">{{ t('datanorm.drawer.oeffnenHint') }}</small>
        </div>

        <div v-if="barcodeKonflikt" class="duplikat-banner">
          <p>{{ t('view.artikel.form.duplikatHinweis', { titel: barcodeKonflikt.titel }) }}</p>
          <RouterLink
            :to="{ name: 'artikel-detail', params: { id: barcodeKonflikt.id } }"
            class="primary"
          >
            {{ t('view.artikel.form.duplikatZumArtikel') }}
          </RouterLink>
        </div>

        <div class="row">
          <label>
            <span>{{ t('view.artikel.form.ve') }}</span>
            <input
              v-model.number="formular.verpackungseinheit"
              type="number"
              min="1"
              :disabled="bearbeitLaufend"
            />
          </label>
          <label>
            <span>{{ t('view.artikel.form.mindestbestand') }}</span>
            <input
              v-model.number="formular.mindestbestand"
              type="number"
              min="0"
              :disabled="bearbeitLaufend"
            />
          </label>
        </div>
        <label>
          <span>{{ t('view.artikel.form.bestellnummer') }}</span>
          <input v-model="formular.bestellnummer" autocomplete="off" :disabled="bearbeitLaufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.barcode') }}</span>
          <input
            v-model="formular.barcode"
            autocomplete="off"
            inputmode="text"
            :disabled="bearbeitLaufend"
          />
        </label>
        <label>
          <span>{{ t('view.artikel.form.listenpreis') }}</span>
          <input
            v-model.number="formular.listenpreis"
            type="number"
            min="0"
            step="0.01"
            :disabled="bearbeitLaufend"
          />
        </label>
        <label v-if="auth.istAdmin">
          <span>{{ t('view.artikel.form.einkaufspreis') }}</span>
          <input
            v-model.number="formular.einkaufspreis"
            type="number"
            min="0"
            step="0.01"
            :disabled="bearbeitLaufend"
            data-testid="artikel-detail-einkaufspreis"
          />
          <small class="hint">{{ t('view.artikel.form.einkaufspreisHint') }}</small>
        </label>

        <p v-if="bearbeitFehler" class="fehler" role="alert">{{ bearbeitFehler }}</p>

        <div class="form-actions">
          <button type="submit" class="primary" :disabled="bearbeitLaufend">
            {{ bearbeitLaufend ? '…' : t('view.artikel.form.speichern') }}
          </button>
          <button type="button" :disabled="bearbeitLaufend" @click="bearbeitenAbbrechen">
            {{ t('view.artikel.form.abbrechen') }}
          </button>
        </div>
      </form>
    </div>

    <div v-if="artikel" class="card">
      <FotoUpload :artikel-id="artikel.id" />
    </div>

    <h2>{{ t('view.artikel.detail.bestandProStandort') }}</h2>
    <div v-if="bestaende.length === 0" class="empty-state muted">—</div>
    <div v-else class="card-grid">
      <div v-for="b in bestaende" :key="b.standortId" class="card stat-card">
        <strong>{{ b.menge }}</strong>
        <span>{{ b.name }}</span>
        <span
          v-if="
            b.menge < 0 || (artikel?.mindestbestand !== null && b.menge < artikel.mindestbestand)
          "
          class="attention-badge"
          :title="t('view.artikel.spalten.aufmerksamkeit')"
          >⚠</span
        >
      </div>
    </div>

    <h2>{{ t('view.artikel.detail.historie') }}</h2>
    <p v-if="historie.length === 0" class="empty-state">{{ t('view.buchung.leer') }}</p>
    <table v-else class="data">
      <thead>
        <tr>
          <th>{{ t('view.buchung.spalten.zeit') }}</th>
          <th>{{ t('view.buchung.spalten.typ') }}</th>
          <th class="num">{{ t('view.buchung.spalten.menge') }}</th>
          <th>{{ t('view.buchung.spalten.standort') }}</th>
          <th>{{ t('view.buchung.spalten.projekt') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="b in historie" :key="b.id" :class="{ storno: b.storno }">
          <td>{{ formatDatum(b.erstelltAm) }}</td>
          <td>{{ b.typ }}</td>
          <td :class="b.menge > 0 ? 'num-plus' : b.menge < 0 ? 'num-minus' : 'num'">
            {{ b.menge > 0 ? '+' : '' }}{{ b.menge }}
          </td>
          <td>{{ nameStandort(b.standortId) }}</td>
          <td>{{ b.projekt ?? '—' }}</td>
        </tr>
      </tbody>
    </table>

    <HerstellerKatalogDrawer
      :offen="katalogDrawerOffen"
      :aktuell="drawerWerte"
      @schliessen="katalogSchliessen"
      @uebernehmen="felderUebernehmen"
    />
  </section>
  <section v-else class="view">
    <p class="muted">Lade…</p>
  </section>
</template>

<style scoped>
.barcode-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.barcode-row code {
  font-size: 0.9rem;
  background: #f4f4f4;
  color: #11151c;
  padding: 0.15rem 0.4rem;
  border-radius: 0.25rem;
  border: 1px solid #cbd5e1;
}
.header-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.katalog-aktion {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.btn-katalog {
  align-self: flex-start;
  border: 1px dashed var(--border, #d7dde3);
  background: none;
  border-radius: 6px;
  padding: 0.4rem 0.7rem;
  cursor: pointer;
  color: var(--accent, #2f6f9f);
  font-size: 0.9rem;
}
.btn-katalog:hover:not(:disabled) {
  background: #f2f7fb;
}
.btn-katalog:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.duplikat-banner {
  border: 1px solid #d9a441;
  background: #fdf6e7;
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}
.duplikat-banner p {
  margin: 0;
  flex: 1 1 240px;
}
.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
@media (max-width: 540px) {
  .row {
    grid-template-columns: 1fr;
  }
}
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.stat-card strong {
  font-size: 1.6rem;
  color: var(--accent);
}
.stat-card span {
  font-size: 0.85rem;
  color: var(--text-muted);
}
.attention-badge {
  font-size: 1.1rem;
  line-height: 1;
  margin-left: 0.4rem;
}
</style>
