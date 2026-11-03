<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useUserStore } from '../stores/users'
import { useRollenStore } from '../stores/rollen'
import { MIN_PASSWORT_LAENGE, generiereEinmalpasswort } from '../auth/policy'
import { ROLLEN, type Rolle } from '../domain/rollen'

const auth = useAuthStore()
const userStore = useUserStore()
const rollenStore = useRollenStore()

const formularOffen = ref(false)
const anzeigename = ref('')
const email = ref('')
const passwort = ref('')
/** Rollen des neuen Users. 'user' ist die Basis und immer dabei. */
const neueRollen = ref<Rolle[]>(['user'])
const fehler = ref('')
const laufend = ref(false)

type ResetAnzeige = { id: string; email: string; passwort: string }
const resetAnzeige = ref<ResetAnzeige | null>(null)
const kopiert = ref(false)
let kopiertTimer: ReturnType<typeof setTimeout> | null = null

/** Rollen, die zusaetzlich zu 'user' vergeben werden koennen. */
const wahlRollen = computed(() => ROLLEN.filter((r) => r !== 'user'))

/** Rollen-Editor fuer einen bestehenden User. */
const rollenUserId = ref<string | null>(null)
const rollenAuswahl = ref<Rolle[]>(['user'])
const rollenLaufend = ref(false)

function rollenVon(u: { rollen?: Rolle[]; rolle?: 'admin' | 'user' }): Rolle[] {
  if (u.rollen && u.rollen.length > 0) return u.rollen
  return u.rolle === 'admin' ? ['admin'] : ['user']
}

const aktiveAdminAnzahl = computed(
  () => userStore.users.filter((u) => rollenVon(u).includes('admin') && u.aktiv).length,
)

onMounted(async () => {
  await Promise.all([userStore.laden(), rollenStore.laden()])
})

/**
 * Schaltet eine Rolle um. 'admin' ist exklusiv — wer admin ist, hat alle
 * Rechte und braucht keine weiteren Rollen.
 */
function toggleRolle(auswahl: Rolle[], rolle: Rolle): Rolle[] {
  if (rolle === 'admin') {
    return auswahl.includes('admin') ? ['user'] : ['admin']
  }
  const ohneLagerist = auswahl.filter((r) => r !== 'lagerist' && r !== 'admin')
  if (auswahl.includes('lagerist')) return ohneLagerist
  return [...ohneLagerist, 'lagerist']
}

async function anlegen(): Promise<void> {
  fehler.value = ''
  if (!email.value.trim() || !passwort.value) {
    fehler.value = 'E-Mail und Passwort erforderlich.'
    return
  }
  if (passwort.value.length < MIN_PASSWORT_LAENGE) {
    fehler.value = `Passwort muss mindestens ${MIN_PASSWORT_LAENGE} Zeichen haben.`
    return
  }
  laufend.value = true
  try {
    await auth.neuerUser({
      email: email.value,
      passwort: passwort.value,
      rollen: neueRollen.value,
      anzeigename: anzeigename.value,
    })
    formularOffen.value = false
    anzeigename.value = ''
    email.value = ''
    passwort.value = ''
    neueRollen.value = ['user']
    await userStore.laden()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufend.value = false
  }
}

async function deaktivieren(id: string): Promise<void> {
  if (!confirm('Benutzer wirklich deaktivieren?')) return
  try {
    await auth.setzeAktiv(id, false)
    await userStore.laden()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function aktivieren(id: string): Promise<void> {
  try {
    await auth.setzeAktiv(id, true)
    await userStore.laden()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function loeschen(id: string, mail: string): Promise<void> {
  if (
    !confirm(
      `Benutzer „${mail}" endgültig löschen?\n\n` +
        'Konto, API-Keys und Einstellungen werden entfernt. Buchungen und Audit-Log bleiben erhalten.',
    )
  ) {
    return
  }
  try {
    await auth.loescheUser(id)
    await userStore.laden()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function anzeigenameAendern(id: string, aktuell: string): Promise<void> {
  const eingabe = prompt('Anzeigename', aktuell)
  if (eingabe === null) return
  const neuerName = eingabe.trim()
  if (!neuerName) {
    alert('Anzeigename darf nicht leer sein.')
    return
  }
  try {
    await auth.aendereAnzeigename(id, neuerName)
    await userStore.laden()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

function rollenEditorOeffnen(id: string): void {
  const u = userStore.users.find((x) => x.id === id)
  if (!u) return
  rollenUserId.value = id
  rollenAuswahl.value = [...rollenVon(u)]
}

async function rollenSpeichern(): Promise<void> {
  const id = rollenUserId.value
  if (!id) return
  const u = userStore.users.find((x) => x.id === id)
  if (!u) return
  const vorher = rollenVon(u)
  // Letzten aktiven Admin nicht degradieren.
  if (
    vorher.includes('admin') &&
    !rollenAuswahl.value.includes('admin') &&
    u.aktiv &&
    aktiveAdminAnzahl.value <= 1
  ) {
    alert('Letzter aktiver Admin kann nicht degradiert werden.')
    rollenAuswahl.value = [...vorher]
    return
  }
  rollenLaufend.value = true
  try {
    await auth.aendereRollen(id, rollenAuswahl.value)
    rollenUserId.value = null
    await userStore.laden()
    // Der Admin selbst sieht die neue Rolle sofort — Session aktualisieren.
    if (id === auth.userId) await auth.aktualisiereSession()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  } finally {
    rollenLaufend.value = false
  }
}

async function passwortZuruecksetzen(id: string): Promise<void> {
  const u = userStore.users.find((x) => x.id === id)
  if (!u) return
  const neuesPasswort = generiereEinmalpasswort()
  try {
    await auth.setzePasswortFuer(id, neuesPasswort)
    resetAnzeige.value = { id: u.id, email: u.email, passwort: neuesPasswort }
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
}

async function kopiereEinmalpasswort(): Promise<void> {
  const pw = resetAnzeige.value?.passwort
  if (!pw) return
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(pw)
    } else {
      const ta = document.createElement('textarea')
      ta.value = pw
      ta.setAttribute('readonly', '')
      ta.style.position = 'absolute'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (!ok) throw new Error('execCommand(copy) fehlgeschlagen')
    }
    kopiert.value = true
    if (kopiertTimer !== null) clearTimeout(kopiertTimer)
    kopiertTimer = setTimeout(() => {
      kopiert.value = false
    }, 2000)
  } catch {
    alert('Kopieren in die Zwischenablage fehlgeschlagen.')
  }
}

function formatDatum(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>Benutzer-Verwaltung</h1>
      <div class="head-actions">
        <RouterLink to="/einstellungen/rollen" class="btn">Rollen &amp; Berechtigungen</RouterLink>
        <button type="button" class="primary" @click="formularOffen = !formularOffen">
          {{ formularOffen ? 'Abbrechen' : 'Neuer Benutzer' }}
        </button>
      </div>
    </header>

    <p class="hint">
      <RouterLink to="/einstellungen">← zurück zu Einstellungen</RouterLink>
    </p>

    <!-- Rollen-Legende: kommt vom Server (eine Quelle der Wahrheit) -->
    <div class="card rollen-legend">
      <h2>Rollen und Berechtigungen</h2>
      <p class="hint">
        Die Rechte sind stapelbar: ein Benutzer kann mehrere Rollen haben. <b>Admin</b> hat alle
        Rechte und braucht keine weiteren Rollen.
      </p>
      <div class="rollen-legend-liste">
        <div v-for="r in rollenStore.rollen" :key="r.id" class="rollen-legend-eintrag">
          <h3>{{ rollenStore.titel(r.id) }}</h3>
          <p class="rollen-legend-beschreibung">{{ rollenStore.beschreibung(r.id) }}</p>
          <ul>
            <li v-for="recht in rollenStore.rechte(r.id)" :key="recht">{{ recht }}</li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="formularOffen" class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="anlegen">
        <label>
          <span>Anzeigename (optional, sonst E-Mail-Teil)</span>
          <input v-model="anzeigename" type="text" autocomplete="off" :disabled="laufend" />
        </label>
        <label>
          <span>E-Mail</span>
          <input v-model="email" type="email" required autocomplete="off" :disabled="laufend" />
        </label>
        <label>
          <span>Passwort (≥ {{ MIN_PASSWORT_LAENGE }} Zeichen)</span>
          <input
            v-model="passwort"
            type="password"
            required
            autocomplete="new-password"
            :disabled="laufend"
          />
        </label>
        <fieldset class="rollen-wahl">
          <legend>Rollen</legend>
          <label class="rollen-option">
            <input type="checkbox" checked disabled />
            <span>User (Basis)</span>
          </label>
          <label
            v-for="r in wahlRollen"
            :key="r"
            class="rollen-option"
            :title="rollenStore.beschreibung(r)"
          >
            <input
              type="checkbox"
              :checked="neueRollen.includes(r)"
              :disabled="laufend"
              @change="neueRollen = toggleRolle(neueRollen, r)"
            />
            <span>{{ rollenStore.titel(r) }}</span>
          </label>
        </fieldset>
        <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="laufend">
            {{ laufend ? 'Lege an …' : 'Anlegen' }}
          </button>
        </div>
      </form>
    </div>

    <table v-if="userStore.users.length > 0" class="data">
      <thead>
        <tr>
          <th>Anzeigename</th>
          <th>E-Mail</th>
          <th>Rollen</th>
          <th>Aktiv</th>
          <th>Erstellt</th>
          <th>Letzter Login</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in userStore.users" :key="u.id">
          <td>{{ u.anzeigename || '—' }}</td>
          <td>{{ u.email }}</td>
          <td>
            <span
              v-for="r in rollenVon(u)"
              :key="r"
              class="badge"
              :class="{ accent: r === 'admin' }"
            >
              {{ rollenStore.titel(r) }}
            </span>
          </td>
          <td>
            <span :class="u.aktiv ? 'badge success' : 'badge danger'">
              {{ u.aktiv ? 'aktiv' : 'inaktiv' }}
            </span>
          </td>
          <td>{{ formatDatum(u.erstelltAm) }}</td>
          <td>{{ formatDatum(u.letzterLoginAm) }}</td>
          <td class="actions-cell">
            <button
              type="button"
              :disabled="rollenVon(u).includes('admin') && u.aktiv && aktiveAdminAnzahl <= 1"
              :title="
                rollenVon(u).includes('admin') && u.aktiv && aktiveAdminAnzahl <= 1
                  ? 'Letzter aktiver Admin – nicht deaktivierbar'
                  : u.aktiv
                    ? 'Deaktivieren'
                    : 'Aktivieren'
              "
              @click="u.aktiv ? deaktivieren(u.id) : aktivieren(u.id)"
            >
              {{ u.aktiv ? 'Deaktivieren' : 'Aktivieren' }}
            </button>
            <button type="button" title="Rollen ändern" @click="rollenEditorOeffnen(u.id)">
              Rollen
            </button>
            <button type="button" @click="anzeigenameAendern(u.id, u.anzeigename ?? '')">
              Name ändern
            </button>
            <button type="button" @click="passwortZuruecksetzen(u.id)">PW-Reset</button>
            <button
              type="button"
              class="danger"
              :disabled="
                u.id === auth.userId ||
                (rollenVon(u).includes('admin') && u.aktiv && aktiveAdminAnzahl <= 1)
              "
              :title="
                u.id === auth.userId
                  ? 'Eigenen Benutzer nicht löschbar'
                  : rollenVon(u).includes('admin') && u.aktiv && aktiveAdminAnzahl <= 1
                    ? 'Letzter aktiver Admin – nicht löschbar'
                    : 'Endgültig löschen'
              "
              @click="loeschen(u.id, u.email)"
            >
              Löschen
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">Noch keine Benutzer angelegt oder Backend nicht erreichbar.</p>

    <!-- Rollen-Editor -->
    <div
      v-if="rollenUserId"
      class="reset-dialog"
      role="dialog"
      aria-modal="true"
      @click.self="rollenUserId = null"
    >
      <div class="reset-dialog-card">
        <h2>Rollen ändern</h2>
        <p class="reset-hint">
          Rechte sind stapelbar — mehrere Rollen sind moeglich. Admin hat alle Rechte und schliesst
          die anderen Rollen aus.
        </p>
        <fieldset class="rollen-wahl">
          <legend>Rollen</legend>
          <label class="rollen-option">
            <input type="checkbox" checked disabled />
            <span>User (Basis)</span>
          </label>
          <label
            v-for="r in wahlRollen"
            :key="r"
            class="rollen-option"
            :title="rollenStore.beschreibung(r)"
          >
            <input
              type="checkbox"
              :checked="rollenAuswahl.includes(r)"
              :disabled="rollenLaufend"
              @change="rollenAuswahl = toggleRolle(rollenAuswahl, r)"
            />
            <span>{{ rollenStore.titel(r) }}</span>
          </label>
        </fieldset>
        <div class="reset-actions">
          <button type="button" class="text-btn" @click="rollenUserId = null">Abbrechen</button>
          <button type="button" class="primary" :disabled="rollenLaufend" @click="rollenSpeichern">
            {{ rollenLaufend ? 'Speichere …' : 'Speichern' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="resetAnzeige"
      class="reset-dialog"
      role="dialog"
      aria-modal="true"
      @click.self="resetAnzeige = null"
    >
      <div class="reset-dialog-card">
        <h2>Einmalpasswort für {{ resetAnzeige.email }}</h2>
        <p class="reset-hint">Einmal kopieren und dem Benutzer mitteilen.</p>
        <div class="reset-code-row">
          <span class="reset-code" :title="resetAnzeige.passwort">{{ resetAnzeige.passwort }}</span>
          <button
            type="button"
            class="copy-btn"
            :title="kopiert ? 'Kopiert' : 'Einmalpasswort kopieren'"
            :aria-label="kopiert ? 'Kopiert' : 'Einmalpasswort in die Zwischenablage kopieren'"
            @click="kopiereEinmalpasswort"
          >
            <svg
              class="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
        <div class="reset-actions">
          <button type="button" class="text-btn" @click="resetAnzeige = null">Schließen</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.rollen-legend-liste {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.rollen-legend-eintrag h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}
.rollen-legend-beschreibung {
  margin: 0 0 0.4rem;
  color: var(--text-muted);
  font-size: 0.9rem;
}
.rollen-legend-eintrag ul {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.9rem;
}
.rollen-wahl {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 1rem 1rem;
}
.rollen-wahl legend {
  padding: 0 0.35rem;
  font-size: 0.9rem;
  color: var(--text-muted);
}
.rollen-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}
.rollen-option input {
  width: auto;
}
.reset-dialog {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  z-index: 50;
}
.reset-dialog-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.5rem;
  width: min(420px, 92vw);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.reset-dialog-card h2 {
  margin: 0 0 0.5rem;
  font-size: 1.1rem;
}
.reset-hint {
  margin: 0 0 1rem;
  font-size: 0.9rem;
  color: var(--text-muted);
}
.reset-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
.reset-code-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.reset-code {
  font-family: var(--mono);
  font-size: 1.1rem;
  letter-spacing: 0.05em;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  user-select: all;
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-input);
  color: var(--text-muted);
  cursor: pointer;
}
.copy-btn:hover {
  color: var(--text-strong);
  border-color: var(--text-strong);
}
.copy-btn .icon {
  width: 1.05rem;
  height: 1.05rem;
  display: block;
}
.text-btn {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.4rem 0.9rem;
  color: var(--text-strong);
  cursor: pointer;
}
.text-btn:hover {
  background: var(--accent-bg);
}
</style>
