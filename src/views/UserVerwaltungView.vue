<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useUserStore } from '../stores/users'
import { MIN_PASSWORT_LAENGE, generiereEinmalpasswort } from '../auth/policy'
import type { UserRolle } from '../db/types'

const auth = useAuthStore()
const userStore = useUserStore()

const formularOffen = ref(false)
const email = ref('')
const passwort = ref('')
const rolle = ref<UserRolle>('user')
const fehler = ref('')
const laufend = ref(false)

type ResetAnzeige = { id: string; email: string; passwort: string }
const resetAnzeige = ref<ResetAnzeige | null>(null)
const kopiert = ref(false)
let kopiertTimer: ReturnType<typeof setTimeout> | null = null

const aktiveAdminAnzahl = computed(
  () => userStore.users.filter((u) => u.rolle === 'admin' && u.aktiv).length,
)

onMounted(async () => {
  await userStore.laden()
})

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
      rolle: rolle.value,
    })
    formularOffen.value = false
    email.value = ''
    passwort.value = ''
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

async function rolleAendern(id: string, neueRolle: UserRolle): Promise<void> {
  try {
    await auth.aendereRolle(id, neueRolle)
    await userStore.laden()
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
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
      <button type="button" class="primary" @click="formularOffen = !formularOffen">
        {{ formularOffen ? 'Abbrechen' : 'Neuer Benutzer' }}
      </button>
    </header>

    <p class="hint">
      <RouterLink to="/einstellungen">← zurück zu Einstellungen</RouterLink>
    </p>

    <div v-if="formularOffen" class="card">
      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="anlegen">
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
        <label>
          <span>Rolle</span>
          <select v-model="rolle" :disabled="laufend">
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
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
          <th>E-Mail</th>
          <th>Rolle</th>
          <th>Aktiv</th>
          <th>Erstellt</th>
          <th>Letzter Login</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="u in userStore.users" :key="u.id">
          <td>{{ u.email }}</td>
          <td>
            <span class="badge" :class="{ accent: u.rolle === 'admin' }">
              {{ u.rolle }}
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
              :disabled="u.rolle === 'admin' && u.aktiv && aktiveAdminAnzahl <= 1"
              :title="
                u.rolle === 'admin' && u.aktiv && aktiveAdminAnzahl <= 1
                  ? 'Letzter aktiver Admin – nicht deaktivierbar'
                  : u.aktiv
                    ? 'Deaktivieren'
                    : 'Aktivieren'
              "
              @click="u.aktiv ? deaktivieren(u.id) : aktivieren(u.id)"
            >
              {{ u.aktiv ? 'Deaktivieren' : 'Aktivieren' }}
            </button>
            <button
              type="button"
              :disabled="u.rolle === 'admin' && aktiveAdminAnzahl <= 1"
              :title="
                u.rolle === 'admin' && aktiveAdminAnzahl <= 1
                  ? 'Letzter aktiver Admin – nicht zum User degradierbar'
                  : u.rolle === 'admin'
                    ? 'Zu User degradieren'
                    : 'Zu Admin befördern'
              "
              @click="rolleAendern(u.id, u.rolle === 'admin' ? 'user' : 'admin')"
            >
              {{ u.rolle === 'admin' ? 'Zu User' : 'Zu Admin' }}
            </button>
            <button type="button" @click="passwortZuruecksetzen(u.id)">PW-Reset</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">Noch keine Benutzer angelegt oder Backend nicht erreichbar.</p>

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
  background: var(--bg);
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
.reset-code-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}
.reset-code {
  font-family: var(--mono);
  font-size: 1.1rem;
  letter-spacing: 0.05em;
  background: #f3f4f6;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  flex: 1;
  overflow: hidden;
  white-space: pre;
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
  background: var(--bg);
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
.reset-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
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
  background: #f3f4f6;
}
</style>
