<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useArtikelStore } from '../stores/artikel'
import { useStandortStore } from '../stores/standort'
import { useBuchungStore } from '../stores/buchung'
import { useAuthStore } from '../stores/auth'
import { useToastStore } from '../stores/toast'
import { getApiBaseUrl } from '../auth/api'
import { syncUndBestaetigeBuchungen } from '../services/sync/buchung-bestaetigung'
import { kommissionMerken, letzteKommission } from '../services/kommission/merken'
import type { BuchungsTyp } from '../db/types'
import {
  NegativerBestandWarnung,
  MindestbestandWarnung,
  PflichtfeldFehltError,
} from '../domain/errors'
import { validiereBuchungsEingabe } from '../domain/buchung-form-validation'
import ArtikelSucheSelect from '../components/ArtikelSucheSelect.vue'
import KommissionSelect from '../components/KommissionSelect.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const artikelStore = useArtikelStore()
const standortStore = useStandortStore()
const buchungStore = useBuchungStore()
const auth = useAuthStore()
const toast = useToastStore()

const typen: BuchungsTyp[] = ['einlagerung', 'entnahme', 'umlagerung', 'inventur']

const typ = ref<BuchungsTyp>('entnahme')
const artikelId = ref<string>(String(route.query.artikelId ?? ''))
const standortId = ref<string>(standortStore.standardlager?.id ?? '')
const zielStandortId = ref<string>('')
const menge = ref<number>(1)
const sollMenge = ref<number>(0)
const projekt = ref<string>('')
const kommentar = ref<string>('')
const fehler = ref<string>('')
const warnung = ref<string>('')
const mindestWarnung = ref<string>('')
const laufend = ref(false)

onMounted(() => {
  if (!standortId.value) {
    standortId.value = standortStore.standardlager?.id ?? ''
  }
  // Convenience: keep the last commission for one hour (sliding window) so
  // successive bookings for the same commission need no re-selection.
  if (projekt.value === '') {
    const gemerkt = letzteKommission(auth.userId ?? '')
    if (gemerkt) projekt.value = gemerkt
  }
})

const artikel = computed(() => artikelStore.artikel.find((a) => a.id === artikelId.value) ?? null)
const standardStandort = computed(() => standortStore.standardlager)

const zielErforderlich = computed(() => typ.value === 'umlagerung')
const mengeErforderlich = computed(() => typ.value !== 'inventur')
const sollMengeErforderlich = computed(() => typ.value === 'inventur')

async function bestaetigeImHintergrund(buchungIds: string[], toastId: string): Promise<void> {
  try {
    const result = await syncUndBestaetigeBuchungen(buchungIds, {
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
    })
    if (result.status === 'bestaetigt') {
      toast.update(toastId, {
        status: 'success',
        text: t('view.buchung.form.syncBestaetigt'),
        timeoutMs: 2500,
      })
    } else if (result.status === 'abgelehnt') {
      toast.update(toastId, {
        status: 'error',
        text: t('view.buchung.form.syncAbgelehnt', { grund: result.grund }),
        timeoutMs: 8000,
      })
    } else {
      toast.update(toastId, {
        status: 'warning',
        text:
          result.grund === 'offline'
            ? t('view.buchung.form.syncOffline')
            : t('view.buchung.form.syncAusstehend'),
        timeoutMs: 6000,
      })
    }
  } catch (e) {
    console.error('Buchungs-Bestaetigung fehlgeschlagen:', e)
    toast.update(toastId, {
      status: 'warning',
      text: t('view.buchung.form.syncAusstehend'),
      timeoutMs: 6000,
    })
  }
}

async function speichern(): Promise<void> {
  if (laufend.value) return
  fehler.value = ''
  warnung.value = ''
  mindestWarnung.value = ''

  const eingabe = {
    typ: typ.value,
    artikelId: artikelId.value,
    standortId: standortId.value,
    zielStandortId: zielStandortId.value,
    menge: menge.value,
    sollMenge: sollMenge.value,
  }
  const feldFehler = validiereBuchungsEingabe(eingabe)
  if (feldFehler) {
    fehler.value = feldFehler
    return
  }

  laufend.value = true
  const erstelltVon = auth.erstelltVon
  const buchungIds: string[] = []
  try {
    if (typ.value === 'einlagerung') {
      const buchung = await buchungStore.mu.einlagerung({
        artikelId: artikelId.value,
        standortId: standortId.value,
        menge: menge.value,
        projekt: projekt.value || null,
        erstelltVon,
        kommentar: kommentar.value || null,
      })
      buchungIds.push(buchung.id)
    } else if (typ.value === 'entnahme') {
      const res = await buchungStore.mu.entnahme({
        artikelId: artikelId.value,
        standortId: standortId.value,
        menge: menge.value,
        projekt: projekt.value || null,
        erstelltVon,
        kommentar: kommentar.value || null,
      })
      buchungIds.push(res.buchung.id)
      if (res.warnung instanceof NegativerBestandWarnung) {
        warnung.value = t('view.buchung.form.warnNegativ')
      }
      if (res.mindestbestandWarnung instanceof MindestbestandWarnung) {
        mindestWarnung.value = t('view.buchung.form.warnMindestbestand', {
          bestand: res.mindestbestandWarnung.bestand,
          mindestbestand: res.mindestbestandWarnung.mindestbestand,
        })
      }
    } else if (typ.value === 'umlagerung') {
      const res = await buchungStore.mu.umlagerung({
        artikelId: artikelId.value,
        vonId: standortId.value,
        nachId: zielStandortId.value,
        menge: menge.value,
        projekt: projekt.value || null,
        erstelltVon,
        kommentar: kommentar.value || null,
      })
      buchungIds.push(res.entnahme.id, res.einlagerung.id)
      if (res.warnung instanceof NegativerBestandWarnung) {
        warnung.value = t('view.buchung.form.warnNegativ')
      }
      if (res.mindestbestandWarnung instanceof MindestbestandWarnung) {
        mindestWarnung.value = t('view.buchung.form.warnMindestbestand', {
          bestand: res.mindestbestandWarnung.bestand,
          mindestbestand: res.mindestbestandWarnung.mindestbestand,
        })
      }
    } else if (typ.value === 'inventur') {
      const res = await buchungStore.mu.inventur({
        artikelId: artikelId.value,
        standortId: standortId.value,
        sollMenge: sollMenge.value,
        erstelltVon,
        kommentar: kommentar.value || null,
      })
      buchungIds.push(res.buchung.id)
    }

    // Remember the commission for the next booking (inventur posts none —
    // it leaves the saved value untouched).
    if (typ.value !== 'inventur' && projekt.value.trim() !== '') {
      kommissionMerken(auth.userId ?? '', projekt.value.trim())
    }

    const toastId = toast.show({
      text: t('view.buchung.form.syncWirdGesendet'),
      status: 'info',
      timeoutMs: null,
    })
    void bestaetigeImHintergrund(buchungIds, toastId)

    if (route.query.from === 'scan') {
      void router.replace({ name: 'scan' })
      return
    }
    void router.push(artikel.value ? `/artikel/${artikel.value.id}` : '/buchungen')
  } catch (e) {
    if (e instanceof PflichtfeldFehltError) {
      fehler.value = 'Pflichtfeld: ' + e.message
    } else {
      fehler.value = String(e)
    }
  } finally {
    laufend.value = false
  }
}

function abbrechen(): void {
  if (route.query.from === 'scan') {
    void router.push({ name: 'scan' })
    return
  }
  if (artikel.value) void router.push(`/artikel/${artikel.value.id}`)
  else void router.push('/buchungen')
}

function stepper(delta: number): void {
  const naechster = Math.max(1, Math.floor(menge.value) + delta)
  menge.value = naechster
}

function stepperSoll(delta: number): void {
  const naechster = Math.max(0, Math.floor(sollMenge.value) + delta)
  sollMenge.value = naechster
}

const typOptionen = computed(() =>
  typen.map((wert) => ({
    wert,
    label: t(`view.buchung.form.typen.${wert}`),
    icon: typIcon(wert),
  })),
)

function typIcon(wert: BuchungsTyp): string {
  switch (wert) {
    case 'einlagerung':
      return '↓'
    case 'entnahme':
      return '↑'
    case 'umlagerung':
      return '⇄'
    case 'inventur':
      return '∑'
  }
  return '•'
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.buchung.form.h1') }}</h1>
      <RouterLink to="/buchungen" class="btn desktop-only">
        {{ t('view.buchung.form.abbrechen') }}
      </RouterLink>
    </header>

    <div class="card">
      <form class="form buchung-card" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <fieldset class="typ-feldset">
          <legend>{{ t('view.buchung.form.typ') }}</legend>
          <div class="tile-group" role="radiogroup" :aria-label="t('view.buchung.form.typ')">
            <label
              v-for="opt in typOptionen"
              :key="opt.wert"
              class="tile"
              :class="{ active: typ === opt.wert }"
            >
              <input
                type="radio"
                name="buchung-typ"
                :value="opt.wert"
                :checked="typ === opt.wert"
                @change="typ = opt.wert"
              />
              <span class="tile-icon" aria-hidden="true">{{ opt.icon }}</span>
              <span class="tile-label">{{ opt.label }}</span>
            </label>
          </div>
        </fieldset>

        <label>
          <span>{{ t('view.buchung.form.artikel') }} *</span>
          <ArtikelSucheSelect
            v-model="artikelId"
            :items="artikelStore.artikel"
            :disabled="laufend"
            required
          />
        </label>

        <label>
          <span>{{ t('view.buchung.form.standort') }} *</span>
          <select v-model="standortId" required :disabled="laufend">
            <option v-for="s in standortStore.aktive" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>

        <label v-if="zielErforderlich">
          <span>{{ t('view.buchung.form.zielstandort') }} *</span>
          <select v-model="zielStandortId" required :disabled="laufend">
            <option value="" disabled>— wählen —</option>
            <option v-for="s in standortStore.aktive" :key="s.id" :value="s.id">
              {{ s.name }}
            </option>
          </select>
        </label>

        <div v-if="mengeErforderlich" class="menge-block">
          <span class="menge-label">{{ t('view.buchung.form.menge') }} *</span>
          <div
            class="menge-schnellwahltasten"
            role="group"
            :aria-label="t('view.buchung.form.menge')"
          >
            <button type="button" class="schnellwahl-taste" @click="menge = 1">1</button>
            <button type="button" class="schnellwahl-taste" @click="menge = 2">2</button>
            <button type="button" class="schnellwahl-taste" @click="menge = 3">3</button>
            <button type="button" class="schnellwahl-taste" @click="menge = 5">5</button>
            <button type="button" class="schnellwahl-taste" @click="menge = 10">10</button>
          </div>
          <div class="stepper" role="group" :aria-label="t('view.buchung.form.menge')">
            <button
              type="button"
              :disabled="menge <= 1"
              :aria-label="`Menge um 1 verringern`"
              @click="stepper(-1)"
            >
              −
            </button>
            <input
              v-model.number="menge"
              type="number"
              min="1"
              inputmode="numeric"
              required
              :aria-label="t('view.buchung.form.menge')"
            />
            <button type="button" :aria-label="`Menge um 1 erhöhen`" @click="stepper(1)">+</button>
          </div>
        </div>

        <div v-if="sollMengeErforderlich" class="menge-block">
          <span class="menge-label">{{ t('view.buchung.form.sollMenge') }} *</span>
          <div
            class="menge-schnellwahltasten"
            role="group"
            :aria-label="t('view.buchung.form.sollMenge')"
          >
            <button type="button" class="schnellwahl-taste" @click="sollMenge = 1">1</button>
            <button type="button" class="schnellwahl-taste" @click="sollMenge = 2">2</button>
            <button type="button" class="schnellwahl-taste" @click="sollMenge = 3">3</button>
            <button type="button" class="schnellwahl-taste" @click="sollMenge = 5">5</button>
            <button type="button" class="schnellwahl-taste" @click="sollMenge = 10">10</button>
          </div>
          <div class="stepper" role="group" :aria-label="t('view.buchung.form.sollMenge')">
            <button
              type="button"
              :disabled="sollMenge <= 0"
              :aria-label="`Sollmenge um 1 verringern`"
              @click="stepperSoll(-1)"
            >
              −
            </button>
            <input
              v-model.number="sollMenge"
              type="number"
              min="0"
              inputmode="numeric"
              required
              :aria-label="t('view.buchung.form.sollMenge')"
            />
            <button type="button" :aria-label="`Sollmenge um 1 erhöhen`" @click="stepperSoll(1)">
              +
            </button>
          </div>
        </div>

        <KommissionSelect
          v-model="projekt"
          :label="t('view.buchung.form.projekt')"
          :disabled="laufend"
        />
        <label>
          <span>{{ t('view.buchung.form.kommentar') }}</span>
          <input v-model="kommentar" autocomplete="off" inputmode="text" :disabled="laufend" />
        </label>

        <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>
        <p v-if="warnung" class="hint hint-warn" role="status">{{ warnung }}</p>
        <p v-if="mindestWarnung" class="hint hint-warn" role="status">{{ mindestWarnung }}</p>
        <p v-if="standardStandort" class="hint">Standard-Standort: {{ standardStandort.name }}</p>

        <!-- Sticky Save-Bar: auf Mobile immer in Daumenreichweite,
           auf Desktop normale Form-Actions. -->
        <div class="sticky-form-bar">
          <button type="submit" class="primary" :disabled="laufend">
            {{ laufend ? '…' : t('view.buchung.form.speichern') }}
          </button>
          <button type="button" class="btn" :disabled="laufend" @click="abbrechen">
            {{ t('view.buchung.form.abbrechen') }}
          </button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.typ-feldset {
  border: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.4rem;
}
.typ-feldset legend {
  color: var(--text-muted);
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0;
  margin-bottom: 0.25rem;
}

.menge-block {
  display: grid;
  gap: 0.3rem;
}
.menge-block > span {
  color: var(--text-muted);
  font-size: 0.85rem;
  font-weight: 500;
}

/* Sticky-Bar im Desktop-Modus entkoppeln vom Card-Rand. */
@media (min-width: 721px) {
  .card .sticky-form-bar {
    position: static;
    margin: 0;
    padding: 0;
    border: none;
    background: transparent;
  }
}
</style>
