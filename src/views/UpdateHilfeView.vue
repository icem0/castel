<script setup lang="ts">
// Help page: how the update of the stack works.
//
// The flow is deliberately simple:
//   1. one line in the .env (UPDATE_RUNNER=true)
//   2. one `docker compose up -d`
//   3. the button "Jetzt aktualisieren" in the PWA
//
// The PWA only marks the request in the DB; the execution happens in the
// update service on the host (compose service `update-runner` or a systemd
// timer). The webhook/token path is optional and only needed for external
// triggers (CI/CD, another machine).

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
      </ol>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.setupTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.setupText') }}</p>
      <pre>
# .env im Projektordner (neben docker-compose.yml)
UPDATE_RUNNER=true
UPDATE_RUNNER_INTERVAL_SEC=60

# einmal neu starten, damit die API die .env liest
docker compose up -d</pre>
      <p class="hint">{{ t('view.update.hilfe.setupHinweis') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.statusTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.statusText') }}</p>
      <pre>{{ t('view.update.hilfe.statusBefehl') }}</pre>
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
      <h2>{{ t('view.update.hilfe.dienstTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.dienstText') }}</p>

      <h3 class="sub">{{ t('view.update.hilfe.dienstTimerTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.dienstTimerText') }}</p>
      <pre>{{ t('view.update.hilfe.dienstTimerHinweis') }}</pre>

      <h3 class="sub">{{ t('view.update.hilfe.dienstWebhookTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.dienstWebhookText') }}</p>
      <pre>{{ t('view.update.hilfe.dienstWebhookHinweis') }}</pre>

      <h3 class="sub">{{ t('view.update.hilfe.assistantTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.assistantText') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.webhookTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.webhookText') }}</p>
      <pre>
# Der eingehende Endpunkt (nur für externe Auslöser, Token noetig):
#   curl -X POST https://&lt;server&gt;/api/admin/update/webhook \
#     -H "X-Deploy-Token: $(grep -m1 '^UPDATE_WEBHOOK_TOKEN=' .env | cut -d= -f2-)" \
#     -H "Content-Type: application/json" -d '{}'</pre>
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
# sicheres Token erzeugen (nur für externe Auslöser nötig)
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
  margin: 0.25rem 0;
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
