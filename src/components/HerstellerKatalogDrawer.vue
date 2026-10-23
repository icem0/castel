<script setup lang="ts">
// Hersteller-Katalog drawer.
//
// A side panel, not a modal: the whole point is to fill fields in the
// article form, so the form has to stay visible and scrollable while the
// user browses the catalogue. A modal would hide the very thing being edited.
//
// Flow is two-step on purpose:
//   1. pick the supplier (the picker)
//   2. search inside that supplier's catalogue
//
// Searching across all suppliers at once sounds convenient but is wrong here:
// the same EAN legitimately exists in several supplier catalogues with
// different prices and descriptions, and a merged result list makes it
// impossible to tell which price belongs to whom.
//
// Field-level control: every field can be applied individually or all at
// once, with a diff preview so nothing is overwritten by surprise.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { HerstellerArtikel, Lieferant } from '../services/datanorm/lookup'
import {
  leseLetztesBeispiel,
  leseLetztenLieferant,
  ladeLieferanten,
  speichereLetztesBeispiel,
  speichereLetztenLieferant,
  sucheHerstellerArtikel,
} from '../services/datanorm/lookup'
import { sortiereNachName } from '../domain/sortierung'

/** Fields the drawer can copy into the article form. */
export interface UebernahmeFelder {
  titel: string
  barcode: string
  bestellnummer: string
  lieferant: string
  listenpreis: number | null
  verpackungseinheit: number
}

const props = defineProps<{
  offen: boolean
  /** Current form values, used for the diff preview. */
  aktuell: UebernahmeFelder
}>()

const emit = defineEmits<{
  schliessen: []
  uebernehmen: [felder: Partial<UebernahmeFelder>]
}>()

const { t, locale } = useI18n()

/** Swipe-to-dismiss: der Drawer lässt sich nach rechts wegwischen. */
const SWIPE_THRESHOLD_PX = 60
const touchStartX = ref(0)
const touchStartY = ref(0)
const touchCurrentX = ref(0)
const istZiehend = ref(false)

function onTouchStart(e: TouchEvent): void {
  const t = e.touches[0]
  if (!t) return
  touchStartX.value = t.clientX
  touchStartY.value = t.clientY
  touchCurrentX.value = touchStartX.value
  istZiehend.value = true
}

function onTouchMove(e: TouchEvent): void {
  if (!istZiehend.value) return
  const t = e.touches[0]
  if (!t) return
  const dx = t.clientX - touchStartX.value
  const dy = Math.abs(t.clientY - touchStartY.value)
  // Nur horizontale Wischer behandeln; vertikales Scrollen im Drawer bleibt erhalten.
  if (Math.abs(dx) > dy && Math.abs(dx) > 10) {
    e.preventDefault()
    touchCurrentX.value = t.clientX
  }
}

function onTouchEnd(): void {
  if (!istZiehend.value) return
  istZiehend.value = false
  const dx = touchCurrentX.value - touchStartX.value
  // Wischen nach rechts (drawer-slide-in-Richtung) schliesst den Drawer.
  if (dx > SWIPE_THRESHOLD_PX) schliessen()
  touchCurrentX.value = 0
}

// Für Tests: Touch-Handler direkt aufrufbar machen (jsdom kennt kein TouchEvent).
defineExpose({
  onTouchStart,
  onTouchMove,
  onTouchEnd,
})

const lieferanten = ref<Lieferant[]>([])
const lieferantId = ref('')
const suchbegriff = ref('')
const treffer = ref<HerstellerArtikel[]>([])
const gewaehlt = ref<HerstellerArtikel | null>(null)
const gesucht = ref(false)
const laedt = ref(false)
const laedtLieferanten = ref(false)
const fehler = ref('')
const offline = ref(false)

/** Fields the user ticked for the transfer. */
const gewaehlteFelder = ref<Set<string>>(new Set())

const sucheHinweis = computed(() => {
  const q = suchbegriff.value.trim()
  if (q === '') return t('datanorm.drawer.alle')
  if (/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(q)) return t('datanorm.drawer.alsEan')
  return t('datanorm.drawer.alsText')
})

const gewaehlterLieferant = computed(
  () => lieferanten.value.find((l) => l.id === lieferantId.value) ?? null,
)

/**
 * Fields that would change the form, with the current and catalogue values.
 * Drives the yellow (overwrite) / grey (fill empty) colouring.
 */
const diff = computed(() => {
  const a = props.aktuell
  const k = gewaehlt.value
  if (!k) return []
  const preisKatalog =
    k.preisNettoCent !== null
      ? k.preisNettoCent / 100
      : k.preisBruttoCent !== null
        ? k.preisBruttoCent / 100
        : null
  const preisIst = a.listenpreis

  const zeilen = [
    {
      feld: 'titel',
      label: t('view.artikel.form.titel'),
      aktuellerWert: a.titel,
      katalogWert: k.titel,
      gleich: a.titel.trim() === k.titel.trim(),
    },
    {
      feld: 'barcode',
      label: t('view.artikel.form.barcode'),
      aktuellerWert: a.barcode,
      katalogWert: k.ean ?? '',
      gleich: a.barcode.trim() === (k.ean ?? '').trim(),
    },
    {
      feld: 'bestellnummer',
      label: t('view.artikel.form.bestellnummer'),
      aktuellerWert: a.bestellnummer,
      katalogWert: k.matchcode,
      gleich: a.bestellnummer.trim() === k.matchcode.trim(),
    },
    {
      feld: 'listenpreis',
      label: t('view.artikel.form.listenpreis'),
      aktuellerWert: preisIst,
      katalogWert: preisKatalog,
      gleich: preisIst === preisKatalog,
      istZahl: true,
    },
  ]
  return zeilen.filter((z) => !z.gleich)
})

const aenderungen = computed(() => diff.value.length)

/** Formats cents as a localised currency string. */
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
    lieferanten.value = sortiereNachName(await ladeLieferanten(), (l) => l.name)
    // Pre-select the supplier used last time, if it still exists.
    const gemerkt = leseLetztenLieferant()
    if (gemerkt && lieferanten.value.some((l) => l.id === gemerkt)) {
      lieferantId.value = gemerkt
    }
  } catch (e) {
    offline.value = true
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laedtLieferanten.value = false
  }
}

async function suchen(): Promise<void> {
  if (!lieferantId.value) return
  laedt.value = true
  gesucht.value = true
  fehler.value = ''
  gewaehlt.value = null
  try {
    const antwort = await sucheHerstellerArtikel({
      lieferantId: lieferantId.value,
      q: suchbegriff.value.trim() || undefined,
      limit: 25,
      inklDeaktivierte: true,
    })
    treffer.value = antwort.treffer
    if (antwort.treffer.length === 1) waehle(antwort.treffer[0]!)
    else if (antwort.treffer.length > 1) {
      // Preselect the first so the diff preview is useful immediately.
      waehle(antwort.treffer[0]!)
    }
  } catch (e) {
    treffer.value = []
    offline.value = true
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laedt.value = false
  }
}

function waehle(artikel: HerstellerArtikel): void {
  gewaehlt.value = artikel
  // Everything the catalogue offers is pre-ticked; the user unticks what
  // they want to keep. Fields with no catalogue value are not offered.
  const felder = new Set<string>()
  if (artikel.titel) felder.add('titel')
  if (artikel.ean) felder.add('barcode')
  if (artikel.matchcode) felder.add('bestellnummer')
  if (artikel.preisNettoCent !== null || artikel.preisBruttoCent !== null) felder.add('listenpreis')
  felder.add('lieferant')
  gewaehlteFelder.value = felder
}

function umschalten(feld: string): void {
  const neu = new Set(gewaehlteFelder.value)
  if (neu.has(feld)) neu.delete(feld)
  else neu.add(feld)
  gewaehlteFelder.value = neu
}

function felderAusTreffer(): Partial<UebernahmeFelder> {
  const k = gewaehlt.value
  if (!k) return {}
  const raus: Partial<UebernahmeFelder> = {}
  const gewaehltSet = gewaehlteFelder.value
  if (gewaehltSet.has('titel')) raus.titel = k.titel
  if (gewaehltSet.has('barcode') && k.ean) raus.barcode = k.ean
  if (gewaehltSet.has('bestellnummer')) raus.bestellnummer = k.matchcode
  if (gewaehltSet.has('listenpreis')) {
    const cent = k.preisNettoCent ?? k.preisBruttoCent
    if (cent !== null) raus.listenpreis = cent / 100
  }
  if (gewaehltSet.has('lieferant') && gewaehlterLieferant.value) {
    raus.lieferant = gewaehlterLieferant.value.name
  }
  return raus
}

/** Applies the ticked fields and closes. */
function uebernehmen(): void {
  const felder = felderAusTreffer()
  if (Object.keys(felder).length === 0) return
  const k = gewaehlt.value
  if (k) speichereLetztesBeispiel(k.matchcode)
  speichereLetztenLieferant(lieferantId.value)
  emit('uebernehmen', felder)
  emit('schliessen')
}

/** Copies a single field without closing the drawer. */
function nurFeld(feld: string): void {
  const vorher = new Set(gewaehlteFelder.value)
  gewaehlteFelder.value = new Set([feld])
  emit('uebernehmen', felderAusTreffer())
  gewaehlteFelder.value = vorher
}

function schliessen(): void {
  emit('schliessen')
}

/** Common open path: reset state, load suppliers, restore the search term. */
async function oeffne(): Promise<void> {
  offline.value = false
  await nextTick()
  await ladeLieferantenListe()
  const gemerkt = leseLetztesBeispiel()
  if (gemerkt && suchbegriff.value === '') suchbegriff.value = gemerkt
}

// Reload whenever the drawer is re-opened.
watch(
  () => props.offen,
  async (istOffen) => {
    if (istOffen) await oeffne()
  },
)

onMounted(async () => {
  document.addEventListener('keydown', onTaste)
  document.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', onTouchEnd, { passive: false })
  // The drawer can be mounted already open (the article form opens it
  // directly when a barcode was scanned), so the watcher below never fires
  // for the initial state — load once here.
  if (props.offen) await oeffne()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onTaste)
  document.removeEventListener('touchmove', onTouchMove)
  document.removeEventListener('touchend', onTouchEnd)
})

function onTaste(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.offen) schliessen()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="offen" class="drawer-backdrop" @click.self="schliessen">
      <aside
        class="drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="t('datanorm.drawer.titel')"
        @touchstart="onTouchStart"
        :class="{ ziehend: istZiehend }"
        :style="{ transform: istZiehend ? `translateX(${touchCurrentX - touchStartX}px)` : '' }"
      >
        <header class="drawer-head">
          <h2>{{ t('datanorm.drawer.titel') }}</h2>
          <button
            type="button"
            class="icon-btn"
            :aria-label="t('datanorm.drawer.schliessen')"
            @click="schliessen"
          >
            ×
          </button>
        </header>

        <div class="drawer-body">
          <!-- Step 1: supplier -->
          <label class="feld">
            <span>{{ t('datanorm.drawer.lieferant') }}</span>
            <select v-model="lieferantId" :disabled="laedtLieferanten">
              <option value="" disabled>{{ t('datanorm.drawer.lieferantWaehlen') }}</option>
              <option v-for="l in lieferanten" :key="l.id" :value="l.id">
                {{ l.name }}{{ l.matchcode ? ` (${l.matchcode})` : '' }}
              </option>
            </select>
          </label>

          <p v-if="!laedtLieferanten && lieferanten.length === 0" class="hinweis">
            {{ t('datanorm.drawer.keineLieferanten') }}
          </p>

          <!-- Step 2: search within the chosen supplier -->
          <label class="feld">
            <span>{{ t('datanorm.drawer.suche') }}</span>
            <div class="such-zeile">
              <input
                v-model="suchbegriff"
                type="search"
                :placeholder="t('datanorm.drawer.suchePlatzhalter')"
                :disabled="!lieferantId"
                @keyup.enter="suchen"
              />
              <button
                type="button"
                class="primary"
                :disabled="!lieferantId || laedt"
                @click="suchen"
              >
                {{ laedt ? '…' : t('datanorm.drawer.suchen') }}
              </button>
            </div>
            <small class="hint">{{ sucheHinweis }}</small>
          </label>

          <p v-if="fehler" class="fehler" role="alert">
            {{ offline ? t('datanorm.drawer.offline') : fehler }}
          </p>

          <!-- Results -->
          <div v-if="laedt" class="laden">{{ t('datanorm.drawer.laedt') }}</div>

          <ul v-else-if="gesucht && treffer.length === 0" class="leer">
            {{
              t('datanorm.drawer.keineTreffer')
            }}
          </ul>

          <ul v-else-if="treffer.length > 0" class="treffer">
            <li
              v-for="art in treffer"
              :key="art.id"
              class="treffer-zeile"
              :class="{ aktiv: gewaehlt?.id === art.id, zurueckgezogen: art.deaktiviert }"
            >
              <button type="button" class="treffer-button" @click="waehle(art)">
                <span class="treffer-titel">{{ art.titel }}</span>
                <span class="treffer-meta">
                  <code>{{ art.matchcode }}</code>
                  <span v-if="art.ean" class="ean">{{ art.ean }}</span>
                  <span v-if="art.preisNettoCent !== null" class="preis">
                    {{ geld(art.preisNettoCent) }}
                  </span>
                </span>
                <span v-if="art.mengeneinheit" class="einheit">
                  {{ t('datanorm.drawer.einheit') }}: {{ art.mengeneinheit
                  }}<template v-if="art.preiseinheit && art.preiseinheit > 1">
                    ×{{ art.preiseinheit }}</template
                  >
                </span>
                <span v-if="art.deaktiviert" class="badge zurueckgezogen-badge">
                  {{ t('datanorm.drawer.nichtMehrLieferbar') }}
                  <template v-if="art.deaktiviertAm">
                    ({{ datumWert(art.deaktiviertAm) }})
                  </template>
                </span>
                <span v-if="art.ersatzMatchcode" class="ersatz">
                  {{ t('datanorm.drawer.ersatz') }}: {{ art.ersatzMatchcode }}
                </span>
              </button>
            </li>
          </ul>

          <!-- Diff preview + field picker -->
          <div v-if="gewaehlt" class="auswahl">
            <h3>{{ t('datanorm.drawer.auswahlTitel') }}</h3>

            <p v-if="aenderungen === 0" class="hinweis">
              {{ t('datanorm.drawer.keineAenderung') }}
            </p>

            <ul v-else class="diff-liste">
              <li
                v-for="z in diff"
                :key="z.feld"
                class="diff-zeile"
                :class="
                  z.aktuellerWert === '' || z.aktuellerWert === null ? 'neu' : 'ueberschreiben'
                "
              >
                <label class="diff-kopf">
                  <input
                    type="checkbox"
                    :checked="gewaehlteFelder.has(z.feld)"
                    @change="umschalten(z.feld)"
                  />
                  <span class="diff-label">{{ z.label }}</span>
                </label>
                <div class="diff-werte">
                  <span class="diff-katalog">
                    {{
                      z.istZahl
                        ? geld(z.katalogWert === null ? null : Math.round(z.katalogWert * 100))
                        : z.katalogWert
                    }}
                  </span>
                  <span
                    v-if="z.aktuellerWert !== '' && z.aktuellerWert !== null"
                    class="diff-aktuell"
                  >
                    {{
                      z.istZahl
                        ? geld(Math.round((z.aktuellerWert as number) * 100))
                        : `„${z.aktuellerWert}“`
                    }}
                  </span>
                  <span v-else class="diff-leer">{{ t('datanorm.drawer.leer') }}</span>
                </div>
                <button type="button" class="link-btn" @click="nurFeld(z.feld)">
                  {{ t('datanorm.drawer.nurDiesesFeld') }}
                </button>
              </li>
            </ul>

            <p v-if="gewaehlt?.beschreibung" class="beschreibung">
              {{ gewaehlt.beschreibung }}
            </p>

            <div class="drawer-actions">
              <button
                type="button"
                class="primary"
                :disabled="gewaehlteFelder.size === 0"
                @click="uebernehmen"
              >
                {{ t('datanorm.drawer.uebernehmen') }}
                <template v-if="aenderungen > 0"> ({{ aenderungen }}) </template>
              </button>
              <button type="button" @click="schliessen">
                {{ t('datanorm.drawer.abbrechen') }}
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 20, 25, 0.35);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}
.drawer {
  width: min(440px, 100vw);
  height: var(--app-vh, 100vh);
  background: var(--surface, #fff);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18);
  animation: einschieben 160ms ease-out;
  transition: transform 0.2s ease-out;
}
.drawer.ziehend {
  transition: none;
}
@keyframes einschieben {
  from {
    transform: translateX(24px);
    opacity: 0.4;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border, #d7dde3);
}
.drawer-head h2 {
  margin: 0;
  font-size: 1.05rem;
}
.icon-btn {
  border: none;
  background: none;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  padding: 0.15rem 0.4rem;
}
.drawer-body {
  padding: 1rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}
.feld {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.such-zeile {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.5rem;
}
.laden,
.leer {
  color: var(--muted, #5b6770);
  padding: 0.6rem 0;
}
.treffer {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.treffer-zeile.aktiv .treffer-button {
  border-color: var(--accent, #2f6f9f);
  box-shadow: inset 0 0 0 1px var(--accent, #2f6f9f);
}
.treffer-zeile.zurueckgezogen .treffer-titel {
  text-decoration: line-through;
  color: var(--muted, #5b6770);
}
.treffer-button {
  width: 100%;
  text-align: left;
  border: 1px solid var(--border, #d7dde3);
  border-radius: 6px;
  background: none;
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
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
.einheit,
.ersatz {
  font-size: 0.8rem;
  color: var(--muted, #5b6770);
}
.badge {
  align-self: flex-start;
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  background: #fdecec;
  color: #97231f;
}
.auswahl {
  border-top: 1px solid var(--border, #d7dde3);
  padding-top: 0.8rem;
}
.auswahl h3 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
}
.diff-liste {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.diff-zeile {
  border: 1px solid var(--border, #d7dde3);
  border-radius: 6px;
  padding: 0.45rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.diff-zeile.ueberschreiben {
  border-color: #d9a441;
  background: #fdf6e7;
}
.diff-zeile.neu {
  background: #f2f7fb;
}
.diff-kopf {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 600;
  font-size: 0.9rem;
}
.diff-werte {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
  font-size: 0.9rem;
}
.diff-katalog {
  font-weight: 600;
}
.diff-aktuell {
  color: var(--muted, #5b6770);
  text-decoration: line-through;
}
.diff-leer {
  color: var(--muted, #5b6770);
  font-style: italic;
  font-size: 0.85rem;
}
.link-btn {
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--accent, #2f6f9f);
  cursor: pointer;
  padding: 0;
  font-size: 0.82rem;
  text-decoration: underline;
}
.beschreibung {
  font-size: 0.88rem;
  color: var(--muted, #5b6770);
  white-space: pre-line;
  margin: 0.4rem 0 0;
}
.drawer-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.8rem;
}
.hinweis {
  color: var(--muted, #5b6770);
  font-size: 0.88rem;
}
</style>
