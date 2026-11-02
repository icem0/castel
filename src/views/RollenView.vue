<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'
import { apiFetch } from '../auth/api'

const auth = useAuthStore()
const router = useRouter()

// Nur admins dueren diese Seite
if (!auth.hat('benutzer.verwalten')) {
  router.push('/')
}

type RolleDto = {
  id: string
  titel: string
  beschreibung: string
  berechtigungen: string[]
  aktiv: boolean
}

type BerechtigungDto = {
  id: string
  titel: string
  beschreibung: string
}

const rollen = ref<RolleDto[]>([])
const alleBerechtigungen = ref<BerechtigungDto[]>([])

const laden = ref(false)
const fehler = ref('')
const meldung = ref('')

// Formular fuer neue Rolle
const formularOffen = ref(false)
const neueId = ref('')
const neueName = ref('')
const neueBeschreibung = ref('')
const neueBerechtigungen = ref<string[]>([])

// Bearbeitung einer bestehenden Rolle
const bearbeiteteRolle = ref<string | null>(null)
const bearbeiteName = ref('')
const bearbeiteBeschreibung = ref('')
const bearbeiteBerechtigungen = ref<string[]>([])
const bearbeiteAktiv = ref(true)
const bearbeitenLaden = ref(false)

async function ladeDaten(): Promise<void> {
  laden.value = true
  try {
    const daten = await apiFetch<{ rollen: RolleDto[]; berechtigungen: BerechtigungDto[] }>(
      '/api/rollen',
    )
    rollen.value = daten.rollen.map((r) => ({
      id: r.id,
      titel: r.titel,
      beschreibung: r.beschreibung,
      berechtigungen: r.berechtigungen,
      aktiv: r.aktiv,
    }))
    alleBerechtigungen.value = daten.berechtigungen
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : 'Daten konnten nicht geladen werden'
  } finally {
    laden.value = false
  }
}

async function rolleAnlegen(): Promise<void> {
  if (!neueId.value.trim() || !neueName.value.trim()) {
    fehler.value = 'ID und Name sind erforderlich'
    return
  }
  laden.value = true
  fehler.value = ''
  try {
    await apiFetch('/api/rollen', {
      method: 'POST',
      body: {
        id: neueId.value.trim(),
        name: neueName.value.trim(),
        beschreibung: neueBeschreibung.value.trim(),
        berechtigungen: neueBerechtigungen.value,
      },
    })
    formularOffen.value = false
    neueId.value = ''
    neueName.value = ''
    neueBeschreibung.value = ''
    neueBerechtigungen.value = []
    meldung.value = 'Rolle angelegt'
    await ladeDaten()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : 'Rolle konnte nicht angelegt werden'
  } finally {
    laden.value = false
  }
}

async function rolleLoeschen(id: string): Promise<void> {
  if (!confirm('Rolle wirklich loeschen?')) return
  laden.value = true
  try {
    await apiFetch(`/api/rollen/${id}`, { method: 'DELETE' })
    meldung.value = 'Rolle geloescht'
    await ladeDaten()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : 'Rolle konnte nicht geloescht werden'
  } finally {
    laden.value = false
  }
}

function bearbeitenOeffnen(r: RolleDto): void {
  bearbeiteteRolle.value = r.id
  bearbeiteName.value = r.titel
  bearbeiteBeschreibung.value = r.beschreibung
  bearbeiteBerechtigungen.value = [...r.berechtigungen]
  bearbeiteAktiv.value = r.aktiv
}

async function bearbeitenSpeichern(): Promise<void> {
  if (!bearbeiteteRolle.value) return
  bearbeitenLaden.value = true
  try {
    await apiFetch(`/api/rollen/${bearbeiteteRolle.value}`, {
      method: 'PATCH',
      body: {
        name: bearbeiteName.value.trim(),
        beschreibung: bearbeiteBeschreibung.value.trim(),
        aktiv: bearbeiteAktiv.value,
      },
    })
    bearbeiteteRolle.value = null
    meldung.value = 'Rolle aktualisiert'
    await ladeDaten()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : 'Rolle konnte nicht aktualisiert werden'
  } finally {
    bearbeitenLaden.value = false
  }
}

async function berechtigungenSpeichern(id: string): Promise<void> {
  const r = rollen.value.find((x) => x.id === id)
  if (!r) return
  laden.value = true
  try {
    await apiFetch(`/api/rollen/${id}/berechtigungen`, {
      method: 'PATCH',
      body: { berechtigungen: r.berechtigungen },
    })
    meldung.value = 'Berechtigungen aktualisiert'
  } catch (e) {
    fehler.value =
      e instanceof Error ? e.message : 'Berechtigungen konnten nicht aktualisiert werden'
  } finally {
    laden.value = false
  }
}

function toggleBerechtigung(liste: string[], id: string): void {
  const idx = liste.indexOf(id)
  if (idx >= 0) liste.splice(idx, 1)
  else liste.push(id)
}

function istAdminRolle(id: string): boolean {
  return id === 'admin'
}

onMounted(ladeDaten)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>Rollen &amp; Berechtigungen</h1>
    </header>

    <div v-if="fehler" class="fehler" role="alert">{{ fehler }}</div>
    <div v-if="meldung" class="meldung">{{ meldung }}</div>

    <div v-if="laden" class="lade">Lade&#8230;</div>

    <div v-else>
      <h2>Rollen</h2>
      <table v-if="rollen.length > 0" class="data">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Beschreibung</th>
            <th>Berechtigungen</th>
            <th>Aktiv</th>
            <th>Aktionen</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rollen" :key="r.id">
            <td>{{ r.id }}</td>
            <td>{{ r.titel }}</td>
            <td>{{ r.beschreibung }}</td>
            <td>
              <span v-for="b in r.berechtigungen" :key="b" class="badge perm">{{ b }}</span>
            </td>
            <td>
              <span :class="r.aktiv ? 'badge success' : 'badge danger'">
                {{ r.aktiv ? 'aktiv' : 'inaktiv' }}
              </span>
            </td>
            <td class="actions-cell">
              <button v-if="!istAdminRolle(r.id)" type="button" @click="bearbeitenOeffnen(r)">
                Bearbeiten
              </button>
              <button
                v-if="!istAdminRolle(r.id)"
                type="button"
                class="danger"
                @click="rolleLoeschen(r.id)"
              >
                Loeschen
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="empty-state">Noch keine Rollen angelegt.</div>

      <h2>Berechtigungen pro Rolle aendern</h2>
      <div v-if="rollen.length > 0" class="berechtigungs-matrix">
        <div v-for="r in rollen" :key="r.id" class="rolle-karte">
          <h3>{{ r.titel }} <span v-if="istAdminRolle(r.id)" class="badge">admin</span></h3>
          <p>{{ r.beschreibung }}</p>
          <div class="checkbox-gruppe">
            <label v-for="b in alleBerechtigungen" :key="b.id" class="checkbox-label">
              <input
                type="checkbox"
                :checked="r.berechtigungen.includes(b.id)"
                :disabled="istAdminRolle(r.id)"
                @change="toggleBerechtigung(r.berechtigungen, b.id)"
              />
              {{ b.titel }}
            </label>
          </div>
          <button
            v-if="!istAdminRolle(r.id)"
            type="button"
            :disabled="laden"
            @click="berechtigungenSpeichern(r.id)"
          >
            Speichern
          </button>
        </div>
      </div>

      <h2>Neue Rolle anlegen</h2>
      <div v-if="!formularOffen" class="aktion">
        <button type="button" class="primary" @click="formularOffen = true">
          Rolle hinzufuegen
        </button>
      </div>

      <div v-if="formularOffen" class="card">
        <form class="form" @submit.prevent="rolleAnlegen">
          <label>
            <span>ID (interner Schl&#252;ssel)</span>
            <input v-model="neueId" type="text" placeholder="z. B. lagerist" />
          </label>
          <label>
            <span>Anzeigename</span>
            <input v-model="neueName" type="text" />
          </label>
          <label>
            <span>Beschreibung</span>
            <input v-model="neueBeschreibung" type="text" />
          </label>
          <fieldset class="berechtigung-fieldset">
            <legend>Berechtigungen</legend>
            <div class="checkbox-gruppe">
              <label v-for="b in alleBerechtigungen" :key="b.id" class="checkbox-label">
                <input
                  type="checkbox"
                  :model-value="neueBerechtigungen"
                  @change="toggleBerechtigung(neueBerechtigungen, b.id)"
                />
                {{ b.titel }}
              </label>
            </div>
          </fieldset>
          <div class="form-actions">
            <button type="button" @click="formularOffen = false">Abbrechen</button>
            <button type="submit" class="primary" :disabled="laden">Anlegen</button>
          </div>
        </form>
      </div>

      <div v-if="bearbeiteteRolle" class="card">
        <h3>Rollen bearbeiten: {{ bearbeiteName }}</h3>
        <form class="form" @submit.prevent="bearbeitenSpeichern">
          <label>
            <span>Anzeigename</span>
            <input v-model="bearbeiteName" type="text" />
          </label>
          <label>
            <span>Beschreibung</span>
            <input v-model="bearbeiteBeschreibung" type="text" />
          </label>
          <label>
            <span>Aktiv</span>
            <input v-model="bearbeiteAktiv" type="checkbox" />
          </label>
          <div class="form-actions">
            <button type="button" @click="bearbeiteteRolle = null">Abbrechen</button>
            <button type="submit" class="primary" :disabled="bearbeitenLaden">Speichern</button>
          </div>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.perm {
  font-size: 0.85rem;
  margin: 0.1rem;
}
.checkbox-gruppe {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 0.5rem 0;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}
.checkbox-label input {
  width: auto;
}
.berechtigungs-matrix {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
.rolle-karte {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  width: min(300px, 100%);
  background: var(--bg-card);
}
.rolle-karte h3 {
  margin: 0 0 0.5rem;
}
.berechtigung-fieldset {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1rem;
  margin: 1rem 0;
}
.berechtigung-fieldset legend {
  padding: 0 0.5rem;
  font-size: 0.9rem;
  color: var(--text-muted);
}
.meldung {
  background: var(--success-bg);
  color: var(--success-text);
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
}
</style>
