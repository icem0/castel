<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../stores/auth'
import {
  erstelleApiKey,
  listeAlleApiKeys,
  listeEigeneApiKeys,
  widerrufeApiKey,
  widerrufeApiKeyAlsAdmin,
  type AdminApiKeyInfo,
  type ApiKeyInfo,
  type ApiKeyScope,
  type CreatedApiKey,
} from '../auth/apiKeys'

const { t } = useI18n()
const auth = useAuthStore()

const modus = ref<'eigene' | 'alle'>('eigene')
const eigeneKeys = ref<ApiKeyInfo[]>([])
const alleKeys = ref<AdminApiKeyInfo[]>([])
const laden = ref(false)
const fehler = ref('')
const name = ref('')
const scopes = ref<ApiKeyScope[]>(['read'])
const ablauf = ref('')
const erstellen = ref(false)
const neuerKey = ref<CreatedApiKey | null>(null)
const kopiert = ref(false)

const sichtbareEigene = computed(() => eigeneKeys.value.filter((k) => k.revokedAt === null))

function scopesLabel(liste: string[]): string {
  return liste.map((s) => t(`view.apiKeys.scopes.${s}`)).join(', ')
}

function datum(iso: string | null): string {
  if (!iso) return t('view.apiKeys.nie')
  return new Date(iso).toLocaleString()
}

async function ladenAktuell(): Promise<void> {
  laden.value = true
  fehler.value = ''
  try {
    if (modus.value === 'alle' && auth.istAdmin) {
      alleKeys.value = await listeAlleApiKeys()
    } else {
      eigeneKeys.value = await listeEigeneApiKeys()
    }
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  } finally {
    laden.value = false
  }
}

async function wechsleModus(neu: 'eigene' | 'alle'): Promise<void> {
  modus.value = neu
  await ladenAktuell()
}

async function anlegen(): Promise<void> {
  if (!name.value.trim() || scopes.value.length === 0) return
  erstellen.value = true
  fehler.value = ''
  try {
    neuerKey.value = await erstelleApiKey({
      name: name.value.trim(),
      scopes: scopes.value,
      ablaufAm: ablauf.value ? new Date(ablauf.value).toISOString() : null,
    })
    name.value = ''
    scopes.value = ['read']
    ablauf.value = ''
    kopiert.value = false
    modus.value = 'eigene'
    eigeneKeys.value = await listeEigeneApiKeys()
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  } finally {
    erstellen.value = false
  }
}

async function widerrufen(id: string): Promise<void> {
  if (!window.confirm(t('view.apiKeys.widerrufenBestaetigen'))) return
  fehler.value = ''
  try {
    if (modus.value === 'alle' && auth.istAdmin) {
      await widerrufeApiKeyAlsAdmin(id)
    } else {
      await widerrufeApiKey(id)
    }
    await ladenAktuell()
  } catch (err) {
    fehler.value = err instanceof Error ? err.message : String(err)
  }
}

async function keyKopieren(): Promise<void> {
  if (!neuerKey.value) return
  try {
    await navigator.clipboard.writeText(neuerKey.value.key)
    kopiert.value = true
    setTimeout(() => {
      kopiert.value = false
    }, 1500)
  } catch {
    kopiert.value = false
  }
}

onMounted(() => {
  void ladenAktuell()
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.apiKeys.h1') }}</h1>
    </header>

    <p class="hint">{{ t('view.apiKeys.hint') }}</p>
    <div class="card endpoints">
      <div><strong>REST:</strong> <code>/api/v1</code></div>
      <div><strong>MCP:</strong> <code>/api/mcp</code></div>
      <div>
        <strong>{{ t('view.apiKeys.docs') }}:</strong>
        <a href="/api/docs" target="_blank" rel="noopener">/api/docs</a>
      </div>
    </div>

    <div v-if="fehler" class="card fehler">{{ fehler }}</div>

    <div v-if="neuerKey" class="card key-neu">
      <h2>{{ t('view.apiKeys.keyErstellt') }}</h2>
      <p class="hint">{{ t('view.apiKeys.keyEinmalig') }}</p>
      <div class="key-zeile">
        <code>{{ neuerKey.key }}</code>
        <button type="button" class="primary" @click="keyKopieren">
          {{ kopiert ? t('view.apiKeys.kopiert') : t('view.apiKeys.kopieren') }}
        </button>
      </div>
      <button type="button" @click="neuerKey = null">{{ t('view.apiKeys.schliessen') }}</button>
    </div>

    <h2>{{ t('view.apiKeys.neuerKey') }}</h2>
    <form class="card form" @submit.prevent="anlegen">
      <label>
        <span>{{ t('view.apiKeys.name') }}</span>
        <input
          v-model="name"
          type="text"
          maxlength="100"
          :placeholder="t('view.apiKeys.namePlatzhalter')"
          autocomplete="off"
        />
      </label>
      <fieldset class="scopes">
        <legend>{{ t('view.apiKeys.scopesLabel') }}</legend>
        <label>
          <input v-model="scopes" type="checkbox" value="read" />
          <span>{{ t('view.apiKeys.scopes.read') }}</span>
        </label>
        <label>
          <input v-model="scopes" type="checkbox" value="write" />
          <span>{{ t('view.apiKeys.scopes.write') }}</span>
        </label>
        <label v-if="auth.istAdmin">
          <input v-model="scopes" type="checkbox" value="admin" />
          <span>{{ t('view.apiKeys.scopes.admin') }}</span>
        </label>
      </fieldset>
      <label>
        <span>{{ t('view.apiKeys.ablauf') }}</span>
        <input v-model="ablauf" type="datetime-local" />
        <small class="hint">{{ t('view.apiKeys.ablaufHint') }}</small>
      </label>
      <button
        type="submit"
        class="primary"
        :disabled="erstellen || !name.trim() || scopes.length === 0"
      >
        {{ erstellen ? t('view.apiKeys.erstelltLaeuft') : t('view.apiKeys.erstellen') }}
      </button>
    </form>

    <div class="liste-head">
      <h2>{{ modus === 'alle' ? t('view.apiKeys.alleKeys') : t('view.apiKeys.eigeneKeys') }}</h2>
      <div v-if="auth.istAdmin" class="modus">
        <button
          type="button"
          :class="{ active: modus === 'eigene' }"
          @click="wechsleModus('eigene')"
        >
          {{ t('view.apiKeys.eigeneKeys') }}
        </button>
        <button type="button" :class="{ active: modus === 'alle' }" @click="wechsleModus('alle')">
          {{ t('view.apiKeys.alleKeys') }}
        </button>
      </div>
    </div>

    <p v-if="laden" class="hint">{{ t('view.apiKeys.laedt') }}</p>

    <template v-if="!laden">
      <p v-if="modus === 'eigene' && sichtbareEigene.length === 0" class="hint">
        {{ t('view.apiKeys.leer') }}
      </p>
      <p v-if="modus === 'alle' && alleKeys.length === 0" class="hint">
        {{ t('view.apiKeys.leer') }}
      </p>

      <ul v-if="modus === 'eigene'" class="key-liste">
        <li v-for="k in sichtbareEigene" :key="k.id" class="card key-karte">
          <div class="key-main">
            <strong>{{ k.name }}</strong>
            <code>{{ k.prefix }}…</code>
          </div>
          <div class="key-meta">
            <span>{{ scopesLabel(k.scopes) }}</span>
            <span>{{ t('view.apiKeys.erstellt') }}: {{ datum(k.erstelltAm) }}</span>
            <span>{{ t('view.apiKeys.letzteNutzung') }}: {{ datum(k.letzteNutzungAm) }}</span>
            <span>{{ t('view.apiKeys.ablauf') }}: {{ datum(k.ablaufAm) }}</span>
          </div>
          <button type="button" class="danger" @click="widerrufen(k.id)">
            {{ t('view.apiKeys.widerrufen') }}
          </button>
        </li>
      </ul>

      <ul v-if="modus === 'alle'" class="key-liste">
        <li v-for="k in alleKeys" :key="k.id" class="card key-karte">
          <div class="key-main">
            <strong>{{ k.name }}</strong>
            <code>{{ k.prefix }}…</code>
            <span class="hint">{{ k.userAnzeigename }} ({{ k.userEmail }})</span>
          </div>
          <div class="key-meta">
            <span>{{ scopesLabel(k.scopes) }}</span>
            <span>{{ t('view.apiKeys.erstellt') }}: {{ datum(k.erstelltAm) }}</span>
            <span>{{ t('view.apiKeys.letzteNutzung') }}: {{ datum(k.letzteNutzungAm) }}</span>
            <span v-if="k.revokedAt"
              >{{ t('view.apiKeys.widerrufenAm') }}: {{ datum(k.revokedAt) }}</span
            >
          </div>
          <button v-if="!k.revokedAt" type="button" class="danger" @click="widerrufen(k.id)">
            {{ t('view.apiKeys.widerrufen') }}
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.endpoints {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1rem;
}
.endpoints code {
  background: var(--surface-2, rgba(127, 127, 127, 0.15));
  border-radius: 4px;
  padding: 0.1rem 0.3rem;
}
.key-neu {
  border: 1px solid var(--accent, #3b82f6);
  margin-bottom: 1rem;
}
.key-zeile {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin: 0.75rem 0;
}
.key-zeile code {
  flex: 1 1 18rem;
  word-break: break-all;
  background: var(--surface-2, rgba(127, 127, 127, 0.15));
  border-radius: 4px;
  padding: 0.4rem 0.5rem;
}
.scopes {
  border: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.scopes label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}
.liste-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.modus {
  display: flex;
  gap: 0.25rem;
}
.modus button.active {
  font-weight: 700;
  text-decoration: underline;
}
.key-liste {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.key-karte {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.key-main {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.key-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  font-size: 0.85rem;
  opacity: 0.8;
}
.key-karte .danger {
  align-self: flex-start;
}
.fehler {
  color: var(--danger, #dc2626);
  margin-bottom: 1rem;
}
</style>
