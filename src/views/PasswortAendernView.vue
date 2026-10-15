<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { authFehlerText } from '../auth/messages'

const router = useRouter()
const auth = useAuthStore()

const altes = ref('')
const neues = ref('')
const neues2 = ref('')
const fehler = ref('')
const laufend = ref(false)

const erzwingt = computed(() => auth.mussPasswortAendern)

async function speichern(): Promise<void> {
  fehler.value = ''
  if (neues.value !== neues2.value) {
    fehler.value = 'Neue Passwörter stimmen nicht überein.'
    return
  }
  laufend.value = true
  try {
    await auth.aendereEigenesPasswortMit(altes.value, neues.value)
    void router.push('/')
  } catch (e) {
    // AuthError wird ueber authFehlerText lokalisiert; ein roher
    // Fetch-/DNS-Fehler wird auf den generischen Netzwerktext gemappt,
    // statt "Failed to fetch" o. ae. an den User durchzureichen.
    fehler.value = authFehlerText(e)
  } finally {
    laufend.value = false
  }
}
</script>

<template>
  <section class="login">
    <div class="card login-card">
      <h1>{{ erzwingt ? 'Neues Passwort setzen' : 'Passwort ändern' }}</h1>
      <p v-if="erzwingt" class="hint hint-warn">
        Dein Passwort wurde zurückgesetzt. Bitte vergib ein neues.
      </p>

      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <label v-if="!erzwingt">
          <span>Aktuelles Passwort</span>
          <input
            v-model="altes"
            type="password"
            autocomplete="current-password"
            required
            autofocus
            :disabled="laufend"
          />
        </label>
        <label>
          <span>Neues Passwort (≥ 8 Zeichen, mind. 1 Ziffer, 1 Buchstabe)</span>
          <input
            v-model="neues"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            pattern="(?=.*\d)(?=.*[A-Za-z]).{8,}"
            :title="'Mindestens 8 Zeichen, davon mindestens 1 Ziffer und 1 Buchstabe'"
            :disabled="laufend"
          />
        </label>
        <label>
          <span>Neues Passwort bestätigen</span>
          <input
            v-model="neues2"
            type="password"
            autocomplete="new-password"
            required
            :disabled="laufend"
          />
        </label>
        <p v-if="fehler" class="fehler" role="alert">{{ fehler }}</p>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="laufend">
            {{ laufend ? 'Speichere …' : 'Speichern' }}
          </button>
          <RouterLink v-if="!erzwingt" to="/einstellungen" class="btn">Abbrechen</RouterLink>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 2rem 1rem;
  background: var(--bg-app);
}
.login-card {
  width: 100%;
  max-width: 420px;
}
h1 {
  margin: 0 0 1rem;
}
</style>
