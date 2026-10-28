<script setup lang="ts">
// Tab "Planung" des Akkutausch-Tools.
//
// Zeigt fuer das gewaehlte Quartal, wie viele Akkus je Groesse getauscht
// werden muessen:
//   bedarf      = faellige Wechsel im Quartal + Projektakkus
//   bestand     = verfuegbarer Bestand des Akku-Artikels (alle Standorte)
//   puffer      = zur freien Verfuegung (Mindestbestand am Hauptlager,
//                 direkt in der Tabelle editierbar)
//   bestellmenge = max(0, bedarf - (bestand - puffer))
//
// Aus der Planung entsteht die Bestellliste (CSV + Druckansicht).

import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAkkutauschStore } from '../../stores/akkutausch'
import { useArtikelStore } from '../../stores/artikel'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { useToastStore } from '../../stores/toast'
import { bestelllisteText } from '../../domain/akkutausch/bestellliste'
import {
  csvDatei,
  formatDatum,
  formatKapazitaet,
  formatKapazitaetBereich,
  formatZahl,
} from '../../domain/akkutausch/formatierung'
import type { PlanwarnungCode, Planzeile } from '../../domain/akkutausch/types'

const emit = defineEmits<{
  (e: 'netzteil-oeffnen', netzteilId: string): void
}>()

const { t } = useI18n()
const store = useAkkutauschStore()
const artikelStore = useArtikelStore()
const auth = useAuthStore()
const settings = useSettingsStore()
const toast = useToastStore()

const locale = computed(() => settings.settings.sprache)

const kopiert = ref(false)
const bestelltLaeuft = ref(false)

/** Inventory cut-off of the battery articles (last four weeks). */
const inventur = computed(() => store.inventurStatus)

/** Archived order of the selected quarter, if any. */
const bestellung = computed(() => store.bestellungFuerQuartal)

/** All archived orders, newest first. */
const archiv = computed(() =>
  [...store.bestellungen].sort((a, b) =>
    a.bestelltAm < b.bestelltAm ? 1 : a.bestelltAm > b.bestelltAm ? -1 : 0,
  ),
)

const jahre = computed(() => {
  const aktuell = new Date().getFullYear()
  return [aktuell - 2, aktuell - 1, aktuell, aktuell + 1, aktuell + 2]
})

/** Letzter Tag des gewaehlten Quartals (= Stichtag der Planung). */
const stichtag = computed(() => {
  const monat = store.quartal * 3
  const letzterTag = new Date(Date.UTC(store.jahr, monat, 0)).getUTCDate()
  return `${store.jahr}-${String(monat).padStart(2, '0')}-${String(letzterTag).padStart(2, '0')}`
})

/** Akku-Groessen, deren Artikel im Artikelstamm fehlt. */
function artikelFehlt(artikelId: string | null): boolean {
  if (!artikelId) return true
  return artikelStore.byId(artikelId) === undefined
}

/**
 * Entwurfswerte des Puffers je Akku-Typ. Der Puffer wird beim Tippen
 * vorgehalten und erst beim Verlassen des Feldes gespeichert.
 */
const pufferEntwurf = ref<Record<string, number | null>>({})

// Externe Aenderungen (anderes Geraet, Mindestbestand im Artikelstamm)
// verwerfen die Entwuerfe, damit die Tabelle den gespeicherten Stand zeigt.
watch(
  () => JSON.stringify([...store.pufferJeArtikel.entries()].sort()),
  () => {
    pufferEntwurf.value = {}
  },
)

/** Der Puffer ist nur editierbar, wenn Artikel und Hauptlager existieren. */
function pufferEditierbar(zeile: Planzeile): boolean {
  return (
    Boolean(zeile.typ.artikelId) &&
    Boolean(store.hauptlagerId) &&
    !artikelFehlt(zeile.typ.artikelId)
  )
}

/** Anzeigewert des Puffers (Entwurf, sonst der gespeicherte Wert). */
function pufferAnzeige(zeile: Planzeile): number {
  const entwurf = pufferEntwurf.value[zeile.typ.id]
  if (typeof entwurf === 'number' && Number.isFinite(entwurf)) return entwurf
  return zeile.puffer
}

/** Uebernimmt die Eingabe in den Entwurf. */
function pufferEingabe(zeile: Planzeile, event: Event): void {
  const roh = (event.target as HTMLInputElement).value.trim()
  if (roh === '') {
    pufferEntwurf.value[zeile.typ.id] = null
    return
  }
  const wert = Number(roh)
  pufferEntwurf.value[zeile.typ.id] = Number.isFinite(wert) ? wert : null
}

/** Speichert den Puffer ("zur freien Verfuegung") am Hauptlager. */
async function pufferSpeichern(zeile: Planzeile): Promise<void> {
  const artikelId = zeile.typ.artikelId
  if (!artikelId || !pufferEditierbar(zeile)) return
  const entwurf = pufferEntwurf.value[zeile.typ.id]
  const wert =
    typeof entwurf === 'number' && Number.isFinite(entwurf) ? Math.max(0, Math.trunc(entwurf)) : 0
  await store.pufferSpeichern(artikelId, wert)
  toast.show({ text: t('view.akkutausch.pufferGespeichert'), status: 'success' })
}

/** Labels for the battery data that may still be missing. */
function feldLabel(key: string): string {
  switch (key) {
    case 'einbaudatum':
      return t('view.akkutausch.feldEinbaudatum')
    case 'intervallJahre':
      return t('view.akkutausch.feldIntervall')
    case 'kapazitaetAh':
      return t('view.akkutausch.feldKapazitaet')
    case 'anzahl':
      return t('view.akkutausch.feldAnzahl')
    default:
      return key
  }
}

function warnungText(code: PlanwarnungCode, bezug: string, wert?: string, anlage?: string): string {
  // Include the plant number so identical device names stay distinguishable.
  const bezugMitAnlage =
    anlage && anlage !== bezug ? `${bezug} (${t('view.akkutausch.feldAnlage')}: ${anlage})` : bezug
  switch (code) {
    case 'netzteil_ungueltiges_datum':
      return t('view.akkutausch.warnungDatum', { bezug: bezugMitAnlage })
    case 'netzteil_unvollstaendig':
      return t('view.akkutausch.warnungUnvollstaendig', {
        bezug: bezugMitAnlage,
        wert: (wert ?? '')
          .split(',')
          .filter((f) => f !== '')
          .map(feldLabel)
          .join(', '),
      })
    case 'netzteil_keine_groesse':
      return t('view.akkutausch.warnungGroesseNetzteil', { bezug: bezugMitAnlage, wert })
    case 'projektakku_keine_groesse':
      return t('view.akkutausch.warnungGroesseProjekt', { bezug, wert })
    case 'typ_ohne_artikel':
      return t('view.akkutausch.warnungKeinArtikel', { bezug })
  }
}

const gesamtMenge = computed(() =>
  store.planung.bestellzeilen.reduce((summe, z) => summe + z.menge, 0),
)

/**
 * Prints only the order list. The portal is teleported to <body> and the
 * `druck-bestellliste` body class hides the app in the print stylesheet.
 */
function drucken(): void {
  if (store.planung.bestellzeilen.length === 0) return
  const beenden = (): void => {
    document.body.classList.remove('druck-bestellliste')
    window.removeEventListener('afterprint', beenden)
  }
  document.body.classList.add('druck-bestellliste')
  window.addEventListener('afterprint', beenden)
  window.print()
  // Fallback for browsers without `afterprint`.
  setTimeout(beenden, 5_000)
}

/** Copies the order list as plain text for an e-mail. */
async function kopieren(): Promise<void> {
  const text = bestelllisteText(store.planung.bestellzeilen, locale.value, {
    quartal: store.quartal,
    jahr: store.jahr,
    inventurDatum: inventur.value.datum,
    inventurKuerzel: inventur.value.kuerzel,
    titel: t('view.akkutausch.bestellliste'),
    inventurLabel: t('view.akkutausch.inventurStichtag'),
    kopfGroesse: t('view.akkutausch.groesse'),
    kopfNennkapazitaet: t('view.akkutausch.nennkapazitaet'),
    kopfMenge: t('view.akkutausch.menge'),
    gesamtLabel: t('view.akkutausch.gesamt'),
  })

  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard API needs a secure context — fall back to the legacy path.
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (!ok) {
      toast.show({ text: t('view.akkutausch.kopierenFehler'), status: 'error' })
      return
    }
  }

  kopiert.value = true
  toast.show({ text: t('view.akkutausch.kopierenErfolg'), status: 'success' })
  setTimeout(() => {
    kopiert.value = false
  }, 2_000)
}

/** Archives the current plan as "ordered" (admin only, once per quarter). */
async function bestellen(): Promise<void> {
  if (bestelltLaeuft.value || bestellung.value || !inventur.value.gueltig) return
  if (
    !window.confirm(
      t('view.akkutausch.bestellenFrage', { quartal: store.quartal, jahr: store.jahr }),
    )
  ) {
    return
  }

  bestelltLaeuft.value = true
  try {
    const result = await store.bestellungMarkieren()
    if (result) {
      toast.show({ text: t('view.akkutausch.bestelltErfolg'), status: 'success' })
    } else {
      toast.show({ text: t('view.akkutausch.bestellenFehler'), status: 'error' })
    }
  } finally {
    bestelltLaeuft.value = false
  }
}

function csvExportieren(): void {
  const zeilen = store.planung.bestellzeilen.map((z) => [
    formatKapazitaetBereich(z.von, z.bis, locale.value),
    formatZahl(z.kapazitaetAh, locale.value),
    formatZahl(z.menge, locale.value),
  ])
  const csv = csvDatei(zeilen, [
    t('view.akkutausch.csvGroesse'),
    t('view.akkutausch.csvNennkapazitaet'),
    t('view.akkutausch.csvMenge'),
  ])
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `akkutausch-bestellliste-${store.jahr}-q${store.quartal}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="planung-tab">
    <div class="card">
      <div class="filter-bar">
        <label>
          <span>{{ t('view.akkutausch.quartal') }}</span>
          <select v-model.number="store.quartal">
            <option :value="1">{{ t('view.akkutausch.quartal1') }}</option>
            <option :value="2">{{ t('view.akkutausch.quartal2') }}</option>
            <option :value="3">{{ t('view.akkutausch.quartal3') }}</option>
            <option :value="4">{{ t('view.akkutausch.quartal4') }}</option>
          </select>
        </label>
        <label>
          <span>{{ t('view.akkutausch.jahr') }}</span>
          <select v-model.number="store.jahr">
            <option v-for="j in jahre" :key="j" :value="j">{{ j }}</option>
          </select>
        </label>
        <span class="stichtag">{{ t('view.akkutausch.stichtag') }}: {{ stichtag }}</span>
      </div>
    </div>

    <div class="card inventur-card" :class="{ 'inventur-card--fehlt': !inventur.gueltig }">
      <div class="inventur-zeile">
        <span class="inventur-label">{{ t('view.akkutausch.inventurStichtag') }}:</span>
        <template v-if="inventur.gueltig">
          <strong>{{ formatDatum(inventur.datum, locale) }}</strong>
          <span v-if="inventur.kuerzel" class="inventur-kuerzel">
            {{ t('view.akkutausch.kuerzel') }}: {{ inventur.kuerzel }}
          </span>
        </template>
        <span v-else class="inventur-fehler">
          {{ t('view.akkutausch.inventurFehlt') }}
        </span>
      </div>
    </div>

    <div v-if="store.typen.length === 0" class="card fehler">
      {{ t('view.akkutausch.keineTypen') }}
    </div>

    <div v-if="store.planung.warnungen.length > 0" class="card warn-card">
      <h2 class="card-titel">{{ t('view.akkutausch.warnungen') }}</h2>
      <ul>
        <li v-for="(w, i) in store.planung.warnungen" :key="i">
          <span>{{ warnungText(w.code, w.bezug, w.wert, w.anlage) }}</span>
          <button
            v-if="auth.istAdmin && w.netzteilId"
            type="button"
            class="warn-link"
            @click="emit('netzteil-oeffnen', w.netzteilId)"
          >
            {{ t('view.akkutausch.bearbeiten') }}
          </button>
        </li>
      </ul>
    </div>

    <table v-if="store.typen.length > 0" class="data">
      <thead>
        <tr>
          <th>{{ t('view.akkutausch.groesse') }}</th>
          <th>{{ t('view.akkutausch.bedarf') }}</th>
          <th>{{ t('view.akkutausch.bestand') }}</th>
          <th :title="t('view.akkutausch.pufferHinweis')">
            {{ t('view.akkutausch.puffer') }}
          </th>
          <th>{{ t('view.akkutausch.bestellmenge') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="zeile in store.planung.zeilen" :key="zeile.typ.id">
          <td>
            {{ formatKapazitaet(zeile.typ.kapazitaetAh, locale) }}
            <span class="band-hinweis">
              {{ formatKapazitaetBereich(zeile.typ.von, zeile.typ.bis, locale) }}
            </span>
            <span v-if="artikelFehlt(zeile.typ.artikelId)" class="warn-inline">
              {{ t('view.akkutausch.keinArtikelKurz') }}
            </span>
          </td>
          <td>{{ zeile.bedarf }}</td>
          <td>{{ zeile.bestand }}</td>
          <td>
            <input
              v-if="pufferEditierbar(zeile)"
              :value="pufferAnzeige(zeile)"
              type="number"
              min="0"
              step="1"
              class="input-kompakt"
              :aria-label="t('view.akkutausch.puffer')"
              @input="pufferEingabe(zeile, $event)"
              @change="pufferSpeichern(zeile)"
            />
            <span v-else class="row-meta">—</span>
          </td>
          <td :class="{ 'num-plus': zeile.bestellmenge > 0 }">{{ zeile.bestellmenge }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="store.typen.length > 0" class="plan-hinweis">
      {{ t('view.akkutausch.pufferHinweis') }}
    </p>

    <div class="card bestellliste">
      <h2 class="card-titel">{{ t('view.akkutausch.bestellliste') }}</h2>

      <div v-if="bestellung" class="bestellt-status">
        <strong>{{ t('view.akkutausch.bestellt') }}</strong>
        <span>
          {{
            t('view.akkutausch.bestelltAm', {
              datum: formatDatum(bestellung.bestelltAm.slice(0, 10), locale),
              kuerzel: bestellung.bestelltVonKuerzel,
            })
          }}
        </span>
        <span v-if="bestellung.inventurDatum">
          {{
            t('view.akkutausch.inventurKurz', {
              datum: formatDatum(bestellung.inventurDatum, locale),
              kuerzel: bestellung.inventurVonKuerzel ?? '—',
            })
          }}
        </span>
      </div>

      <table v-if="store.planung.bestellzeilen.length > 0" class="data">
        <thead>
          <tr>
            <th>{{ t('view.akkutausch.groesse') }}</th>
            <th>{{ t('view.akkutausch.nennkapazitaet') }}</th>
            <th>{{ t('view.akkutausch.menge') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="z in store.planung.bestellzeilen" :key="z.typId">
            <td>{{ formatKapazitaetBereich(z.von, z.bis, locale) }}</td>
            <td>{{ formatKapazitaet(z.kapazitaetAh, locale) }}</td>
            <td>{{ z.menge }}</td>
          </tr>
          <tr class="summe-zeile">
            <td colspan="2">{{ t('view.akkutausch.gesamt') }}</td>
            <td>{{ gesamtMenge }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">{{ t('view.akkutausch.keinBedarf') }}</p>

      <div v-if="store.planung.bestellzeilen.length > 0" class="form-actions">
        <button type="button" @click="csvExportieren">{{ t('view.akkutausch.csvExport') }}</button>
        <button type="button" @click="kopieren">
          {{ kopiert ? t('view.akkutausch.kopiert') : t('view.akkutausch.kopieren') }}
        </button>
        <button type="button" @click="drucken">{{ t('view.akkutausch.drucken') }}</button>
        <button
          v-if="auth.istAdmin && !bestellung"
          type="button"
          class="primary"
          :disabled="!inventur.gueltig || bestelltLaeuft"
          :title="!inventur.gueltig ? t('view.akkutausch.bestellenInventurFehlt') : undefined"
          @click="bestellen"
        >
          {{
            bestelltLaeuft ? t('view.akkutausch.bestellenLaeuft') : t('view.akkutausch.bestellen')
          }}
        </button>
      </div>
    </div>

    <div v-if="archiv.length > 0" class="card bestell-archiv">
      <h2 class="card-titel">{{ t('view.akkutausch.bestellarchiv') }}</h2>
      <details v-for="b in archiv" :key="b.id" class="archiv-eintrag">
        <summary>
          <strong>Q{{ b.quartal }} {{ b.jahr }}</strong>
          <span>
            {{
              t('view.akkutausch.bestelltAm', {
                datum: formatDatum(b.bestelltAm.slice(0, 10), locale),
                kuerzel: b.bestelltVonKuerzel,
              })
            }}
          </span>
          <span v-if="b.inventurDatum">
            {{
              t('view.akkutausch.inventurKurz', {
                datum: formatDatum(b.inventurDatum, locale),
                kuerzel: b.inventurVonKuerzel ?? '—',
              })
            }}
          </span>
        </summary>
        <table class="data">
          <thead>
            <tr>
              <th>{{ t('view.akkutausch.groesse') }}</th>
              <th>{{ t('view.akkutausch.bedarf') }}</th>
              <th>{{ t('view.akkutausch.bestand') }}</th>
              <th>{{ t('view.akkutausch.puffer') }}</th>
              <th>{{ t('view.akkutausch.bestellmenge') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="z in b.zeilen" :key="z.typId">
              <td>
                {{ formatKapazitaet(z.kapazitaetAh, locale) }}
                <span class="band-hinweis">
                  {{ formatKapazitaetBereich(z.von, z.bis, locale) }}
                </span>
              </td>
              <td>{{ z.soll }}</td>
              <td>{{ z.bestand }}</td>
              <td>{{ z.reserve }}</td>
              <td>{{ z.bedarf }}</td>
            </tr>
          </tbody>
        </table>
      </details>
    </div>

    <Teleport to="body">
      <div class="druck-portal">
        <h1>{{ t('view.akkutausch.bestellliste') }} – Q{{ store.quartal }} {{ store.jahr }}</h1>
        <p>
          {{ t('view.akkutausch.inventurStichtag') }}:
          {{ formatDatum(inventur.datum, locale) }}
          <span v-if="inventur.kuerzel">({{ inventur.kuerzel }})</span>
        </p>
        <table class="druck-tabelle">
          <thead>
            <tr>
              <th>{{ t('view.akkutausch.groesse') }}</th>
              <th>{{ t('view.akkutausch.nennkapazitaet') }}</th>
              <th>{{ t('view.akkutausch.menge') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="z in store.planung.bestellzeilen" :key="z.typId">
              <td>{{ formatKapazitaetBereich(z.von, z.bis, locale) }}</td>
              <td>{{ formatKapazitaet(z.kapazitaetAh, locale) }}</td>
              <td>{{ z.menge }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2">{{ t('view.akkutausch.gesamt') }}</td>
              <td>{{ gesamtMenge }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.card-titel {
  margin: 0 0 0.75rem;
  font-size: 1.05rem;
}

.stichtag {
  color: var(--text-muted);
  font-size: 0.9rem;
}

.warn-card ul {
  margin: 0;
  padding-left: 1.1rem;
  color: var(--warning);
  font-size: 0.9rem;
}

.warn-card li {
  margin-bottom: 0.25rem;
}

.warn-link {
  margin-left: 0.4rem;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent, #2563eb);
  font-size: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.warn-inline {
  display: block;
  color: var(--warning);
  font-size: 0.8rem;
}

.band-hinweis {
  display: block;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.input-kompakt {
  width: 5.5rem;
}

.row-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.plan-hinweis {
  margin: 0.5rem 0 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.summe-zeile td {
  font-weight: 600;
}

.fehler {
  color: var(--danger);
}

.inventur-zeile {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.9rem;
}

.inventur-label {
  color: var(--text-muted);
}

.inventur-kuerzel {
  color: var(--text-muted);
}

.inventur-card--fehlt {
  border-color: var(--warning);
}

.inventur-fehler {
  color: var(--warning);
}

.bestellt-status {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-left: 3px solid var(--success, #16a34a);
  background: color-mix(in srgb, var(--success, #16a34a) 8%, transparent);
  font-size: 0.9rem;
}

.archiv-eintrag {
  padding: 0.4rem 0;
  border-bottom: 1px solid var(--border);
}

.archiv-eintrag:last-child {
  border-bottom: none;
}

.archiv-eintrag summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  cursor: pointer;
  font-size: 0.9rem;
}

.archiv-eintrag summary span {
  color: var(--text-muted);
}

.archiv-eintrag .data {
  margin-top: 0.5rem;
}
</style>
