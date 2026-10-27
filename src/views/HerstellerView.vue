<script setup lang="ts">
// Hersteller-Verwaltung (Admin-only).
//
// Hersteller sind Stammdaten mit Bestellkontakt. Der Mindestbestandsalarm
// nutzt `bestellEmail` (mailto:) bzw. `bestellWebseite` (Link) fuer den
// "Jetzt bestellen"-Button. Der Freitext `artikel.lieferant` bleibt fuer
// DATANORM/CSV erhalten, wird aber im Artikelformular aus dem Hersteller
// gespiegelt.

import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useHerstellerStore } from '../stores/hersteller'
import { useArtikelStore } from '../stores/artikel'

const { t } = useI18n()
const store = useHerstellerStore()
const artikelStore = useArtikelStore()

onMounted(() => {
  store.start()
  // Der Artikel-Store liefert die Stückzahl je Lieferant (Anzeige,
  // Löschen-Schutz) und die Artikel für die EK-Neuberechnung.
  artikelStore.start()
})

const neu = ref({ name: '', bestellEmail: '', bestellWebseite: '', rabattsatz: 0 })
const fehler = ref('')
const bearbeiteId = ref<string | null>(null)
const bearbeitung = ref({ name: '', bestellEmail: '', bestellWebseite: '', rabattsatz: 0 })
const speicherStatus = ref('')
let statusTimer: ReturnType<typeof setTimeout> | null = null

function anzahlArtikel(id: string): number {
  return artikelStore.artikel.filter((a) => a.herstellerId === id).length
}

function pruefe(name: string, email: string, rabattsatz: number): string | null {
  if (!name.trim()) return t('view.hersteller.fehlerName')
  if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return t('view.hersteller.fehlerEmail')
  }
  if (!Number.isFinite(rabattsatz) || rabattsatz < 0 || rabattsatz > 100) {
    return t('view.hersteller.fehlerRabatt')
  }
  return null
}

function status(meldung: string): void {
  speicherStatus.value = meldung
  if (statusTimer !== null) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => {
    speicherStatus.value = ''
    statusTimer = null
  }, 1500)
}

async function hinzufuegen(): Promise<void> {
  const f = pruefe(neu.value.name, neu.value.bestellEmail, neu.value.rabattsatz)
  if (f) {
    fehler.value = f
    return
  }
  if (store.byName(neu.value.name)) {
    fehler.value = t('view.hersteller.fehlerDuplikat')
    return
  }
  await store.anlegen({
    name: neu.value.name,
    bestellEmail: neu.value.bestellEmail,
    bestellWebseite: neu.value.bestellWebseite,
    rabattsatz: neu.value.rabattsatz,
  })
  neu.value = { name: '', bestellEmail: '', bestellWebseite: '', rabattsatz: 0 }
  fehler.value = ''
  status(t('view.hersteller.hinzugefuegt'))
}

function bearbeiten(id: string): void {
  const h = store.byId(id)
  if (!h) return
  bearbeiteId.value = id
  bearbeitung.value = {
    name: h.name,
    bestellEmail: h.bestellEmail ?? '',
    bestellWebseite: h.bestellWebseite ?? '',
    rabattsatz: h.rabattsatz ?? 0,
  }
  fehler.value = ''
}

function abbrechen(): void {
  bearbeiteId.value = null
  fehler.value = ''
}

async function speichern(): Promise<void> {
  if (!bearbeiteId.value) return
  const f = pruefe(
    bearbeitung.value.name,
    bearbeitung.value.bestellEmail,
    bearbeitung.value.rabattsatz,
  )
  if (f) {
    fehler.value = f
    return
  }
  const doppelt = store.byName(bearbeitung.value.name)
  if (doppelt && doppelt.id !== bearbeiteId.value) {
    fehler.value = t('view.hersteller.fehlerDuplikat')
    return
  }
  const id = bearbeiteId.value
  await store.aktualisieren(id, {
    name: bearbeitung.value.name.trim(),
    bestellEmail: bearbeitung.value.bestellEmail.trim() || null,
    bestellWebseite: bearbeitung.value.bestellWebseite.trim() || null,
    rabattsatz: bearbeitung.value.rabattsatz,
  })
  // Der Rabattsatz ist die Basis des "wahren Werts": die Einkaufspreise
  // der Artikel dieses Lieferanten werden sofort neu berechnet.
  const geaendert = await artikelStore.berechneEinkaufspreise(id, bearbeitung.value.rabattsatz)
  bearbeiteId.value = null
  fehler.value = ''
  status(
    geaendert > 0
      ? t('view.hersteller.gespeichertMitEinkaufspreisen', { anzahl: geaendert })
      : t('view.hersteller.gespeichert'),
  )
}

async function loeschen(id: string): Promise<void> {
  if (anzahlArtikel(id) > 0) return
  const h = store.byId(id)
  if (!h) return
  if (!window.confirm(t('view.hersteller.loeschenFrage', { name: h.name }))) return
  await store.loeschen(id)
  status(t('view.hersteller.geloescht'))
}

function webHref(web: string): string {
  return /^https?:\/\//i.test(web) ? web : `https://${web}`
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.hersteller.h1') }}</h1>
    </header>

    <p class="hint">{{ t('view.hersteller.hint') }}</p>

    <div class="card">
      <form class="neu-form" @submit.prevent="hinzufuegen">
        <label>
          <span>{{ t('view.hersteller.name') }}</span>
          <input v-model="neu.name" type="text" autocomplete="off" required />
        </label>
        <label>
          <span>{{ t('view.hersteller.bestellEmail') }}</span>
          <input v-model="neu.bestellEmail" type="email" autocomplete="off" />
        </label>
        <label>
          <span>{{ t('view.hersteller.bestellWebseite') }}</span>
          <input v-model="neu.bestellWebseite" type="text" autocomplete="off" />
        </label>
        <label>
          <span>{{ t('view.hersteller.rabattsatz') }}</span>
          <input
            v-model.number="neu.rabattsatz"
            type="number"
            min="0"
            max="100"
            step="0.1"
            data-testid="hersteller-rabattsatz"
          />
        </label>
        <button type="submit" class="primary">{{ t('view.hersteller.hinzufuegen') }}</button>
      </form>
      <p v-if="fehler && !bearbeiteId" class="fehler">{{ fehler }}</p>
    </div>

    <ul v-if="store.hersteller.length > 0" class="hersteller-list">
      <li v-for="h in store.hersteller" :key="h.id" class="card row">
        <template v-if="bearbeiteId === h.id">
          <form class="edit-form" @submit.prevent="speichern">
            <label>
              <span>{{ t('view.hersteller.name') }}</span>
              <input v-model="bearbeitung.name" type="text" autocomplete="off" required />
            </label>
            <label>
              <span>{{ t('view.hersteller.bestellEmail') }}</span>
              <input v-model="bearbeitung.bestellEmail" type="email" autocomplete="off" />
            </label>
            <label>
              <span>{{ t('view.hersteller.bestellWebseite') }}</span>
              <input v-model="bearbeitung.bestellWebseite" type="text" autocomplete="off" />
            </label>
            <label>
              <span>{{ t('view.hersteller.rabattsatz') }}</span>
              <input
                v-model.number="bearbeitung.rabattsatz"
                type="number"
                min="0"
                max="100"
                step="0.1"
                data-testid="hersteller-rabattsatz-bearbeiten"
              />
            </label>
            <div class="row-actions">
              <button type="submit" class="primary">{{ t('view.hersteller.speichern') }}</button>
              <button type="button" @click="abbrechen">{{ t('view.hersteller.abbrechen') }}</button>
            </div>
            <p v-if="fehler" class="fehler">{{ fehler }}</p>
          </form>
        </template>
        <template v-else>
          <span class="row-title">
            {{ h.name }}
            <span v-if="(h.rabattsatz ?? 0) > 0" class="rabatt-badge">
              {{ t('view.hersteller.rabattsatzAnzeige', { rabatt: h.rabattsatz }) }}
            </span>
          </span>
          <span class="row-meta">
            <a v-if="h.bestellEmail" :href="`mailto:${h.bestellEmail}`">{{ h.bestellEmail }}</a>
            <a
              v-if="h.bestellWebseite"
              :href="webHref(h.bestellWebseite)"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ h.bestellWebseite }}
            </a>
            <span v-if="!h.bestellEmail && !h.bestellWebseite" class="ohne-kontakt">
              {{ t('view.hersteller.keinKontakt') }}
            </span>
          </span>
          <span class="row-meta">
            {{ t('view.hersteller.anzahlArtikel', { n: anzahlArtikel(h.id) }) }}
          </span>
          <span class="row-actions">
            <button type="button" @click="bearbeiten(h.id)">
              {{ t('view.hersteller.bearbeiten') }}
            </button>
            <button
              type="button"
              class="danger"
              :disabled="anzahlArtikel(h.id) > 0"
              :title="
                anzahlArtikel(h.id) > 0
                  ? t('view.hersteller.loeschenGenutzt')
                  : t('view.hersteller.loeschen')
              "
              @click="loeschen(h.id)"
            >
              {{ t('view.hersteller.loeschen') }}
            </button>
          </span>
        </template>
      </li>
    </ul>
    <p v-else class="empty-state">{{ t('view.hersteller.leer') }}</p>

    <p v-if="speicherStatus" class="hint hint-ok" role="status" aria-live="polite">
      {{ speicherStatus }}
    </p>
  </section>
</template>

<style scoped>
.neu-form {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto auto;
  gap: 0.5rem;
  align-items: end;
}
.neu-form label,
.edit-form label {
  margin: 0;
}

.hersteller-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: grid;
  grid-template-columns: 1fr 1.2fr auto auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.7rem 1rem;
}

.row-title {
  font-weight: 600;
  color: var(--text-strong);
}

.rabatt-badge {
  margin-left: 0.4rem;
  padding: 0.1rem 0.4rem;
  border-radius: calc(var(--radius-sm) - 2px);
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 600;
}

.row-meta {
  color: var(--text-muted);
  font-size: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  overflow-wrap: anywhere;
}

.ohne-kontakt {
  font-style: italic;
}

.row-actions {
  display: flex;
  gap: 0.3rem;
}

.edit-form {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: 0.5rem;
  align-items: end;
}
.edit-form .row-actions {
  grid-column: 1 / -1;
}

@media (max-width: 800px) {
  .neu-form,
  .row,
  .edit-form {
    grid-template-columns: 1fr;
  }
  .row-actions {
    justify-content: flex-end;
  }
}
</style>
