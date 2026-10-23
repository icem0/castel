<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useArtikelStore } from '../stores/artikel'
import { useBuchungStore } from '../stores/buchung'
import { useStandortStore } from '../stores/standort'
import { useAuthStore } from '../stores/auth'
import { formatiereCent } from '../domain/geld'
import {
  berechneKpis,
  bestandProStandort,
  bewegungenProZeitraum,
  handlungsbedarf,
  lagerwertAuswertung,
  letzteBuchungen,
  topArtikelNachBewegung,
  type ZeitraumTage,
} from '../domain/statistik'
import type { Buchung } from '../db/types'
import SaeulenDiagramm, { type SaeulenSerie } from './components/dashboard/SaeulenDiagramm.vue'
import BalkenDiagramm, { type BalkenEintrag } from './components/dashboard/BalkenDiagramm.vue'
import HandlungsbedarfListe from './components/dashboard/HandlungsbedarfListe.vue'
import LetzteBuchungen, {
  type LetzteBuchungEintrag,
} from './components/dashboard/LetzteBuchungen.vue'

const { t, locale } = useI18n()
const artikelStore = useArtikelStore()
const buchungStore = useBuchungStore()
const standortStore = useStandortStore()
const auth = useAuthStore()

const zeitraum = ref<ZeitraumTage>(30)
const zeitraumOptionen: Array<{ value: ZeitraumTage; labelKey: string }> = [
  { value: 7, labelKey: 'view.dashboard.zeitraum.tage7' },
  { value: 30, labelKey: 'view.dashboard.zeitraum.tage30' },
  { value: 90, labelKey: 'view.dashboard.zeitraum.tage90' },
]

const kpis = computed(() =>
  berechneKpis({
    artikel: artikelStore.artikel,
    buchungen: buchungStore.buchungen,
    standorte: standortStore.standorte,
    tage: zeitraum.value,
  }),
)

const bestand = computed(() => bewegungenProZeitraum(buchungStore.buchungen, zeitraum.value))

function formatBucketLabel(iso: string): string {
  const datum = new Date(iso)
  return new Intl.DateTimeFormat(locale.value, {
    day: '2-digit',
    month: '2-digit',
  }).format(datum)
}

const bewegungsLabels = computed(() => bestand.value.map((b) => formatBucketLabel(b.vonIso)))

const bewegungsSerien = computed<SaeulenSerie[]>(() => [
  {
    key: 'einlagerung',
    label: t('view.dashboard.diagramme.einlagerung'),
    color: 'var(--accent)',
    values: bestand.value.map((b) => b.einlagerung),
  },
  {
    key: 'entnahme',
    label: t('view.dashboard.diagramme.entnahme'),
    color: 'var(--danger, #dc2626)',
    values: bestand.value.map((b) => b.entnahme),
  },
  {
    key: 'umlagerung',
    label: t('view.dashboard.diagramme.umlagerung'),
    color: '#94a3b8',
    values: bestand.value.map((b) => b.umlagerung),
  },
])

function formatiereMenge(menge: number): string {
  return `${menge > 0 ? '+' : ''}${menge}`
}

const standortBalken = computed<BalkenEintrag[]>(() =>
  bestandProStandort(buchungStore.buchungen, standortStore.standorte)
    .slice(0, 8)
    .map((s) => ({
      key: s.standortId,
      label: s.name,
      value: s.menge,
      text: t('view.dashboard.stueck', { menge: s.menge }),
    })),
)

const bedarf = computed(() =>
  handlungsbedarf(artikelStore.artikel, buchungStore.buchungen, standortStore.standorte, 5),
)

const topBewegung = computed<BalkenEintrag[]>(() =>
  topArtikelNachBewegung(artikelStore.artikel, buchungStore.buchungen, zeitraum.value).map((a) => ({
    key: a.artikelId,
    label: a.titel,
    value: a.menge,
    text: t('view.dashboard.stueck', { menge: a.menge }),
    to: `/artikel/${a.artikelId}`,
  })),
)

const wert = computed(() =>
  lagerwertAuswertung(artikelStore.artikel, buchungStore.buchungen, standortStore.standorte),
)

const wertBalken = computed<BalkenEintrag[]>(() =>
  wert.value.proStandort.slice(0, 8).map((s) => ({
    key: s.standortId,
    label: s.name,
    value: s.wertCent,
    text: formatiereCent(s.wertCent, locale.value),
  })),
)

const topWert = computed<BalkenEintrag[]>(() =>
  wert.value.topArtikel.map((a) => ({
    key: a.artikelId,
    label: a.titel,
    value: a.wertCent,
    text: formatiereCent(a.wertCent, locale.value),
    to: `/artikel/${a.artikelId}`,
  })),
)

function formatTyp(typ: Buchung['typ']): string {
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

function standortName(id: string): string {
  return standortStore.byId(id)?.name ?? '—'
}

const letzte = computed<LetzteBuchungEintrag[]>(() =>
  letzteBuchungen(buchungStore.buchungen, 8).map((b) => ({
    id: b.id,
    artikelId: b.artikelId,
    artikelTitel: artikelStore.byId(b.artikelId)?.titel ?? '—',
    typLabel: formatTyp(b.typ),
    mengeText: formatiereMenge(b.menge),
    standortName: standortName(b.standortId),
    zeitText: new Date(b.erstelltAm).toLocaleString(locale.value),
    erstelltVon: b.erstelltVon,
    storno: b.storno || b.typ === 'storno',
  })),
)

const leer = computed(
  () =>
    artikelStore.artikel.length === 0 &&
    standortStore.standorte.length === 0 &&
    buchungStore.buchungen.length === 0,
)
</script>

<template>
  <section class="view dashboard">
    <header class="view-head dashboard-head">
      <h1>{{ t('view.dashboard.h1') }}</h1>
      <div class="zeitraum-switch" role="group" :aria-label="t('view.dashboard.zeitraum.aria')">
        <button
          v-for="option in zeitraumOptionen"
          :key="option.value"
          type="button"
          class="zeitraum-btn"
          :class="{ aktiv: zeitraum === option.value }"
          :aria-pressed="zeitraum === option.value"
          @click="zeitraum = option.value"
        >
          {{ t(option.labelKey) }}
        </button>
      </div>
    </header>

    <p v-if="leer" class="empty-state">{{ t('view.dashboard.leer') }}</p>

    <template v-else>
      <div class="card-grid dashboard-kpis">
        <RouterLink to="/artikel" class="card stat-card">
          <strong>{{ kpis.aktiveArtikel }}</strong>
          <span>{{ t('view.dashboard.kpi.artikel') }}</span>
        </RouterLink>
        <div class="card stat-card stat-static">
          <strong>{{ kpis.bestandGesamt }}</strong>
          <span>{{ t('view.dashboard.kpi.bestand') }}</span>
        </div>
        <RouterLink to="/standorte" class="card stat-card">
          <strong>{{ kpis.aktiveStandorte }}</strong>
          <span>{{ t('view.dashboard.kpi.standorte') }}</span>
        </RouterLink>
        <RouterLink to="/buchungen" class="card stat-card">
          <strong>{{ kpis.buchungenImZeitraum }}</strong>
          <span>{{ t('view.dashboard.kpi.buchungen') }}</span>
        </RouterLink>
        <RouterLink to="/artikel" class="card stat-card stat-warn">
          <strong>{{ kpis.handlungsbedarfAnzahl }}</strong>
          <span>{{ t('view.dashboard.kpi.handlungsbedarf') }}</span>
        </RouterLink>
        <div v-if="auth.istAdmin" class="card stat-card stat-static stat-value">
          <strong>{{ formatiereCent(kpis.lagerwertCent, locale) }}</strong>
          <span>{{ t('view.dashboard.kpi.lagerwert') }}</span>
        </div>
      </div>

      <div class="dashboard-grid">
        <section class="card dashboard-span-2">
          <header class="card-head">
            <h2>{{ t('view.dashboard.diagramme.bewegungen') }}</h2>
            <span class="card-sub">{{ t('view.dashboard.diagramme.bewegungenSub') }}</span>
          </header>
          <SaeulenDiagramm
            :labels="bewegungsLabels"
            :series="bewegungsSerien"
            :beschreibung="t('view.dashboard.diagramme.bewegungenAria')"
            :leer-text="t('view.dashboard.diagramme.leer')"
          />
        </section>

        <section class="card">
          <header class="card-head">
            <h2>{{ t('view.dashboard.diagramme.standorte') }}</h2>
            <span class="card-sub">{{ t('view.dashboard.diagramme.standorteSub') }}</span>
          </header>
          <BalkenDiagramm
            :eintraege="standortBalken"
            :beschreibung="t('view.dashboard.diagramme.standorteAria')"
            :leer-text="t('view.dashboard.diagramme.leer')"
          />
        </section>

        <section id="handlungsbedarf" class="card">
          <header class="card-head">
            <h2>{{ t('view.dashboard.handlungsbedarf.titel') }}</h2>
            <span class="card-sub">
              {{ t('view.dashboard.handlungsbedarf.anzahl', { anzahl: bedarf.anzahl }) }}
            </span>
          </header>
          <HandlungsbedarfListe :eintraege="bedarf.eintraege" />
        </section>

        <section class="card">
          <header class="card-head">
            <h2>{{ t('view.dashboard.diagramme.topBewegung') }}</h2>
            <span class="card-sub">{{ t('view.dashboard.diagramme.topBewegungSub') }}</span>
          </header>
          <BalkenDiagramm
            :eintraege="topBewegung"
            :beschreibung="t('view.dashboard.diagramme.topBewegungAria')"
            :leer-text="t('view.dashboard.diagramme.leer')"
          />
        </section>

        <section class="card">
          <header class="card-head">
            <h2>{{ t('view.dashboard.letzteBuchungen.titel') }}</h2>
            <RouterLink to="/buchungen" class="card-link">
              {{ t('view.dashboard.letzteBuchungen.alle') }}
            </RouterLink>
          </header>
          <LetzteBuchungen :eintraege="letzte" />
        </section>

        <section v-if="auth.istAdmin" class="card dashboard-span-2 admin-wert">
          <header class="card-head">
            <h2>{{ t('view.dashboard.wert.titel') }}</h2>
            <span class="card-sub">
              {{
                t('view.dashboard.wert.gesamt', { wert: formatiereCent(wert.gesamtCent, locale) })
              }}
            </span>
          </header>

          <p v-if="wert.artikelOhneEinkaufspreis > 0" class="hint">
            {{ t('view.dashboard.wert.ohnePreis', { anzahl: wert.artikelOhneEinkaufspreis }) }}
          </p>

          <div class="wert-grid">
            <div>
              <h3>{{ t('view.dashboard.wert.proStandort') }}</h3>
              <BalkenDiagramm
                :eintraege="wertBalken"
                :beschreibung="t('view.dashboard.wert.proStandortAria')"
                :leer-text="t('view.dashboard.diagramme.leer')"
              />
            </div>
            <div>
              <h3>{{ t('view.dashboard.wert.topArtikel') }}</h3>
              <BalkenDiagramm
                :eintraege="topWert"
                :beschreibung="t('view.dashboard.wert.topArtikelAria')"
                :leer-text="t('view.dashboard.diagramme.leer')"
              />
            </div>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.dashboard-head {
  align-items: center;
}

.zeitraum-switch {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.2rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-card);
}

.zeitraum-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 0.3rem 0.65rem;
  border-radius: calc(var(--radius-sm) - 2px);
  font-size: 0.8rem;
  cursor: pointer;
}

.zeitraum-btn.aktiv {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}

.dashboard-kpis {
  margin-bottom: 0.75rem;
}

.stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  text-decoration: none;
  color: var(--text-strong);
  transition:
    transform 0.15s,
    border-color 0.15s;
}

a.stat-card:hover {
  text-decoration: none;
  border-color: var(--accent-border);
  transform: translateY(-1px);
}

.stat-static {
  cursor: default;
}

.stat-card strong {
  font-size: 2.1rem;
  font-weight: 700;
  line-height: 1;
  color: var(--accent);
}

.stat-card span {
  font-size: 0.82rem;
  color: var(--text-muted);
  font-weight: 500;
}

.stat-warn strong {
  color: var(--danger, #dc2626);
}

.stat-value strong {
  font-size: 1.55rem;
  color: var(--text-strong);
}

.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}

.dashboard-grid .card {
  margin: 0;
  min-width: 0;
}

.dashboard-span-2 {
  grid-column: 1 / -1;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
}

.card-head h2 {
  margin: 0;
  font-size: 1rem;
}

.card-head h3 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: var(--text-muted);
  font-weight: 600;
}

.card-sub {
  color: var(--text-muted);
  font-size: 0.78rem;
  text-align: right;
}

.card-link {
  font-size: 0.78rem;
}

.wert-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}

.admin-wert {
  border-color: var(--accent-border);
}

.hint {
  margin: 0 0 0.75rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
  .dashboard-span-2 {
    grid-column: auto;
  }
  .wert-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .dashboard-head {
    align-items: flex-start;
  }
  .stat-card strong {
    font-size: 1.8rem;
  }
  .stat-value strong {
    font-size: 1.35rem;
  }
}
</style>
