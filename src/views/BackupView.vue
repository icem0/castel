<script setup lang="ts">
// Admin-View: Backup & Restore.
//
// Zeigt die Host-seitigen Befehle zum Erstellen und Einspielen eines
// Backups, plus Live-Status (Row-Counts, letzter Sync-Force-At) vom
// Server. Die eigentlichen Skripte (scripts/backup.mjs,
// scripts/restore.mjs) laufen AUF DEM HOST, nicht im Browser — diese
// View ist Anleitung + Diagnose, kein Knopf-zu-Knopf-Backup.
//
// Voraussetzungen fuer den Admin:
//   - `pg_dump` und `pg_restore` lokal installiert (Postgres-Client-Tools)
//   - Zugriff auf den Postgres-Container (DATABASE_URL) und das
//     `fotos-data`-Volume (FOTOS_DIR)
//   - Ein gueltiges Admin-JWT (wird beim Login in den Auth-Store
//     geschrieben, von den Skripten via $ADMIN_TOKEN erwartet)

import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch } from '../auth/api'

const { t } = useI18n()

interface StatusResponse {
  serverTime: string
  counts: { artikel: number; standorte: number; commission: number; buchungen: number }
}

interface ForceAtResponse {
  forceAt: string | null
}

const counts = ref<StatusResponse['counts'] | null>(null)
const serverTime = ref<string | null>(null)
const forceAt = ref<string | null>(null)
const triggerLaeuft = ref(false)
const triggerFehler = ref<string | null>(null)
const triggerErfolg = ref<string | null>(null)
const ladeFehler = ref<string | null>(null)

async function ladeStatus(): Promise<void> {
  ladeFehler.value = null
  try {
    const [status, fa] = await Promise.all([
      apiFetch<StatusResponse>('/api/sync/status'),
      apiFetch<ForceAtResponse>('/api/admin/sync/force-at'),
    ])
    counts.value = status.counts
    serverTime.value = status.serverTime
    forceAt.value = fa.forceAt
  } catch (e) {
    ladeFehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function triggerSync(): Promise<void> {
  triggerLaeuft.value = true
  triggerFehler.value = null
  triggerErfolg.value = null
  try {
    const r = await apiFetch<{ forceAt: string }>('/api/admin/sync/all', { method: 'POST' })
    triggerErfolg.value = r.forceAt
    // Anschliessend Status neu laden, damit die UI den neuen Marker sieht.
    await ladeStatus()
  } catch (e) {
    triggerFehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    triggerLaeuft.value = false
  }
}

onMounted(ladeStatus)

// ---------- Copy-Paste-Snippets ----------
//
// Diese Bloecke sind als Bash geschrieben. Auf Windows rufen Admins
// sie typischerweise aus WSL oder Git-Bash auf; native PowerShell-
// Snippets (Set-Variable / Invoke-WebRequest) wuerden den Scope
// sprengen. Wer beides braucht: Issue eroeffnen, dann erweitern wir.

const backupSnippet = String.raw`# 1) .env laden (DB_*, JWT_SECRET)
export $(grep -E '^(DB_|JWT_)' /opt/castel/.env | xargs)

# 2) Admin-JWT besorgen (Login-Response, JWT-Feld)
export ADMIN_TOKEN="<jwt eines admin-users>"

# 3) Volume-Mounts des Servers
export FOTOS_DIR=/srv/castel/fotos
export BACKUP_DIR=/srv/castel/backups
export API_BASE_URL=http://localhost:4280

# 4) Backup ziehen
cd /opt/castel
node scripts/backup.mjs
# → [backup] 1/5 Sync-Trigger an Server …
# → [backup] 2/5 warte auf Sync-Idle …
# → [backup] 3/5 pg_dump …
# → [backup] 4/5 fotos …
# → [backup] 5/5 zip -> /srv/castel/backups/castel-backup-<stamp>.zip`

const restoreSnippet = String.raw`# 0) VORHER: API stoppen, sonst ueberschreiben sich Resolver und
#    Restore gegenseitig.
#      docker compose stop api

# 1) .env laden
export $(grep -E '^DB_' /opt/castel/.env | xargs)
export FOTOS_DIR=/srv/castel/fotos

# 2) Restore einspielen
cd /opt/castel
node scripts/restore.mjs /srv/castel/backups/castel-backup-2026-10-19T…zip
# → [restore] entpacke …
# → [restore] manifest: …
# → [restore] pg_restore …
# → [restore] Fotos zurueckgespielt
# → [restore] fertig. API kann jetzt wieder gestartet werden.

# 3) API wieder starten
#      docker compose start api`

const cronSnippet = String.raw`# /etc/cron.d/castel-backup — taeglich 02:00
0 2 * * * castel /opt/castel/scripts/castel-backup-cron.sh`
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.backup.h1') }}</h1>
      <p class="hint">{{ t('view.backup.intro') }}</p>
    </header>

    <h2>{{ t('view.backup.statusH2') }}</h2>
    <div class="card">
      <div v-if="ladeFehler" class="fehler" role="alert">
        {{ t('view.backup.statusFehler', { msg: ladeFehler }) }}
      </div>
      <table v-else class="data">
        <tbody>
          <tr>
            <th>{{ t('view.backup.statusArtikel') }}</th>
            <td class="num">{{ counts?.artikel ?? '–' }}</td>
          </tr>
          <tr>
            <th>{{ t('view.backup.statusStandorte') }}</th>
            <td class="num">{{ counts?.standorte ?? '–' }}</td>
          </tr>
          <tr>
            <th>{{ t('view.backup.statusKommission') }}</th>
            <td class="num">{{ counts?.commission ?? '–' }}</td>
          </tr>
          <tr>
            <th>{{ t('view.backup.statusBuchungen') }}</th>
            <td class="num">{{ counts?.buchungen ?? '–' }}</td>
          </tr>
          <tr>
            <th>{{ t('view.backup.statusForceAt') }}</th>
            <td>{{ forceAt ?? t('view.backup.statusForceAtNie') }}</td>
          </tr>
          <tr v-if="serverTime">
            <th>{{ t('view.backup.statusServerTime') }}</th>
            <td>{{ serverTime }}</td>
          </tr>
        </tbody>
      </table>

      <div class="actions">
        <button type="button" :disabled="triggerLaeuft" @click="triggerSync">
          {{ triggerLaeuft ? '…' : t('view.backup.triggerSync') }}
        </button>
        <button type="button" class="secondary" :disabled="triggerLaeuft" @click="ladeStatus">
          {{ t('view.backup.aktualisieren') }}
        </button>
        <span v-if="triggerErfolg" class="hint hint-ok" role="status">
          {{ t('view.backup.triggerErfolg', { forceAt: triggerErfolg }) }}
        </span>
        <span v-if="triggerFehler" class="hint hint-error" role="alert">
          {{ t('view.backup.triggerFehler', { msg: triggerFehler }) }}
        </span>
      </div>
    </div>

    <h2>{{ t('view.backup.backupH2') }}</h2>
    <div class="card">
      <p>{{ t('view.backup.backupIntro') }}</p>
      <p class="warn">
        <strong>{{ t('view.backup.backupVoraussetzungTitel') }}</strong>
        {{ t('view.backup.backupVoraussetzungBody') }}
      </p>
      <pre class="code"><code>{{ backupSnippet }}</code></pre>
    </div>

    <h2>{{ t('view.backup.restoreH2') }}</h2>
    <div class="card">
      <p class="warn">
        <strong>{{ t('view.backup.restoreWarnungTitel') }}</strong>
        {{ t('view.backup.restoreWarnungBody') }}
      </p>
      <pre class="code"><code>{{ restoreSnippet }}</code></pre>
    </div>

    <h2>{{ t('view.backup.automatisierungH2') }}</h2>
    <div class="card">
      <p>{{ t('view.backup.automatisierungIntro') }}</p>
      <pre class="code"><code>{{ cronSnippet }}</code></pre>
      <p class="hint">
        {{ t('view.backup.automatisierungHint') }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
.data {
  width: 100%;
  border-collapse: collapse;
}
.data th,
.data td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--border, #eee);
}
.data th {
  font-weight: 500;
  color: var(--text-muted, #666);
  width: 14rem;
}
.data td.num {
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
  flex-wrap: wrap;
  align-items: center;
}
.code {
  background: var(--code-bg, #f5f5f7);
  padding: 0.75rem 1rem;
  border-radius: 0.4rem;
  overflow-x: auto;
  font-family: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 0.85em;
  line-height: 1.4;
}
.code code {
  white-space: pre;
}
.warn {
  background: var(--warn-bg, #fff7e6);
  border-left: 3px solid var(--warn-accent, #d4a72c);
  padding: 0.5rem 0.75rem;
  margin: 0.5rem 0 1rem;
  border-radius: 0 0.4rem 0.4rem 0;
}
.warn strong {
  display: block;
  margin-bottom: 0.2rem;
}
.fehler {
  color: var(--err-fg, #b00020);
  margin-bottom: 0.5rem;
}
</style>
