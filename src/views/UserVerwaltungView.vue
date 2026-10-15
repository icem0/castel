<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useUserStore } from '../stores/users'
import { MIN_PASSWORT_LAENGE } from '../auth/policy'
import type { UserRolle } from '../db/types'

const auth = useAuthStore()
const userStore = useUserStore()

const formularOffen = ref(false)
const email = ref('')
const passwort = ref('')
const rolle = ref<UserRolle>('user')
const fehler = ref('')
const laufend = ref(false)

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
  const neuesPasswort = prompt(`Neues Passwort eingeben (≥ ${MIN_PASSWORT_LAENGE} Zeichen):`)
  if (!neuesPasswort) return
  try {
    await auth.setzePasswortFuer(id, neuesPasswort)
    alert('Passwort gesetzt. Der Benutzer muss es beim nächsten Login ändern.')
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
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
  </section>
</template>
