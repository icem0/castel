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
# Projectordner (beside docker-compose.yml), run as root/deployer.

# 1) Token: generated once, then written into .env. This is the only thing
#    that is mandatory - the endpoint is protected by this token.
TOKEN=$(openssl rand -hex 32)
grep -qm '^UPDATE_WEBHOOK_TOKEN=' .env || printf 'UPDATE_WEBHOOK_TOKEN=\n' >>.env
sed -i "s|^UPDATE_WEBHOOK_TOKEN=.*|UPDATE_WEBHOOK_TOKEN=$TOKEN|" .env

# 2) UPDATE_WEBHOOK_URL stays empty / unset. The server derives the address
#    from PWA_PORT: http://host.docker.internal:PORT/api/admin/update/webhook
#    where PORT is the published port of the PWA (default 4280). Inside the
#    api-container localhost WOULD be the api itself - and the api cannot
#    update itself, it has no Docker socket. The host port of the PWA is the
#    way to reach the same endpoint from the host.
docker compose up -d api</pre>
      <p class="hint">{{ t('view.update.hilfe.aktivierenNeustart') }}</p>
      <p class="hint">{{ t('view.update.hilfe.aktivierenHinweis') }}</p>
    </div>

    <div class="card">
      <h2>{{ t('view.update.hilfe.setupTitel') }}</h2>
      <p class="hint">{{ t('view.update.hilfe.setupText') }}</p>
      <pre>
# Paste the whole block into a root shell in the project folder (the folder
# that holds docker-compose.yml). Idempotent: an existing token is kept.

# 1) Token into .env (generated only when the value is still empty)
TOKEN=$(grep -m1 '^UPDATE_WEBHOOK_TOKEN=' .env | cut -d= -f2-)
if [ -z "$TOKEN" ]; then
  TOKEN=$(openssl rand -hex 32)
  grep -qm '^UPDATE_WEBHOOK_TOKEN=' .env || printf 'UPDATE_WEBHOOK_TOKEN=\n' >>.env
  sed -i "s|^UPDATE_WEBHOOK_TOKEN=.*|UPDATE_WEBHOOK_TOKEN=$TOKEN|" .env
fi

# 2) The runner on the host: a systemd-Timer that runs scripts/update.sh
#    once a minute. Without a pending request the script exits immediately.
sudo tee /etc/systemd/system/castel-update.service >/dev/null &lt;&lt;EOF
[Unit]
Description=Castel update runner
[Service]
Type=oneshot
WorkingDirectory=$PWD
ExecStart=$PWD/scripts/update.sh --if-requested
EOF
sudo tee /etc/systemd/system/castel-update.timer >/dev/null &lt;&lt;EOF
[Unit]
Description=Run a pending Castel update once a minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now castel-update.timer

# 3) The api reads the token from .env (the URL stays unset, see above)
docker compose up -d api

# 4) Request an update. The token is read from .env here, too - nothing to
#    type. The Timer picks the request up within one minute.
PWA=$(grep -m1 '^PWA_PORT=' .env | cut -d= -f2-)
curl -fsS -X POST "http://127.0.0.1:${PWA:-4280}/api/admin/update/webhook" \
  -H "X-Deploy-Token: $(grep -m1 '^UPDATE_WEBHOOK_TOKEN=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json" \
  --data-raw '{}'

# Want it without waiting for the Timer?
sudo systemctl start castel-update.service</pre>
      <p class="hint">{{ t('view.update.hilfe.setupHinweis') }}</p>
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
# From the HOST: 127.0.0.1:PORT with PORT = the published port of the PWA
# (default 4280). That nginx proxies /api/* straight through to the api, so
# this curl reaches the same endpoint the server calls. The token is grepped
# from the .env - the command works without any copy&paste of the secret.
PWA=$(grep -m1 '^PWA_PORT=' .env | cut -d= -f2-)
curl -fsS -X POST "http://127.0.0.1:${PWA:-4280}/api/admin/update/webhook" \
  -H "X-Deploy-Token: $(grep -m1 '^UPDATE_WEBHOOK_TOKEN=' .env | cut -d= -f2-)" \
  -H "Content-Type: application/json" \
  --data-raw '{}'

# Same endpoint, LAN address of the server (e.g. from a second machine):
curl -fsS -X POST "http://10.0.0.5:4280/api/admin/update/webhook" \
  -H "X-Deploy-Token: $(grep -m1 '^UPDATE_WEBHOOK_TOKEN=' .env | cut -d= -f2-)" \
  --data-raw '{}'

# From INSIDE the api-container (what UPDATE_WEBHOOK_URL has to point at):
# there 127.0.0.1 is the api itself and cannot run a host update - use
# http://host.docker.internal:4280/api/admin/update/webhook instead, the
# address the server also derives when UPDATE_WEBHOOK_URL is unset.

# Answer:  {"requested":true,"executed":false,"reason":"EXTERNAL_RUNNER_REQUIRED"}
# The endpoint only sets the request in the DB; the host-side runner
# (scripts/update.sh --if-requested) does the actual work.
# 401 UNAUTHORIZED  - X-Deploy-Token missing / does not match the .env
# 409 UPDATE_RUNNING - an update is already running
# 500 UPDATE_NO_WEBHOOK_TOKEN - UPDATE_WEBHOOK_TOKEN not set in the .env</pre>
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
        <code>CASTEL_UPDATE_URL</code> (URL of the server, reachable from the CI machine - e.g.
        <code>https://castel.example.com/api/admin/update/webhook</code>, never
        <code>127.0.0.1</code> unless the runner sits on the server itself) und
        <code>CASTEL_UPDATE_TOKEN</code> (Token from the <code>.env</code>).
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
