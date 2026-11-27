<script setup lang="ts">
// Help page: how the stack is updated.
//
// The app only checks for a newer version (GET /api/update/check). The update
// itself runs on the host (scripts/update.sh or plain docker compose); the API
// neither updates itself nor accepts an update trigger.

import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const router = useRouter()

function zurueck(): void {
  if (window.history.length > 1) router.back()
  else void router.push('/')
}
</script>

<template>
  <section class="view update-hilfe">
    <header class="view-head">
      <h1>{{ t('view.update.hilfe.h1') }}</h1>
      <p class="hint">{{ t('view.update.hilfe.untertitel') }}</p>
    </header>

    <div class="card">
      <h2>{{ t('view.update.hilfe.pruefenTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.pruefenText') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.skriptTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.skriptText') }}</p>
      <pre>
cd /srv/castel
./scripts/update.sh            # pruefen, nachfragen, aktualisieren
./scripts/update.sh --check    # nur Versionen vergleichen
./scripts/update.sh --yes      # ohne Rueckfrage</pre>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.manuellTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.manuellText') }}</p>
      <pre>
cd /srv/castel
git pull
docker compose pull
docker compose up -d</pre>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.fehlerTitel') }}</h2>
      <ul class="bullets">
        <li>{{ t('view.update.hilfe.fehlerGithub') }}</li>
        <li>{{ t('view.update.hilfe.fehlerUnbekannt') }}</li>
      </ul>
    </div>

    <div class="card actions">
      <button type="button" class="primary" @click="zurueck">
        {{ t('view.update.hilfe.zurueck') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.update-hilfe h2 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}
.update-hilfe pre {
  margin: 0.5rem 0;
  padding: 0.75rem;
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text);
  font-size: 0.8rem;
  line-height: 1.45;
  white-space: pre;
}
.bullets {
  margin: 0.25rem 0;
  padding-left: 1.25rem;
}
.bullets li {
  margin-bottom: 0.35rem;
}
.card.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
