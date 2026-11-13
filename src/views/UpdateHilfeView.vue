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
# 1) Geheimes Token erzeugen (einmalig pro Server, nie ans Frontend senden)
openssl rand -hex 32
# Beispiel-Ausgabe: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
# -> Diesen Wert kopieren und unten bei UPDATE_WEBHOOK_TOKEN einfügen.

# 2) In die .env eintragen (im Projektordner, neben docker-compose.yml)
UPDATE_WEBHOOK_TOKEN=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
# Adresse des Update-Dienstes auf dem HOST. 127.0.0.1 ist im Container die API
# selbst - nutze host.docker.internal (oder die Host-IP des Servers).
# Dieser Wert markiert die Anforderung; ausgeführt wird sie vom Dienst aus der
# naechsten Karte (systemd-Timer oder Webhook-Empfaenger):
UPDATE_WEBHOOK_URL=http://host.docker.internal:4280/api/admin/update/webhook

# 3) Stack neu starten, damit die API die neuen Variablen liest
docker compose up -d</pre>
      <p class="hint">{{ t('view.update.hilfe.aktivierenNeustart') }}</p>
      <p class="hint">{{ t('view.update.hilfe.aktivierenHinweis') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.dienstTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.dienstText') }}</p>

      <h3 class="sub">{{ t('view.update.hilfe.dienstTimerTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.dienstTimerText') }}</p>
      <pre>
# /etc/systemd/system/castel-update.service
[Unit]
Description=Castel update runner
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/castel
ExecStart=/srv/castel/scripts/update.sh --if-requested

# /etc/systemd/system/castel-update.timer
[Unit]
Description=Run a pending Castel update once a minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target

# Aktivieren und sofort starten:
sudo systemctl daemon-reload
sudo systemctl enable --now castel-update.timer
sudo systemctl list-timers castel-update.timer</pre>
      <p class="hint">{{ t('view.update.hilfe.dienstTimerHinweis') }}</p>

      <h3 class="sub">{{ t('view.update.hilfe.dienstWebhookTitel') }}</h3>
      <p class="hint">{{ t('view.update.hilfe.dienstWebhookText') }}</p>
      <pre>
# adnanh/webhook installieren (Beispiel: Linux amd64, aktuelles Release)
sudo curl -fsSL -o /usr/local/bin/webhook \
  https://github.com/adnanh/webhook/releases/latest/download/webhook-linux-amd64
sudo chmod +x /usr/local/bin/webhook

# /etc/castel/hooks.yaml
# DEIN_UPDATE_WEBHOOK_TOKEN durch den Wert aus der .env ersetzen.
- id: castel-update
  execute-command: /srv/castel/scripts/update-hook.sh
  command-working-directory: /srv/castel
  http-methods:
    - POST
  trigger-rule:
    match:
      type: value
      value: "DEIN_UPDATE_WEBHOOK_TOKEN"
      parameter:
        source: header
        name: X-Deploy-Token
  response-message: '{"started":true}'
  success-http-response-code: 200

# /etc/systemd/system/castel-update-webhook.service
[Unit]
Description=Castel update webhook receiver
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/webhook -hooks /etc/castel/hooks.yaml -port 9000 -verbose
Restart=always

[Install]
WantedBy=multi-user.target

# Aktivieren und sofort starten:
sudo systemctl daemon-reload
sudo systemctl enable --now castel-update-webhook
sudo systemctl status castel-update-webhook --no-pager</pre>
      <p class="hint">{{ t('view.update.hilfe.dienstWebhookHinweis') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.webhookTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.webhookText') }}</p>
      <pre>
# Aufruf vom Host aus (derselbe Host, auf dem der Stack läuft)
# Der PWA-Container proxied /api/* an die API (Port 4280 ist freigegeben):
curl -fsS -X POST http://127.0.0.1:4280/api/admin/update/webhook \
  -H "X-Deploy-Token: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" \
  -H "Content-Type: application/json" \
  -d '{}'

# Oder direkt an die API im internen Netzwerk (vom Host / aus dem Container):
curl -fsS -X POST http://127.0.0.1:3000/api/admin/update/webhook \
  -H "X-Deploy-Token: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2" \
  -H "Content-Type: application/json" \
  -d '{}'

# Ersetzen Sie den Token-Wert durch den aus Ihrer .env (UPDATE_WEBHOOK_TOKEN).
# Kein Login / JWT nötig — der Endpunkt wird nur durch X-Deploy-Token geschützt.

# Antwort bei Erfolg:
# {"requested":true,"executed":false,"reason":"EXTERNAL_RUNNER_REQUIRED",...}
# Der Endpunkt markiert nur die Anforderung in der DB; die Ausführung
# übernimmt der externe Update-Dienst auf dem Host.
# Token fehlt / falsch: HTTP 401 UNAUTHORIZED
# Update läuft bereits: HTTP 409 UPDATE_RUNNING</pre>
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
      <p class="hint">
        Secrets im Repository anlegen:
        `CASTEL_UPDATE_URL=http://127.0.0.1:4280/api/admin/update/webhook` und
        `CASTEL_UPDATE_TOKEN=(Ihr Token aus .env)`.
      </p>
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
