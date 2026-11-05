<script setup lang="ts">
// Help page: how to activate the server-side update function.
//
// The page is reachable from the version panel (admin only) and explains the
// two ways to run an update on the host:
//   1. The built-in updater container (scripts/update.sh) triggered through
//      the inbound webhook / API.
//   2. An external webhook receiver that calls the same script.
//
// Keep the commands in sync with scripts/update.sh and the env vars in
// server/src/config/config.ts (UPDATE_WEBHOOK_URL, UPDATE_WEBHOOK_TOKEN).

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
      <h2>{{ t('view.update.hilfe.ablaufTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.ablaufText') }}</p>
      <ol class="steps">
        <li>{{ t('view.update.hilfe.ablaufS1') }}</li>
        <li>{{ t('view.update.hilfe.ablaufS2') }}</li>
        <li>{{ t('view.update.hilfe.ablaufS3') }}</li>
        <li>{{ t('view.update.hilfe.ablaufS4') }}</li>
        <li>{{ t('view.update.hilfe.ablaufS5') }}</li>
      </ol>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.voraussetzungenTitel') }}</h2>
      <ul class="bullets">
        <li>{{ t('view.update.hilfe.voraussetzungSocket') }}</li>
        <li>{{ t('view.update.hilfe.voraussetzungCheckout') }}</li>
        <li>{{ t('view.update.hilfe.voraussetzungToken') }}</li>
      </ul>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.aktivierenTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.aktivierenText') }}</p>
      <pre>
# .env im Projektordner
UPDATE_WEBHOOK_TOKEN=IhrLangesZufaelligesToken
UPDATE_WEBHOOK_URL=http://127.0.0.1:3000/api/admin/update/webhook</pre>
      <p class="hint">{{ t('view.update.hilfe.aktivierenNeustart') }}</p>
      <pre>docker compose up -d</pre>
      <p class="hint">{{ t('view.update.hilfe.aktivierenHinweis') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.webhookTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.webhookText') }}</p>
      <pre>
curl -X POST https://Ihr-Server/api/admin/update/webhook \
  -H "X-Deploy-Token: IhrLangesZufaelligesToken" \
  -H "Content-Type: application/json" \
  -d '{}'</pre>
      <h3 class="sub">{{ t('view.update.hilfe.webhookCicdTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.webhookCicdText') }}</p>
      <pre v-pre>
# GitHub Actions: .github/workflows/deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: castel update
        run: |
          curl -fsS -X POST "${{ secrets.CASTEL_UPDATE_URL }}" \
            -H "X-Deploy-Token: ${{ secrets.CASTEL_UPDATE_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{}'</pre>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.tokenTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.tokenText') }}</p>
      <pre>
# sicheres Token erzeugen
openssl rand -hex 32</pre>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.selbstupdateTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.selbstupdateText') }}</p>
      <pre>cd /srv/castel && ./scripts/update.sh --if-requested</pre>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.fehlerTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.fehlerText') }}</p>
      <ul class="bullets">
        <li>{{ t('view.update.hilfe.fehlerSocket') }}</li>
        <li>{{ t('view.update.hilfe.fehlerProjekt') }}</li>
        <li>{{ t('view.update.hilfe.fehlerToken') }}</li>
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
.update-hilfe h3.sub {
  margin: 1rem 0 0.4rem;
  font-size: 0.95rem;
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
.steps,
.bullets {
  margin: 0.25rem 0 0;
  padding-left: 1.25rem;
}
.steps li,
.bullets li {
  margin-bottom: 0.35rem;
}
.card.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
