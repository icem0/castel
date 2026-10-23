<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
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
const auth = useAuthStore()
const { alleWaehlbaren } = useArtikelTypen()

interface Form {
  titel: string
  typ: string
  status: ArtikelStatus
  lieferant: string
  verpackungseinheit: number
  mindestbestand: number | null
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
    lieferant: '',
    verpackungseinheit: 1,
    mindestbestand: null,
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

const drawerWerte = computed<UebernahmeFelder>(() => ({
  titel: formular.value.titel,
  barcode: formular.value.barcode,
  bestellnummer: formular.value.bestellnummer,
  lieferant: formular.value.lieferant,
  listenpreis: formular.value.listenpreis,
  verpackungseinheit: formular.value.verpackungseinheit,
}))

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
  if (katLieferant !== '') formular.value.lieferant = katLieferant
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
    await artikelStore.anlegen({
      titel: formular.value.titel.trim(),
      typ: formular.value.typ,
      status: formular.value.status,
      lieferant: formular.value.lieferant.trim() || null,
      verpackungseinheit: formular.value.verpackungseinheit,
      mindestbestand: formular.value.mindestbestand,
      bestellnummer: formular.value.bestellnummer.trim() || null,
      barcode: formular.value.barcode.trim() || null,
      listenpreis: formular.value.listenpreis,
      // Vertrauliches Feld: nur Admins duerfen es setzen. Fuer alle
      // anderen wird es gar nicht erst in den Payload aufgenommen.
      einkaufspreis: auth.istAdmin ? euroZuCent(formular.value.einkaufspreis) : null,
    })
    void router.push('/artikel')
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

function abbrechen(): void {
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
          <label>
            <span>{{ t('view.artikel.form.mindestbestand') }}</span>
            <input
              v-model.number="formular.mindestbestand"
              type="number"
              min="0"
              :disabled="laufend"
            />
          </label>
        </div>
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
@media (max-width: 540px) {
  .row {
    grid-template-columns: 1fr;
  }
}
</style>
