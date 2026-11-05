<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { jwtLesen } from '../auth/session'
import { getApiBaseUrl } from '../auth/api'
import { getDb } from '../db/database'
import type { InventurPosition, InventurStichtag, Standort } from '../db/types'
import {
  inventurStichtagAnzeige,
  inventurStichtagTeile,
  stichtagAusTeilen,
} from '../domain/inventur-stichtag'
import { berechneInventurErinnerung, istAbgeschlossen } from '../domain/inventur/erinnerung'
import { artikelOhneInventur, createInventur, type InventurHilfeZeile } from '../domain/buchungen'
import { downloadCsv, downloadPdf } from '../services/inventur/pdf'

const { t } = useI18n()
const settings = useSettingsStore()
const auth = useAuthStore()

const apiBase = getApiBaseUrl()
const token = jwtLesen() ?? null

const stichtag = computed(() => settings.settings.inventurStichtag ?? null)
const vorlaufTage = computed(() => settings.settings.inventurVorlaufTage ?? 14)
const darfEinstellen = computed(() => auth.hat('inventur.stichtag'))
const darfAbschliessen = computed(() => auth.hat('inventur.abschliessen'))
const darfLesen = computed(() => auth.hat('inventur.lesen'))
const darfExportieren = computed(() => auth.hat('inventur.export'))
const darfErfassen = computed(() => auth.hat('inventur.erstellen'))

// ---------------------------------------------------------------------------
// Geführte Inventur: Artikel/Standorte ohne Inventur-Buchung
// ---------------------------------------------------------------------------
const hilfeItems = ref<InventurHilfeZeile[]>([])
const hilfeLaden = ref(false)
const hilfeFehler = ref<string | null>(null)
const hilfeMeldung = ref<string | null>(null)
const hilfeSpeicherLaufend = ref(false)
// Sollmenge je (artikelId#standortId)
const sollMengen = ref<Record<string, number>>({})
// Filter
const standorte = ref<Standort[]>([])
const standortFilter = ref<string>('')
const suche = ref<string>('')

/** Hilfestellung-Items, live gefiltert nach Standort und Suchbegriff. */
const gefilterteHilfeItems = computed(() => {
  const s = suche.value.trim().toLowerCase()
  const sid = standortFilter.value.trim()
  return hilfeItems.value.filter((z) => {
    if (sid && z.standortId !== sid) return false
    if (s) {
      const titel = z.artikelTitel.toLowerCase()
      const name = z.standortName.toLowerCase()
      return titel.includes(s) || name.includes(s)
    }
    return true
  })
})

function hilfeKey(artikelId: string, standortId: string): string {
  return `${artikelId}#${standortId}`
}

/** Archive rows carry the internal booking slug — render the localized label. */
function formatTyp(typ: string): string {
  if (
    typ === 'einlagerung' ||
    typ === 'entnahme' ||
    typ === 'umlagerung' ||
    typ === 'inventur' ||
    typ === 'kommission' ||
    typ === 'storno'
  ) {
    return t(`view.buchung.form.typen.${typ}`)
  }
  return typ
}

function sollMengeAendern(z: InventurHilfeZeile, event: Event): void {
  const target = event.target as HTMLInputElement
  const wert = Number(target.value || 0)
  sollMengen.value = {
    ...sollMengen.value,
    [hilfeKey(z.artikelId, z.standortId)]: wert,
  }
}

async function ladeStandorte(): Promise<void> {
  const db = getDb()
  standorte.value = (await db.standorte.toArray()).filter((s) => !s.archiviert)
}

async function ladeHilfestellung(): Promise<void> {
  if (!darfLesen.value) return
  hilfeLaden.value = true
  hilfeFehler.value = null
  try {
    await Promise.all([ladeStandorte(), artikelOhneInventur()]).then(([, items]) => {
      hilfeItems.value = items
      // Sollmengen zurücksetzen (Default = aktueller Bestand)
      sollMengen.value = {}
      for (const z of hilfeItems.value) {
        sollMengen.value[hilfeKey(z.artikelId, z.standortId)] = z.bestand
      }
    })
  } catch (e) {
    hilfeFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    hilfeLaden.value = false
  }
}

async function hilfestellungSpeichern(): Promise<void> {
  if (!darfErfassen.value) return
  if (hilfeSpeicherLaufend.value) return
  hilfeSpeicherLaufend.value = true
  hilfeFehler.value = null
  hilfeMeldung.value = null

  const erstelltVon = auth.erstelltVon
  let erstellt = 0
  let übersprungen = 0

  try {
    for (const z of hilfeItems.value) {
      const key = hilfeKey(z.artikelId, z.standortId)
      const soll = sollMengen.value[key] ?? 0
      // Nur abweichend vom Bestand erfassen (Differenz ≠ 0)
      if (soll === z.bestand) {
        übersprungen += 1
        continue
      }
      await createInventur({
        artikelId: z.artikelId,
        standortId: z.standortId,
        sollMenge: soll,
        erstelltVon,
      })
      erstellt += 1
    }
    // Named placeholders must be ASCII: vue-i18n's message compiler rejects
    // `{übersprungen}`, which used to throw and swallow the whole message.
    hilfeMeldung.value = t('view.inventur.hilfeGespeichert', {
      erstellt,
      uebersprungen: übersprungen,
    })
    await ladeHilfestellung()
  } catch (e) {
    hilfeFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    hilfeSpeicherLaufend.value = false
  }
}

// ---------------------------------------------------------------------------
// Cut-off date + lead time are edited right here (not on the main settings
// page). Validation runs *before* anything is queued: the old form
// concatenated the month and day fields blindly, an untouched day produced
// `11-00`, and the server rejected every push of that op
// (`VALIDATION: Tag muss zwischen 1 und 31 liegen`), which kept failing the
// whole outbox.
// ---------------------------------------------------------------------------
const stichtagTag = ref<number | ''>('')
const stichtagMonat = ref<number | ''>('')
const stichtagJahr = ref<number | ''>('')
const vorlaufTageFeld = ref<number | ''>('')
const felderVomUser = ref(false)
const stichtagFehler = ref('')
const speicherMeldung = ref('')
const feldLaeuft = ref(false)
let speicherTimer: ReturnType<typeof setTimeout> | null = null

function felderAusStore(): void {
  const teile = inventurStichtagTeile(stichtag.value)
  stichtagTag.value = teile?.tag ?? ''
  stichtagMonat.value = teile?.monat ?? ''
  stichtagJahr.value = teile?.jahr ?? ''
  vorlaufTageFeld.value = vorlaufTage.value
}

function zeigeSpeicherMeldung(text: string): void {
  speicherMeldung.value = text
  if (speicherTimer !== null) clearTimeout(speicherTimer)
  speicherTimer = setTimeout(() => {
    speicherMeldung.value = ''
    speicherTimer = null
  }, 2500)
}

/**
 * Writes the cut-off date built from the two fields. Incomplete or impossible
 * dates are reported in the form and never reach the outbox; both fields
 * empty clears the setting (the server stores the empty value as "not set").
 */
async function stichtagAendern(): Promise<void> {
  if (feldLaeuft.value) return
  felderVomUser.value = true
  const pruefung = stichtagAusTeilen(stichtagTag.value, stichtagMonat.value, stichtagJahr.value)
  if (pruefung.status === 'unvollstaendig') {
    stichtagFehler.value = t('view.inventur.stichtagUnvollstaendig')
    return
  }
  if (pruefung.status === 'ungueltig') {
    stichtagFehler.value = t('view.inventur.stichtagUngueltig')
    return
  }
  stichtagFehler.value = ''
  feldLaeuft.value = true
  try {
    await settings.setInventurStichtag(pruefung.wert)
    felderVomUser.value = false
    felderAusStore()
    zeigeSpeicherMeldung(
      pruefung.status === 'leer'
        ? t('view.inventur.stichtagGeloescht')
        : t('view.inventur.stichtagGesetzt'),
    )
  } finally {
    feldLaeuft.value = false
  }
}

async function vorlaufAendern(): Promise<void> {
  if (feldLaeuft.value) return
  const zahl = Number(vorlaufTageFeld.value)
  const geklemmt = Number.isFinite(zahl) ? Math.max(0, Math.min(365, Math.round(zahl))) : 0
  feldLaeuft.value = true
  try {
    await settings.setInventurVorlaufTage(geklemmt)
    vorlaufTageFeld.value = geklemmt
    zeigeSpeicherMeldung(t('view.inventur.gespeichert'))
  } finally {
    feldLaeuft.value = false
  }
}

const lokalenStichtage = ref<InventurStichtag[]>([])
const lokalenPositionen = ref<InventurPosition[]>([])
const erinnerung = ref<{
  aktiv: boolean
  ueberfaellig: boolean
  tage: number | null
  grund: string | null
} | null>(null)

const abschlussLaden = ref(false)
const archivLaden = ref(false)
const rebaseLaden = ref(false)
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
  }>
>([])
const archivTotal = ref(0)
const archivOffset = ref(0)
const archivLimit = ref(50)
const fehler = ref<string | null>(null)
const meldung = ref<string | null>(null)

async function ladeLokaleInventur(): Promise<void> {
  const db = getDb()
  lokalenStichtage.value = await db.inventurStichtage.toArray()
  lokalenPositionen.value = await db.inventurPositionen.toArray()
  berechneErinnerung()
}

function berechneErinnerung(): void {
  const s = stichtag.value
  const vt = vorlaufTage.value
  const abgeschlossen = s ? istAbgeschlossen(s, lokalenStichtage.value) : false
  const er = berechneInventurErinnerung(s ?? null, vt, abgeschlossen, new Date())
  erinnerung.value = {
    aktiv: er.aktiv,
    ueberfaellig: er.ueberfaellig,
    tage: er.tageBisStichtag,
    grund: er.grund,
  }
}

async function stichtagAbschliessen(): Promise<void> {
  if (!stichtag.value) {
    fehler.value = t('view.inventur.fehlerStichtagNichtGesetzt')
    return
  }
  abschlussLaden.value = true
  fehler.value = null
  meldung.value = null
  try {
    const res = await fetch(`${apiBase}/api/inventur/abschliessen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ stichtag: stichtag.value }),
    })
    if (!res.ok) {
      const body = await res.text()
      fehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    meldung.value = t('view.inventur.abschlussErfolg', { positionen: data.positionen })
    await ladeLokaleInventur()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    abschlussLaden.value = false
  }
}

async function bestandUebernehmen(): Promise<void> {
  if (!darfAbschliessen.value || rebaseLaden.value) return
  if (!window.confirm(t('view.inventur.rebaseBestaetigen'))) return
  rebaseLaden.value = true
  fehler.value = null
  meldung.value = null
  try {
    const res = await fetch(`${apiBase}/api/inventur/rebase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      const body = await res.text()
      fehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    meldung.value = t('view.inventur.rebaseErfolg', {
      marker: data.erstellteMarker,
      skipped: data.uebersprungeneMarker,
      paare: data.paare,
    })
    await ladeHilfestellung()
    await ladeLokaleInventur()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    rebaseLaden.value = false
  }
}

async function archivLadenFunc(offset: number): Promise<void> {
  if (!darfLesen.value) return
  archivLaden.value = true
  fehler.value = null
  try {
    const res = await fetch(`${apiBase}/api/inventur/archiv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ limit: archivLimit.value, offset }),
    })
    if (!res.ok) {
      const body = await res.text()
      fehler.value = `${res.status} ${body}`
      return
    }
    const data = await res.json()
    archivItems.value = offset === 0 ? data.items : [...archivItems.value, ...data.items]
    archivTotal.value = data.total
    archivOffset.value = offset
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    archivLaden.value = false
  }
}

async function csvExportieren(): Promise<void> {
  if (!darfExportieren.value) return
  const mitPreise = auth.hat('einkaufspreis')
  downloadCsv({ stichtage: lokalenStichtage.value, positionen: lokalenPositionen.value, mitPreise })
}

async function pdfExportieren(): Promise<void> {
  if (!darfExportieren.value) return
  const mitPreise = auth.hat('einkaufspreis')
  try {
    await downloadPdf({
      stichtage: lokalenStichtage.value,
      positionen: lokalenPositionen.value,
      mitPreise,
    })
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

/** Inventuren sortiert nach Erstellungsdatum absteigend (neueste zuerst). */
const inventurenSortiert = computed(() => {
  return [...lokalenStichtage.value].sort(
    (a, b) => new Date(b.erstelltAm).getTime() - new Date(a.erstelltAm).getTime(),
  )
})

/** Anzahl der Positionen für einen Stichtag. */
function positionCount(stichtageId: string): number {
  return lokalenPositionen.value.filter((p) => p.stichtageId === stichtageId).length
}

/** Einzelnen Stichtag als CSV exportieren. */
async function exporteiereStichtagCsv(st: InventurStichtag): Promise<void> {
  if (!darfExportieren.value) return
  const mitPreise = auth.hat('einkaufspreis')
  downloadCsv({
    stichtage: lokalenStichtage.value,
    positionen: lokalenPositionen.value,
    mitPreise,
    stichtageId: st.id,
  })
}

/** Einzelnen Stichtag als PDF exportieren. */
async function exporteiereStichtagPdf(st: InventurStichtag): Promise<void> {
  if (!darfExportieren.value) return
  const mitPreise = auth.hat('einkaufspreis')
  try {
    await downloadPdf({
      stichtage: lokalenStichtage.value,
      positionen: lokalenPositionen.value,
      mitPreise,
      stichtageId: st.id,
    })
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(async () => {
  await ladeLokaleInventur()
  if (darfLesen.value) await archivLadenFunc(0)
  await ladeHilfestellung()
})

watch(
  [stichtag, vorlaufTage],
  () => {
    berechneErinnerung()
    // Values coming from the store (initial load, sync pull, another device)
    // refresh the fields — but never while the user is editing a value that
    // has not been accepted yet.
    if (!felderVomUser.value) felderAusStore()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (speicherTimer !== null) {
    clearTimeout(speicherTimer)
    speicherTimer = null
  }
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.inventur.h1') }}</h1>
      <RouterLink to="/einstellungen" class="btn desktop-only">{{
        t('view.inventur.zurueck')
      }}</RouterLink>
    </header>

    <p class="hint">{{ t('view.inventur.hint') }}</p>

    <!-- Erinnerung -->
    <div
      v-if="erinnerung"
      class="card erinnerung"
      :class="{ aktiv: erinnerung.aktiv, ueberfaellig: erinnerung.ueberfaellig }"
    >
      <h3>{{ t('view.inventur.erinnerung') }}</h3>
      <p v-if="erinnerung.ueberfaellig">{{ t('view.inventur.erinnerungUeberfaellig') }}</p>
      <p v-else-if="erinnerung.aktiv">
        {{ t('view.inventur.erinnerungAktiv', { tage: erinnerung.tage }) }}
      </p>
      <p v-else>{{ t('view.inventur.erinnerungInaktiv') }}</p>
      <small v-if="stichtag">{{
        t('view.inventur.stichtagWert', { wert: inventurStichtagAnzeige(stichtag) })
      }}</small>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.einstellungen') }}</h2>
      <div v-if="darfEinstellen" class="form-grid">
        <div class="account-setting">
          <span class="label">{{ t('view.inventur.stichtag') }}</span>
          <div class="stichtag-zeile">
            <label class="account-setting">
              <span class="label">{{ t('view.inventur.stichtagTag') }}</span>
              <input
                v-model.number="stichtagTag"
                type="number"
                min="1"
                max="31"
                step="1"
                class="zahl"
                :disabled="feldLaeuft"
                @change="stichtagAendern"
              />
            </label>
            <label class="account-setting">
              <span class="label">{{ t('view.inventur.stichtagMonat') }}</span>
              <input
                v-model.number="stichtagMonat"
                type="number"
                min="1"
                max="12"
                step="1"
                class="zahl"
                :disabled="feldLaeuft"
                @change="stichtagAendern"
              />
            </label>
            <label class="account-setting">
              <span class="label">{{ t('view.inventur.stichtagJahr') }}</span>
              <input
                v-model.number="stichtagJahr"
                type="number"
                min="1000"
                max="9999"
                step="1"
                class="zahl"
                :disabled="feldLaeuft"
                @change="stichtagAendern"
              />
            </label>
          </div>
          <small class="hint">{{ t('view.inventur.stichtagHint') }}</small>
          <small v-if="stichtagFehler" class="hint hint-danger" role="alert">
            {{ stichtagFehler }}
          </small>
        </div>

        <label class="account-setting">
          <span class="label">{{ t('view.inventur.vorlaufTage') }}</span>
          <input
            v-model.number="vorlaufTageFeld"
            type="number"
            min="0"
            max="365"
            step="1"
            class="zahl"
            :disabled="feldLaeuft"
            @change="vorlaufAendern"
          />
          <small class="hint">{{ t('view.inventur.vorlaufTageHint') }}</small>
        </label>

        <small v-if="speicherMeldung" class="hint hint-ok" role="status" aria-live="polite">
          {{ speicherMeldung }}
        </small>
      </div>

      <div v-else class="form-grid">
        <div class="account-setting">
          <span class="label">{{ t('view.inventur.stichtag') }}</span>
          <span class="value">{{
            inventurStichtagAnzeige(stichtag) ?? t('view.inventur.nichtGesetzt')
          }}</span>
        </div>
        <div class="account-setting">
          <span class="label">{{ t('view.inventur.vorlaufTage') }}</span>
          <span class="value">{{ vorlaufTage }} {{ t('view.inventur.tage') }}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.abschluss') }}</h2>
      <p>{{ t('view.inventur.abschlussHint') }}</p>
      <button
        type="button"
        class="btn"
        :disabled="abschlussLaden || !stichtag || !darfAbschliessen"
        @click="stichtagAbschliessen"
      >
        {{
          abschlussLaden ? t('view.inventur.abschliessenLaeuft') : t('view.inventur.abschliessen')
        }}
      </button>
      <div v-if="meldung" class="meldung Erfolg">{{ meldung }}</div>
      <div v-if="fehler" class="meldung Fehler">{{ fehler }}</div>
    </div>

    <div class="card">
      <h2>{{ t('view.inventur.rebase') }}</h2>
      <p>{{ t('view.inventur.rebaseHint') }}</p>
      <button
        type="button"
        class="btn"
        :disabled="rebaseLaden || !darfAbschliessen"
        @click="bestandUebernehmen"
      >
        {{ rebaseLaden ? t('view.inventur.rebaseLaeuft') : t('view.inventur.bestandUebernehmen') }}
      </button>
      <div v-if="meldung" class="meldung Erfolg">{{ meldung }}</div>
      <div v-if="fehler" class="meldung Fehler">{{ fehler }}</div>
    </div>

    <div v-if="darfLesen" class="card">
      <h2>{{ t('view.inventur.hilfestellung') }}</h2>
      <p>{{ t('view.inventur.hilfestellungHint') }}</p>

      <div v-if="hilfeLaden" class="hint">{{ t('view.inventur.laedt') }}</div>
      <div v-if="hilfeFehler" class="meldung Fehler">{{ hilfeFehler }}</div>

      <div v-if="!hilfeLaden && !hilfeFehler" class="hilfe-filter">
        <label class="filter-label">
          {{ t('view.inventur.hilfeStandort') }}
          <select v-model="standortFilter" class="zahl">
            <option value="">{{ t('view.inventur.hilfeAlleStandorte') }}</option>
            <option v-for="s in standorte" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>
        <label class="filter-label">
          {{ t('view.inventur.hilfeSuche') }}
          <input
            v-model="suche"
            type="text"
            class="zahl"
            :placeholder="t('view.inventur.hilfeSuchePlaceholder')"
          />
        </label>
        <span class="filter-count">
          {{ gefilterteHilfeItems.length }} / {{ hilfeItems.length }}
        </span>
      </div>

      <div v-if="gefilterteHilfeItems.length === 0 && !hilfeLaden && !hilfeFehler">
        <p class="hint">{{ t('view.inventur.hilfeKeineOffenen') }}</p>
      </div>

      <table v-if="gefilterteHilfeItems.length > 0" class="hilfe-tabelle">
        <thead>
          <tr>
            <th>{{ t('view.inventur.colArtikel') }}</th>
            <th>{{ t('view.inventur.colStandort') }}</th>
            <th>{{ t('view.inventur.colBestand') }}</th>
            <th>{{ t('view.inventur.colSollMenge') }}</th>
            <th>{{ t('view.inventur.colDifferenz') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="z in gefilterteHilfeItems" :key="hilfeKey(z.artikelId, z.standortId)">
            <td>{{ z.artikelTitel }}</td>
            <td>{{ z.standortName }}</td>
            <td class="zahl">{{ z.bestand }}</td>
            <td>
              <input
                type="number"
                min="0"
                step="1"
                class="zahl"
                :value="sollMengen[hilfeKey(z.artikelId, z.standortId)]"
                @input="sollMengeAendern(z, $event)"
              />
            </td>
            <td class="zahl">
              {{
                (Number(sollMengen[hilfeKey(z.artikelId, z.standortId)] || 0) - z.bestand).toFixed(
                  0,
                )
              }}
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="gefilterteHilfeItems.length > 0" class="hilfe-aktionen">
        <button
          type="button"
          class="btn"
          :disabled="hilfeSpeicherLaufend || !darfErfassen"
          @click="hilfestellungSpeichern"
        >
          {{
            hilfeSpeicherLaufend
              ? t('view.inventur.hilfeSpeichert')
              : t('view.inventur.hilfeErfassen')
          }}
        </button>
        <span v-if="!darfErfassen" class="hint">
          {{ t('view.inventur.hilfeKeineErlaubnis') }}
        </span>
        <div v-if="hilfeMeldung" class="meldung Erfolg">{{ hilfeMeldung }}</div>
      </div>
    </div>

    <div v-if="darfLesen" class="card">
      <h2>{{ t('view.inventur.archiv') }}</h2>
      <p>{{ t('view.inventur.archivHint') }}</p>
      <button type="button" class="btn" :disabled="archivLaden" @click="archivLadenFunc(0)">
        {{ archivLaden ? t('view.inventur.laedt') : t('view.inventur.buchungsarchiv') }}
      </button>
      <div v-if="archivLaden" class="hint">{{ t('view.inventur.laedtArchiv') }}</div>
      <table v-if="archivItems.length > 0" class="archiv-tabelle">
        <thead>
          <tr>
            <th>{{ t('view.inventur.colDatum') }}</th>
            <th>{{ t('view.inventur.colTyp') }}</th>
            <th>{{ t('view.inventur.colMenge') }}</th>
            <th>{{ t('view.inventur.colArtikel') }}</th>
            <th>{{ t('view.inventur.colStandort') }}</th>
            <th>{{ t('view.inventur.colKommentar') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in archivItems" :key="item.id">
            <td>{{ item.erstelltAm.slice(0, 10) }}</td>
            <td>{{ formatTyp(item.typ) }}</td>
            <td>{{ item.menge }}</td>
            <td>{{ item.artikelTitel ?? item.artikelId.slice(0, 8) }}…</td>
            <td>{{ item.standortName ?? item.standortId.slice(0, 8) }}…</td>
            <td>{{ item.kommentar ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="archivTotal > archivItems.length" class="archiv-mehr">
        <button
          type="button"
          class="btn klein"
          @click="archivLadenFunc(archivOffset + archivLimit)"
        >
          {{ t('view.inventur.mehrLaden') }}
        </button>
      </div>
    </div>

    <div v-if="darfLesen" class="card">
      <h2>{{ t('view.inventur.uebersicht') }}</h2>
      <p>{{ t('view.inventur.uebersichtHint') }}</p>
      <table v-if="inventurenSortiert.length > 0" class="inventur-tabelle">
        <thead>
          <tr>
            <th>{{ t('view.inventur.colStichtag') }}</th>
            <th>{{ t('view.inventur.colStatus') }}</th>
            <th>{{ t('view.inventur.colPositionen') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="st in inventurenSortiert" :key="st.id">
            <td>{{ st.stichtag }}</td>
            <td>
              <span class="status-badge" :class="st.status">{{
                t(`view.inventur.status.${st.status}`)
              }}</span>
            </td>
            <td class="zahl">{{ positionCount(st.id) }}</td>
            <td>{{ st.erstelltAm.slice(0, 10) }}</td>
            <td class="aktions-spalte">
              <button
                v-if="darfExportieren"
                type="button"
                class="btn klein"
                @click="exporteiereStichtagCsv(st)"
              >
                {{ t('view.inventur.exportStichtagCsv') }}
              </button>
              <button
                v-if="darfExportieren"
                type="button"
                class="btn klein"
                @click="exporteiereStichtagPdf(st)"
              >
                {{ t('view.inventur.exportStichtagPdf') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="hint">{{ t('view.inventur.keineInventuren') }}</div>
    </div>

    <div v-if="darfExportieren" class="card">
      <h2>{{ t('view.inventur.export') }}</h2>
      <p>{{ t('view.inventur.exportHint') }}</p>
      <div class="export-buttons">
        <button type="button" class="btn" @click="csvExportieren">
          {{ t('view.inventur.exportCsv') }}
        </button>
        <button type="button" class="btn" @click="pdfExportieren">
          {{ t('view.inventur.exportPdf') }}
        </button>
      </div>
      <small class="hint">{{ t('view.inventur.exportPreiseHinweis') }}</small>
    </div>
  </section>
</template>

<style scoped>
.card {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  box-shadow: var(--shadow-card);
}
.card h2,
.card h3 {
  margin-top: 0;
  font-size: 1.1rem;
  color: var(--text-strong);
}
.form-grid {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.account-setting {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.account-setting .label {
  font-size: 0.85em;
  color: var(--text-muted);
}
.account-setting .value {
  font-weight: 500;
  color: var(--text);
}
.stichtag-zeile {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.zahl {
  width: 6rem;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.35rem 0.5rem;
}
.zahl:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-bg);
}
button.btn {
  margin-top: 0.5rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text);
  border-radius: var(--radius-sm);
}
button.btn:focus {
  outline: none;
  border-color: var(--accent);
}
button.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.export-buttons {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.archiv-tabelle {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  color: var(--text);
}
.archiv-tabelle th,
.archiv-tabelle td {
  border: 1px solid var(--border);
  padding: 0.4rem;
  text-align: left;
}
.archiv-tabelle th {
  background: var(--bg-input);
  color: var(--text-strong);
}
.archiv-tabelle tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}
.archiv-mehr {
  margin-top: 0.5rem;
}
.inventur-tabelle {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  color: var(--text);
}
.inventur-tabelle th,
.inventur-tabelle td {
  border: 1px solid var(--border);
  padding: 0.4rem;
  text-align: left;
}
.inventur-tabelle th {
  background: var(--bg-input);
  color: var(--text-strong);
}
.inventur-tabelle tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}
.aktions-spalte {
  display: flex;
  gap: 0.3rem;
}
.status-badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.85em;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.status-badge.offen {
  background: rgba(96, 165, 250, 0.15);
  color: var(--accent);
  border: 1px solid rgba(96, 165, 250, 0.35);
}
.status-badge.abgeschlossen {
  background: rgba(74, 222, 128, 0.15);
  color: var(--success);
  border: 1px solid rgba(74, 222, 128, 0.35);
}
.hilfe-tabelle {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin-top: 0.5rem;
  color: var(--text);
}
.hilfe-tabelle th,
.hilfe-tabelle td {
  border: 1px solid var(--border);
  padding: 0.4rem;
  text-align: left;
}
.hilfe-tabelle th {
  background: var(--bg-input);
  color: var(--text-strong);
}
.hilfe-tabelle tr:nth-child(even) td {
  background: rgba(255, 255, 255, 0.02);
}
.hilfe-tabelle .zahl {
  width: 4rem;
  text-align: right;
}
.hilfe-filter {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  align-items: center;
  margin: 0.75rem 0;
}
.filter-label {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85em;
  color: var(--text-muted);
}
.filter-label select,
.filter-label input {
  width: 14rem;
}
.filter-count {
  font-size: 0.85em;
  color: var(--text-muted);
  margin-left: auto;
}
.hilfe-aktionen {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 0.75rem;
}
.meldung {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.9rem;
}
.meldung.Erfolg {
  background: rgba(74, 222, 128, 0.15);
  color: var(--success);
  border: 1px solid rgba(74, 222, 128, 0.35);
}
.meldung.Fehler {
  background: rgba(248, 113, 113, 0.15);
  color: var(--danger);
  border: 1px solid rgba(248, 113, 113, 0.35);
}
.erinnerung {
  border-left: 4px solid var(--warning);
  background: rgba(251, 191, 36, 0.1);
}
.erinnerung.aktiv {
  border-left-color: var(--success);
  background: rgba(74, 222, 128, 0.1);
}
.erinnerung.ueberfaellig {
  border-left-color: var(--danger);
  background: rgba(248, 113, 113, 0.1);
}
.erinnerung h3 {
  color: var(--text-strong);
}
.erinnerung p {
  color: var(--text);
}
.erinnerung small {
  color: var(--text-muted);
}
.hint {
  color: var(--text-muted);
}
.hint-danger {
  color: var(--danger);
}
.hint-ok {
  color: var(--success);
}
</style>
