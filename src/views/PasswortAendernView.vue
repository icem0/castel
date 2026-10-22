<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import { authFehlerText } from '../auth/messages'

const router = useRouter()
const auth = useAuthStore()
const { t } = useI18n()

const altes = ref('')
const neues = ref('')
const neues2 = ref('')
const fehler = ref('')
const laufend = ref(false)

const erzwingt = computed(() => auth.mussPasswortAendern)

async function speichern(): Promise<void> {
  fehler.value = ''
  if (neues.value !== neues2.value) {
    fehler.value = t('view.passwortAendern.fehlerPwStimmtNicht')
    return
  }
  laufend.value = true
  try {
    await auth.aendereEigenesPasswortMit(erzwingt.value ? '' : altes.value, neues.value)
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
      <h1>
        {{ erzwingt ? t('view.passwortAendern.h1Erzwungen') : t('view.passwortAendern.h1Frei') }}
      </h1>
      <p v-if="erzwingt" class="hint hint-warn">
        {{ t('view.passwortAendern.hintErzwungen') }}
      </p>

      <form class="form" :aria-busy="laufend || undefined" @submit.prevent="speichern">
        <label v-if="!erzwingt">
          <span>{{ t('view.passwortAendern.aktuellesPw') }}</span>
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
          <span>{{ t('view.passwortAendern.neuesPw') }}</span>
          <input
            v-model="neues"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            pattern="(?=.*\d)(?=.*[A-Za-z]).{8,}"
            :title="t('view.passwortAendern.neuesPwPatternTitel')"
            :autofocus="erzwingt ? true : undefined"
            :disabled="laufend"
          />
        </label>
        <label>
          <span>{{ t('view.passwortAendern.neuesPwBestaetigen') }}</span>
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
            {{ laufend ? t('view.passwortAendern.speichernLaufend') : t('view.common.speichern') }}
          </button>
          <RouterLink v-if="!erzwingt" to="/einstellungen" class="btn">
            {{ t('view.common.abbrechen') }}
          </RouterLink>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.login {
  min-height: var(--app-vh, 100vh);
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
