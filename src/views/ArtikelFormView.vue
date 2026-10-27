<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useHerstellerStore } from '../stores/hersteller'
import { useStandortStore } from '../stores/standort'
import { useArtikelStandortMindestbestandStore } from '../stores/artikelStandortMindestbestand'
import { useAuthStore } from '../stores/auth'
import { useArtikelTypen } from '../composables/useArtikelTypen'
import HerstellerKatalogDrawer, {
  type UebernahmeFelder,
} from '../components/HerstellerKatalogDrawer.vue'
import { euroZuCent } from '../domain/geld'
import type { ArtikelStatus } from '../db/types'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const artikelStore = useArtikelStore()
const herstellerStore = useHerstellerStore()
const standortStore = useStandortStore()
const mindestbestandStore = useArtikelStandortMindestbestandStore()
const auth = useAuthStore()
const { alleWaehlbaren } = useArtikelTypen()

interface Form {
  titel: string
  typ: string
  status: ArtikelStatus
  herstellerId: string
  lieferant: string
  verpackungseinheit: number
  /** Mindestbestand je aktivem Lager. `0` = kein Mindestbestand. */
  mindestbestaende: Record<string, number>
  bestellnummer: string
  barcode: string
  listenpreis: number | null
  /** Netto-Einkaufspreis je VE in Euro (UI-Einheit). Nur Admins. */
  einkaufspreis: number | null
}

const initialForm: Form = (() => {
  return {
    titel: '',
    typ: '',
    status: 'verfuegbar',
    herstellerId: '',
    lieferant: '',
    verpackungseinheit: 1,
    mindestbestaende: {},
    bestellnummer: '',
    barcode: '',
    listenpreis: null,
    einkaufspreis: null,
  }
})()

const formular = ref<Form>({ ...initialForm })
const fehler = ref<string>('')
const laufend = ref(false)
const drawerOffen = ref(false)

const neuerHersteller = ref({ name: '', bestellEmail: '', bestellWebseite: '' })
const neuerHerstellerFehler = ref('')

/** Uebernimmt den Namen des gewaehlten Herstellers in das Freitext-Feld. */
function waehleHersteller(): void {
  const h = herstellerStore.byId(formular.value.herstellerId)
  if (h) formular.value.lieferant = h.name
}

async function herstellerAnlegen(): Promise<void> {
  const name = neuerHersteller.value.name.trim()
  if (!name) {
    neuerHerstellerFehler.value = t('view.hersteller.fehlerName')
    return
  }
  const vorhanden = herstellerStore.byName(name)
  if (vorhanden) {
    formular.value.herstellerId = vorhanden.id
    formular.value.lieferant = vorhanden.name
    neuerHersteller.value = { name: '', bestellEmail: '', bestellWebseite: '' }
    neuerHerstellerFehler.value = ''
    return
  }
  const h = await herstellerStore.anlegen({
    name,
    bestellEmail: neuerHersteller.value.bestellEmail,
    bestellWebseite: neuerHersteller.value.bestellWebseite,
  })
  formular.value.herstellerId = h.id
  formular.value.lieferant = h.name
  neuerHersteller.value = { name: '', bestellEmail: '', bestellWebseite: '' }
  neuerHerstellerFehler.value = ''
}

// Der Katalog-Prefill kennt nur den Lieferanten-Namen. Sobald die Hersteller
// geladen sind, verknuepfen wir einen gleichnamigen Eintrag automatisch.
watch(
  () => herstellerStore.geladen,
  (geladen) => {
    if (!geladen || formular.value.herstellerId) return
    const name = formular.value.lieferant.trim()
    if (!name) return
    const match = herstellerStore.byName(name)
    if (match) formular.value.herstellerId = match.id
  },
)

const drawerWerte = computed<UebernahmeFelder>(() => ({
  titel: formular.value.titel,
  barcode: formular.value.barcode,
  bestellnummer: formular.value.bestellnummer,
  lieferant: formular.value.lieferant,
  listenpreis: formular.value.listenpreis,
  verpackungseinheit: formular.value.verpackungseinheit,
}))

/** Ob das Formular ungespeicherte Änderungen gegenüber den Initialwerten hat. */
const dirty = computed(() => {
  const f = formular.value
  return (
    f.titel !== initialForm.titel ||
    f.typ !== initialForm.typ ||
    f.status !== initialForm.status ||
    f.herstellerId !== initialForm.herstellerId ||
    f.lieferant !== initialForm.lieferant ||
    f.verpackungseinheit !== initialForm.verpackungseinheit ||
    JSON.stringify(f.mindestbestaende) !== JSON.stringify(initialForm.mindestbestaende) ||
    f.bestellnummer !== initialForm.bestellnummer ||
    f.barcode !== initialForm.barcode ||
    f.listenpreis !== initialForm.listenpreis ||
    f.einkaufspreis !== initialForm.einkaufspreis
  )
})

let vorUnloadListener: ((e: BeforeUnloadEvent) => void) | null = null
let routerGuard: (() => void) | null = null

function vorUnloadHandler(e: BeforeUnloadEvent): void {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

function aktiviereWache(): void {
  if (!vorUnloadListener) {
    vorUnloadListener = vorUnloadHandler
    window.addEventListener('beforeunload', vorUnloadListener)
  }
  if (!routerGuard) {
    routerGuard = router.beforeEach((to, from) => {
      if (from.name === 'artikel-neu' && dirty.value && to.name !== 'artikel-neu') {
        return confirm(t('view.artikel.form.ungespeichertVerlassen'))
      }
      return true
    })
  }
}

function deaktiviereWache(): void {
  if (vorUnloadListener) {
    window.removeEventListener('beforeunload', vorUnloadListener)
    vorUnloadListener = null
  }
  if (routerGuard) {
    routerGuard()
    routerGuard = null
  }
}

watch(dirty, (istDirty) => {
  if (istDirty) aktiviereWache()
  else deaktiviereWache()
})

onBeforeUnmount(() => deaktiviereWache())

/** Bereits existierender Artikel mit demselben Barcode (Duplikat-Hinweis). */
const duplikatArtikel = ref<{ id: string; titel: string } | null>(null)

/**
 * Übernimmt die Felder aus den Query-Params, die der Katalog-Browser
 * mitgibt (`?katTitel=…&katEan=…`), und warnt bei einem Duplikat.
 *
 * Die Werte landen bewusst nur im Formular, nicht direkt in der DB: Typ,
 * Verpackungseinheit und Status sind castel-Konzepte, die ein Lieferanten-
 * Katalog nicht kennt — die entscheidet der User.
 */
function handleKatalogPrefill(): void {
  const katTitel = route.query.katTitel
  if (typeof katTitel !== 'string' || katTitel === '') return

  const katEan = typeof route.query.katEan === 'string' ? route.query.katEan : ''
  const katMatchcode = typeof route.query.katMatchcode === 'string' ? route.query.katMatchcode : ''
  const katLieferant = typeof route.query.katLieferant === 'string' ? route.query.katLieferant : ''
  const katPreis = Number.parseFloat(String(route.query.katPreis ?? ''))

  formular.value.titel = katTitel
  if (katEan !== '') formular.value.barcode = katEan
  if (katMatchcode !== '') formular.value.bestellnummer = katMatchcode
  if (katLieferant !== '') {
    formular.value.lieferant = katLieferant
    const match = herstellerStore.byName(katLieferant)
    if (match) formular.value.herstellerId = match.id
  }
  if (Number.isFinite(katPreis)) formular.value.listenpreis = katPreis

  // Duplikat-Check: Der Katalog liefert bei jedem Upload dieselben EANs —
  // ohne diesen Hinweis legt der User beim zweiten Durchlauf DoppeltArtikel an.
  if (katEan !== '') {
    const doppelt = artikelStore.artikel.find((a) => a.barcode === katEan)
    if (doppelt) {
      duplikatArtikel.value = { id: doppelt.id, titel: doppelt.titel }
    }
  }
}

/** Copies the ticked catalogue fields into the form without saving yet. */
function felderUebernehmen(felder: Partial<UebernahmeFelder>): void {
  if (felder.titel !== undefined) formular.value.titel = felder.titel
  if (felder.barcode !== undefined) formular.value.barcode = felder.barcode
  if (felder.bestellnummer !== undefined) formular.value.bestellnummer = felder.bestellnummer
  if (felder.lieferant !== undefined) formular.value.lieferant = felder.lieferant
  if (felder.listenpreis !== undefined) formular.value.listenpreis = felder.listenpreis
}

onMounted(() => {
  herstellerStore.start()
  standortStore.start()
  mindestbestandStore.start()
  // Wenn der Scanner einen Code geliefert hat, im Barcode-Feld
  // vorbefüllen. Das ist der zentrale Bugfix: vorher wurde der
  // gescannte Code per Query-Param uebergeben, aber das Form hat
  // ihn ignoriert — der Artikel wurde ohne Barcode angelegt, der
  // naechste Scan fand den Artikel nicht.
  const queryBarcode = route.query.barcode
  if (typeof queryBarcode === 'string' && queryBarcode.length > 0) {
    formular.value.barcode = queryBarcode
    // A scanned EAN is almost always the best search key we will get, so
    // open the drawer right away with the term already filled in.
    drawerOffen.value = true
  }
  handleKatalogPrefill()
})

async function speichern(): Promise<void> {
  if (laufend.value) return
  fehler.value = ''
  if (!formular.value.titel.trim()) {
    fehler.value = t('view.artikel.form.pflicht') + ': ' + t('view.artikel.form.titel')
    return
  }
  laufend.value = true
  try {
    const neu = await artikelStore.anlegen({
      titel: formular.value.titel.trim(),
      typ: formular.value.typ,
      status: formular.value.status,
      herstellerId: formular.value.herstellerId || null,
      lieferant: formular.value.lieferant.trim() || null,
      verpackungseinheit: formular.value.verpackungseinheit,
      bestellnummer: formular.value.bestellnummer.trim() || null,
      barcode: formular.value.barcode.trim() || null,
      listenpreis: formular.value.listenpreis,
      // Vertrauliches Feld: nur Admins duerfen es setzen. Fuer alle
      // anderen wird es gar nicht erst in den Payload aufgenommen.
      einkaufspreis: auth.istAdmin ? euroZuCent(formular.value.einkaufspreis) : null,
    })
    for (const [standortId, wert] of Object.entries(formular.value.mindestbestaende)) {
      await mindestbestandStore.setzen(neu.id, standortId, wert)
    }
    void router.push('/artikel')
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

function abbrechen(): void {
  deaktiviereWache()
  void router.push('/artikel')
}

const statusOptionen: ArtikelStatus[] = [
  'verfuegbar',
  'reserviert',
  'gesperrt',
  'ausgesondert',
  'archiviert',
]
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.artikel.form.h1') }}</h1>
      <RouterLink to="/artikel" class="btn">{{ t('view.artikel.form.abbrechen') }}</RouterLink>
    </header>

    <div v-if="duplikatArtikel" class="card duplikat-banner">
      <p>{{ t('view.artikel.form.duplikatHinweis', { titel: duplikatArtikel.titel }) }}</p>
      <RouterLink
        :to="{ name: 'artikel-detail', params: { id: duplikatArtikel.id } }"
        class="primary"
      >
        {{ t('view.artikel.form.duplikatZumArtikel') }}
      </RouterLink>
    </div>

    <div class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <label>
          <span>{{ t('view.artikel.form.titel') }} *</span>
          <input v-model="formular.titel" required autocomplete="off" :disabled="laufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.typ') }} {{ t('view.artikel.form.typOptional') }}</span>
          <select v-model="formular.typ" :disabled="laufend">
            <option value="">{{ t('view.artikel.form.typKeiner') }}</option>
            <option v-for="typ in alleWaehlbaren" :key="typ" :value="typ">{{ typ }}</option>
          </select>
          <small class="hint">
            Typen werden unter
            <RouterLink to="/einstellungen">Einstellungen</RouterLink>
            gepflegt.
          </small>
        </label>
        <label>
          <span>{{ t('view.artikel.form.status') }}</span>
          <select v-model="formular.status" :disabled="laufend">
            <option v-for="s in statusOptionen" :key="s" :value="s">
              {{ t(`view.artikel.status.${s}`) }}
            </option>
          </select>
        </label>
        <label>
          <span>{{ t('view.artikel.form.hersteller') }}</span>
          <select v-model="formular.herstellerId" :disabled="laufend" @change="waehleHersteller">
            <option value="">{{ t('view.artikel.form.herstellerKeiner') }}</option>
            <option v-for="h in herstellerStore.hersteller" :key="h.id" :value="h.id">
              {{ h.name }}
            </option>
          </select>
        </label>
        <details v-if="auth.istAdmin" class="hersteller-neu">
          <summary>{{ t('view.artikel.form.herstellerNeu') }}</summary>
          <div class="row">
            <label>
              <span>{{ t('view.hersteller.name') }} *</span>
              <input v-model="neuerHersteller.name" autocomplete="off" :disabled="laufend" />
            </label>
            <label>
              <span>{{ t('view.hersteller.bestellEmail') }}</span>
              <input
                v-model="neuerHersteller.bestellEmail"
                type="email"
                autocomplete="off"
                :disabled="laufend"
              />
            </label>
            <label>
              <span>{{ t('view.hersteller.bestellWebseite') }}</span>
              <input
                v-model="neuerHersteller.bestellWebseite"
                autocomplete="off"
                :disabled="laufend"
              />
            </label>
          </div>
          <button type="button" :disabled="laufend" @click="herstellerAnlegen">
            {{ t('view.hersteller.hinzufuegen') }}
          </button>
          <p v-if="neuerHerstellerFehler" class="fehler">{{ neuerHerstellerFehler }}</p>
        </details>
        <label>
          <span>{{ t('view.artikel.form.lieferant') }}</span>
          <input v-model="formular.lieferant" autocomplete="off" :disabled="laufend" />
        </label>

        <div class="katalog-aktion">
          <button type="button" class="btn-katalog" :disabled="laufend" @click="drawerOffen = true">
            {{ t('datanorm.drawer.oeffnen') }}
          </button>
          <small class="hint">{{ t('datanorm.drawer.oeffnenHint') }}</small>
        </div>
        <div class="row">
          <label>
            <span>{{ t('view.artikel.form.ve') }}</span>
            <input
              v-model.number="formular.verpackungseinheit"
              type="number"
              min="1"
              :disabled="laufend"
            />
          </label>
        </div>
        <fieldset class="mindestbestand-lager">
          <legend>{{ t('view.artikel.form.mindestbestandProLager') }}</legend>
          <small class="hint">{{ t('view.artikel.form.mindestbestandProLagerHint') }}</small>
          <label v-for="s in standortStore.aktive" :key="s.id">
            <span>{{ s.name }}</span>
            <input
              v-model.number="formular.mindestbestaende[s.id]"
              type="number"
              min="0"
              :disabled="laufend"
            />
          </label>
        </fieldset>
        <label>
          <span>{{ t('view.artikel.form.bestellnummer') }}</span>
          <input v-model="formular.bestellnummer" autocomplete="off" :disabled="laufend" />
        </label>
        <label>
          <span>{{ t('view.artikel.form.barcode') }}</span>
          <input
            v-model="formular.barcode"
            autocomplete="off"
            inputmode="text"
            :disabled="laufend"
            data-testid="artikel-form-barcode"
          />
          <small class="hint">
            {{ t('view.artikel.form.barcodeHint') }}
          </small>
        </label>
        <label>
          <span>{{ t('view.artikel.form.listenpreis') }}</span>
          <input
            v-model.number="formular.listenpreis"
            type="number"
            min="0"
            step="0.01"
            :disabled="laufend"
          />
        </label>
        <label v-if="auth.istAdmin">
          <span>{{ t('view.artikel.form.einkaufspreis') }}</span>
          <input
            v-model.number="formular.einkaufspreis"
            type="number"
            min="0"
            step="0.01"
            :disabled="laufend"
            data-testid="artikel-form-einkaufspreis"
          />
          <small class="hint">{{ t('view.artikel.form.einkaufspreisHint') }}</small>
        </label>

        <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>

        <div class="form-actions">
          <button type="submit" class="primary" :disabled="laufend">
            {{ laufend ? '…' : t('view.artikel.form.speichern') }}
          </button>
          <button type="button" :disabled="laufend" @click="abbrechen">
            {{ t('view.artikel.form.abbrechen') }}
          </button>
        </div>
      </form>
    </div>

    <HerstellerKatalogDrawer
      :offen="drawerOffen"
      :aktuell="drawerWerte"
      @schliessen="drawerOffen = false"
      @uebernehmen="felderUebernehmen"
    />
  </section>
</template>

<style scoped>
.duplikat-banner {
  border-color: #d9a441;
  background: #fdf6e7;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}
.duplikat-banner p {
  margin: 0;
  flex: 1 1 240px;
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
.row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem;
}
.hersteller-neu {
  border: 1px dashed var(--border, #d7dde3);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
}
.hersteller-neu summary {
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--accent, #2f6f9f);
}
.hersteller-neu .row {
  margin: 0.5rem 0;
}
@media (max-width: 540px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
