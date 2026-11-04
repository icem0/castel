<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { jwtLesen } from '../auth/session'
import { getApiBaseUrl } from '../auth/api'
import { getDb } from '../db/database'
import type { InventurPosition, InventurStichtag } from '../db/types'
import {
  inventurStichtagAnzeige,
  inventurStichtagTeile,
  stichtagAusTeilen,
} from '../domain/inventur-stichtag'
import { berechneInventurErinnerung, istAbgeschlossen } from '../domain/inventur/erinnerung'
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

// ---------------------------------------------------------------------------
// Cut-off date + lead time are edited right here (not on the main settings
// page). Validation runs *before* anything is queued: the old form
// concatenated the month and day fields blindly, an untouched day produced
// `11-00`, and the server rejected every push of that op
// (`VALIDATION: Tag muss zwischen 1 und 31 liegen`), which kept failing the
// whole outbox.
// ---------------------------------------------------------------------------
const stichtagMonat = ref<number | ''>('')
const stichtagTag = ref<number | ''>('')
const vorlaufTageFeld = ref<number | ''>('')
const felderVomUser = ref(false)
const stichtagFehler = ref('')
const speicherMeldung = ref('')
const feldLaeuft = ref(false)
let speicherTimer: ReturnType<typeof setTimeout> | null = null

function felderAusStore(): void {
  const teile = inventurStichtagTeile(stichtag.value)
  stichtagMonat.value = teile?.monat ?? ''
  stichtagTag.value = teile?.tag ?? ''
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
  const pruefung = stichtagAusTeilen(stichtagMonat.value, stichtagTag.value)
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
const archivItems = ref<
  Array<{
    id: string
    typ: string
    menge: number
    erstelltAm: string
    kommentar: string | null
    artikelId: string
    standortId: string
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

onMounted(async () => {
  await ladeLokaleInventur()
  if (darfLesen.value) await archivLadenFunc(0)
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
      <small class="hint">{{ t('view.inventur.abschlussBald') }}</small>
      <div v-if="meldung" class="meldung Erfolg">{{ meldung }}</div>
      <div v-if="fehler" class="meldung Fehler">{{ fehler }}</div>
    </div>

    <div v-if="darfLesen" class="card">
      <h2>{{ t('view.inventur.hilfestellung') }}</h2>
      <p>{{ t('view.inventur.hilfestellungHint') }}</p>
      <button type="button" class="btn" disabled>{{ t('view.inventur.ohneInventur') }}</button>
      <small class="hint">{{ t('view.inventur.hilfestellungBald') }}</small>
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
            <td>{{ item.typ }}</td>
            <td>{{ item.menge }}</td>
            <td>{{ item.artikelId.slice(0, 8) }}…</td>
            <td>{{ item.standortId.slice(0, 8) }}…</td>
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
      <small class="hint">{{ t('view.inventur.archivBald') }}</small>
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
  border: 1px solid var(--border, #ddd);
  border-radius: 6px;
  background: var(--card-bg, #fff);
}
.card h2,
.card h3 {
  margin-top: 0;
  font-size: 1.1rem;
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
  color: var(--text-muted, #666);
}
.account-setting .value {
  font-weight: 500;
}
.stichtag-zeile {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.zahl {
  width: 6rem;
}
button.btn {
  margin-top: 0.5rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  border: 1px solid var(--border, #ccc);
  background: var(--btn-bg, #f5f5f5);
  border-radius: 4px;
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
}
.archiv-tabelle th,
.archiv-tabelle td {
  border: 1px solid var(--border, #ddd);
  padding: 0.4rem;
  text-align: left;
}
.archiv-tabelle th {
  background: var(--muted-bg, #f0f0f0);
}
.archiv-mehr {
  margin-top: 0.5rem;
}
.meldung {
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: 4px;
  font-size: 0.9rem;
}
.meldung.Erfolg {
  background: #d4edda;
  color: #155724;
  border: 1px solid #c3e6cb;
}
.meldung.Fehler {
  background: #f8d7da;
  color: #721c24;
  border: 1px solid #f5c6cb;
}
.erinnerung {
  border-left: 4px solid var(--warn, #ff9800);
}
.erinnerung.aktiv {
  border-left-color: #4caf50;
}
.erinnerung.ueberfaellig {
  border-left-color: #f44336;
}
</style>
