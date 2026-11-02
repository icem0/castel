<script setup lang="ts">
// Admin-View: Backup & Restore.
//
// Funktionen:
//   - "Jetzt im Backup-Ordner ablegen" -> löst ein asynchrones Backup aus
//     (laufend im Hintergrund, Status per Polling abrufbar). Fertiges ZIP
//     landet im BACKUP_DIR-Volume und erscheint in der Liste unten.
//   - Schedule-Formular            -> HH:MM (Cronjob) + Anzahl Kopien.
//   - Liste vorhandener Backups    -> herunterladen, einspielen, loeschen.
//   - "Backup aus Datei einspielen" -> ein zuvor HERUNTERGELADENES ZIP
//     hochladen und einspielen. Das ist der Notfall-Weg: der Server wurde
//     neu aufgesetzt, das Backup-Volume ist leer, das ZIP liegt nur noch
//     auf dem Rechner des Admins.
//
// Restore laeuft asynchron: der Server ersetzt die komplette Datenbank
// (pg_restore) und kopiert Fotos + DATANORM-Kataloge — das dauert Minuten.
// Ein offener HTTP-Request wuerde im nginx nach 60 s gekillt, waehrend der
// Server weiter restauriert. Deshalb antworten die Restore-Endpoints
// sofort mit einer Job-ID; der Fortschritt kommt aus
// GET /api/admin/backup/status/:jobId.
//
// Server-Endpoints (alle admin-only):
//   GET    /api/admin/backup/settings
//   PUT    /api/admin/backup/settings
//   GET    /api/admin/backup/list
//   POST   /api/admin/backup/run        -> { jobId, status }
//   GET    /api/admin/backup/status/:jobId -> { status, kind?, filename?, error?, result? }
//   DELETE /api/admin/backup/:name
//   POST   /api/admin/backup/restore        -> { jobId, status }
//   POST   /api/admin/backup/restore/upload -> { jobId, status, name }
//   GET    /api/admin/backup/file/:name -> Stream

import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'
import { resetLocalDbAndPull } from '../services/sync/reset-local-db'

const { t } = useI18n()

interface BackupSettings {
  schedule: string
  keepCopies: number
}

interface BackupDatei {
  name: string
  size: number
  createdAt: string
  /** Groesse des DB-Dumps im ZIP (null = nicht ermittelbar). */
  dumpBytes: number | null
  /** true = ZIP enthaelt einen nicht-leeren DB-Dump und ist einspielbar. */
  dumpOk: boolean | null
}

interface BackupListResponse {
  files: BackupDatei[]
  dir: string
}

interface RestoreErgebnis {
  dumpBytes: number
  fotoDateien: number
  datanormDateien: number
  /** true = das eigene Admin-Konto musste wiederhergestellt werden. */
  userWiederhergestellt: boolean
  restoreEpoch: string | null
}

interface BackupJobStatus {
  status: 'running' | 'done' | 'failed'
  kind?: 'backup' | 'restore'
  filename?: string | null
  error?: string | null
  result?: RestoreErgebnis | null
}

const settings = ref<BackupSettings>({ schedule: '', keepCopies: 7 })
const files = ref<BackupDatei[]>([])
const backupDir = ref<string>('')

const laedt = ref(false)
const speichert = ref(false)
const fehler = ref<string | null>(null)
const erfolg = ref<string | null>(null)

// Aktueller Backup-Job (asynchroner Run)
const backupJob = ref<{
  id: string | null
  status: 'idle' | 'running' | 'done' | 'failed'
  error: string | null
}>({
  id: null,
  status: 'idle',
  error: null,
})

// Aktueller Restore-Job (asynchrones Einspielen)
const restoreJob = ref<{
  id: string | null
  status: 'idle' | 'running' | 'done' | 'failed'
  error: string | null
  name: string | null
  result: RestoreErgebnis | null
}>({
  id: null,
  status: 'idle',
  error: null,
  name: null,
  result: null,
})

// Hochgeladenes Backup (Notfall-Weg)
const uploadDatei = ref<File | null>(null)
const uploadLaeuft = ref(false)

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function humanDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function authHeader(): Record<string, string> {
  const token = jwtLesen()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function fetchStream(url: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: { ...init.headers, ...authHeader() },
    credentials: 'include',
  })
}

async function ladeAlles(): Promise<void> {
  laedt.value = true
  fehler.value = null
  try {
    const [s, list] = await Promise.all([
      apiFetch<BackupSettings>('/api/admin/backup/settings'),
      apiFetch<BackupListResponse>('/api/admin/backup/list'),
    ])
    settings.value = s
    files.value = list.files
    backupDir.value = list.dir
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laedt.value = false
  }
}

async function speichereSettings(): Promise<void> {
  speichert.value = true
  fehler.value = null
  erfolg.value = null
  try {
    const s = await apiFetch<BackupSettings>('/api/admin/backup/settings', {
      method: 'PUT',
      body: settings.value,
    })
    settings.value = s
    erfolg.value = t('view.backup.settingsGespeichert')
    setTimeout(() => (erfolg.value = null), 2000)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    speichert.value = false
  }
}

async function backupErstellen(): Promise<void> {
  fehler.value = null
  erfolg.value = null
  backupJob.value = { id: null, status: 'running', error: null }
  try {
    const r = await apiFetch<{ jobId: string; status: string }>('/api/admin/backup/run', {
      method: 'POST',
    })
    backupJob.value = { id: r.jobId, status: 'running', error: null }
    await pollBackupJob(r.jobId)
  } catch (e) {
    backupJob.value = {
      id: null,
      status: 'failed',
      error: e instanceof Error ? e.message : String(e),
    }
    fehler.value = backupJob.value.error
  }
}

async function pollBackupJob(jobId: string): Promise<void> {
  // Maximal 120s warten (60 * 2s), dann Timeout.
  // Temporaere Fehler (502, Netzwerk) werden toleriert: Der Server
  // kann waehrend des Backups neu starten (z. B. beim Deploy). Erst
  // nach 5 aufeinanderfolgenden Fehlern geben wir auf.
  let fehlerZaehler = 0
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 2000))
    try {
      const status = await apiFetch<BackupJobStatus>(
        `/api/admin/backup/status/${encodeURIComponent(jobId)}`,
      )
      fehlerZaehler = 0
      if (status.status === 'done') {
        backupJob.value = { id: jobId, status: 'done', error: null }
        erfolg.value = t('view.backup.runErfolg', {
          filename: String(status.filename ?? 'unbekannt'),
          geloescht: 0,
        })
        setTimeout(() => (erfolg.value = null), 4000)
        await ladeAlles()
        return
      }
      if (status.status === 'failed') {
        backupJob.value = { id: jobId, status: 'failed', error: status.error ?? null }
        fehler.value = status.error || t('view.backup.runFehlgeschlagen')
        return
      }
      // status === 'running': weiter pollen
    } catch (e) {
      fehlerZaehler++
      if (fehlerZaehler < 5) {
        // Noch nicht aufgeben — Server koennte kurz down sein.
        continue
      }
      const msg = e instanceof Error ? e.message : String(e)
      fehler.value = msg
      backupJob.value = { id: jobId, status: 'failed', error: msg }
      return
    }
  }
  backupJob.value = { id: jobId, status: 'failed', error: 'Timeout' }
  fehler.value = t('view.backup.runTimeout')
}

async function dateiLoeschen(name: string): Promise<void> {
  if (!confirm(t('view.backup.loeschenFrage', { name }))) return
  fehler.value = null
  try {
    await apiFetch(`/api/admin/backup/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await ladeAlles()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

async function dateiHerunterladen(name: string): Promise<void> {
  fehler.value = null
  try {
    const url = `${getApiBaseUrl()}/api/admin/backup/file/${encodeURIComponent(name)}`
    const res = await fetchStream(url)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
    }
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name
    a.click()
    URL.revokeObjectURL(objectUrl)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

/**
 * Pollt einen Restore-Job. Der Restore dauert Minuten (pg_restore plus
 * Foto- und DATANORM-Kopieren) — das Zeitlimit ist deshalb deutlich
 * groesser als beim Backup (30 Minuten). Der Status-Endpoint liest nur
 * den In-Memory-Job und fasst die DB nicht an — waehrend des Restores
 * waeren DB-Abfragen durch die pg_restore-Locks blockiert.
 */
async function pollRestoreJob(jobId: string): Promise<BackupJobStatus | null> {
  let fehlerZaehler = 0
  for (let i = 0; i < 900; i++) {
    await new Promise((res) => setTimeout(res, 2000))
    try {
      const status = await apiFetch<BackupJobStatus>(
        `/api/admin/backup/status/${encodeURIComponent(jobId)}`,
      )
      fehlerZaehler = 0
      if (status.status === 'done' || status.status === 'failed') return status
    } catch (e) {
      fehlerZaehler++
      // Der Server kann waehrend des Restores kurz nicht antworten
      // (Restart beim Deploy) — erst nach mehreren Fehlversuchen aufgeben.
      if (fehlerZaehler >= 10) {
        const msg = e instanceof Error ? e.message : String(e)
        restoreJob.value = {
          id: jobId,
          status: 'failed',
          error: msg,
          name: restoreJob.value.name,
          result: null,
        }
        fehler.value = msg
        return null
      }
    }
  }
  restoreJob.value = {
    id: jobId,
    status: 'failed',
    error: t('view.backup.restoreTimeout'),
    name: restoreJob.value.name,
    result: null,
  }
  fehler.value = t('view.backup.restoreTimeout')
  return null
}

/**
 * Fuehrt den Restore-Job aus: warten, Ergebnis anzeigen und danach den
 * lokalen Stand zuruecksetzen (die Server-DB wurde komplett ersetzt).
 */
async function fuehreRestoreJob(jobId: string, name: string): Promise<void> {
  restoreJob.value = { id: jobId, status: 'running', error: null, name, result: null }
  const status = await pollRestoreJob(jobId)
  if (!status) return
  if (status.status === 'failed') {
    restoreJob.value = {
      id: jobId,
      status: 'failed',
      error: status.error ?? null,
      name,
      result: null,
    }
    fehler.value = status.error || t('view.backup.restoreFehlgeschlagen')
    return
  }
  restoreJob.value = {
    id: jobId,
    status: 'done',
    error: null,
    name,
    result: status.result ?? null,
  }
  erfolg.value = t('view.backup.restoreErfolg', { name })
  await lokalenStandZuruecksetzen()
}

/**
 * Baut den lokalen Stand neu auf. Die Server-DB wurde komplett ersetzt —
 * auch dieser Client haelt eine IndexedDB der Vor-Restore-Welt
 * (Geisterzeilen, veraltete LWW-Staende, Outbox mit Alt-Data). Lokal
 * sofort wischen und vollstaendig neu ziehen; alle anderen Geraete
 * bemerken die neue Restore-Epoche beim naechsten Sync und resetten sich
 * automatisch (worker.ts).
 */
async function lokalenStandZuruecksetzen(): Promise<void> {
  try {
    await resetLocalDbAndPull({
      apiBase: getApiBaseUrl(),
      token: localStorage.getItem('castel.auth.jwt'),
    })
    // Der Reset suspendiert den Sync-Worker bis zum Neuladen — danach
    // arbeiten UI und Worker wieder auf der frischen DB.
    setTimeout(() => window.location.reload(), 800)
  } catch (e) {
    // Lokaler Wiederaufbau fehlgeschlagen — unschaedlich: der Sync-Worker
    // sieht die veraenderte Restore-Epoche und wiederholt den Reset.
    console.warn('[backup] Lokaler Reset nach Restore fehlgeschlagen:', e)
  }
}

async function dateiRestaurieren(name: string): Promise<void> {
  if (
    !confirm(
      t('view.backup.restoreFrage', {
        name,
        default: `${name} einspielen? Dies überschreibt alle aktuellen Daten unwiderruflich.`,
      }),
    )
  )
    return
  if (!confirm(t('view.backup.restoreFrage2'))) return
  fehler.value = null
  try {
    const r = await apiFetch<{ jobId: string; name: string }>('/api/admin/backup/restore', {
      method: 'POST',
      body: { name, confirm: 'yes' },
    })
    await fuehreRestoreJob(r.jobId, r.name ?? name)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  }
}

function onUploadDateiChange(e: Event): void {
  uploadDatei.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

/**
 * Notfall-Weg: ein zuvor heruntergeladenes Backup-ZIP hochladen und
 * einspielen. Der Server legt die Datei im Backup-Ordner ab und spielt
 * sie anschliessend ein (asynchron, Status per Polling).
 */
async function dateiHochladen(): Promise<void> {
  const file = uploadDatei.value
  if (!file) {
    fehler.value = t('view.backup.uploadKeineDatei')
    return
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    fehler.value = t('view.backup.uploadKeinZip')
    return
  }
  if (!confirm(t('view.backup.uploadFrage', { name: file.name }))) return
  if (!confirm(t('view.backup.restoreFrage2'))) return
  uploadLaeuft.value = true
  fehler.value = null
  try {
    const form = new FormData()
    form.append('file', file)
    // Die Bestaetigung laeuft als Query-Parameter (siehe Server-Route).
    const r = await apiFetch<{ jobId: string; name: string }>(
      '/api/admin/backup/restore/upload?confirm=yes',
      { method: 'POST', body: form },
    )
    await fuehreRestoreJob(r.jobId, r.name ?? file.name)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploadLaeuft.value = false
  }
}

onMounted(ladeAlles)

const scheduleHint = computed(() => {
  if (settings.value.schedule === '') return t('view.backup.scheduleAus')
  return t('view.backup.scheduleAn', { zeit: settings.value.schedule })
})

const settingsDirty = ref(false)
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.backup.h1') }}</h1>
      <p class="hint">{{ t('view.backup.intro') }}</p>
    </header>

    <div v-if="fehler" class="card error" role="alert">
      <strong>{{ t('view.backup.fehler') }}</strong>
      <p>{{ fehler }}</p>
    </div>
    <div v-if="erfolg" class="card success" role="status">{{ erfolg }}</div>

    <h2>{{ t('view.backup.runH2') }}</h2>
    <div class="card">
      <div class="actions">
        <button
          type="button"
          class="primary"
          :disabled="backupJob.status === 'running'"
          @click="backupErstellen"
        >
          {{
            backupJob.status === 'running'
              ? t('view.backup.laeuft')
              : t('view.backup.jetztErstellen')
          }}
        </button>
        <button type="button" class="secondary" :disabled="laedt" @click="ladeAlles">
          {{ t('view.backup.aktualisieren') }}
        </button>
      </div>
      <div v-if="backupJob.status === 'failed'" class="hint error" role="alert">
        {{ backupJob.error }}
      </div>
      <div v-if="backupJob.status === 'done'" class="hint hint-ok" role="status">
        {{ t('view.backup.jobErledigt', { filename: backupJob.id ?? '' }) }}
      </div>
    </div>

    <h2>{{ t('view.backup.uploadH2') }}</h2>
    <div class="card">
      <p class="hint">{{ t('view.backup.uploadHinweis') }}</p>
      <div class="upload-zeile">
        <input
          type="file"
          accept=".zip,application/zip"
          data-testid="backup-upload-datei"
          :disabled="uploadLaeuft || restoreJob.status === 'running'"
          @change="onUploadDateiChange"
        />
        <button
          type="button"
          class="danger"
          :disabled="uploadLaeuft || restoreJob.status === 'running' || !uploadDatei"
          @click="dateiHochladen"
        >
          {{
            uploadLaeuft || restoreJob.status === 'running'
              ? t('view.backup.restoreLaeuft')
              : t('view.backup.uploadAktion')
          }}
        </button>
      </div>
      <small v-if="uploadDatei" class="hint">
        {{
          t('view.backup.uploadGewaehlt', {
            name: uploadDatei.name,
            size: humanSize(uploadDatei.size),
          })
        }}
      </small>
      <div v-if="restoreJob.status === 'running'" class="hint" role="status">
        {{ t('view.backup.restoreLaeuftHinweis', { name: restoreJob.name ?? '' }) }}
      </div>
      <div v-if="restoreJob.status === 'failed'" class="hint error" role="alert">
        {{ restoreJob.error || t('view.backup.restoreFehlgeschlagen') }}
      </div>
      <div
        v-if="restoreJob.status === 'done' && restoreJob.result"
        class="hint hint-ok"
        role="status"
      >
        {{
          t('view.backup.restoreErgebnis', {
            dump: humanSize(restoreJob.result.dumpBytes),
            fotos: restoreJob.result.fotoDateien,
            datanorm: restoreJob.result.datanormDateien,
          })
        }}
        <br v-if="restoreJob.result.userWiederhergestellt" />
        <span v-if="restoreJob.result.userWiederhergestellt">
          {{ t('view.backup.adminWiederhergestellt') }}
        </span>
      </div>
    </div>

    <h2>{{ t('view.backup.settingsH2') }}</h2>
    <div class="card">
      <form class="form" @submit.prevent="speichereSettings">
        <label>
          <span>{{ t('view.backup.schedule') }}</span>
          <input
            v-model="settings.schedule"
            type="time"
            :disabled="speichert"
            @input="settingsDirty = true"
          />
          <small class="hint">{{ scheduleHint }}</small>
        </label>
        <label>
          <span>{{ t('view.backup.keepCopies') }}</span>
          <input
            v-model.number="settings.keepCopies"
            type="number"
            min="1"
            max="365"
            :disabled="speichert"
            @input="settingsDirty = true"
          />
          <small class="hint">{{ t('view.backup.keepCopiesHint') }}</small>
        </label>
        <div class="form-actions">
          <button type="submit" class="primary" :disabled="speichert || !settingsDirty">
            {{ speichert ? t('view.backup.laeuft') : t('view.backup.settingsSpeichern') }}
          </button>
        </div>
      </form>
    </div>

    <h2>{{ t('view.backup.listeH2') }}</h2>
    <div class="card">
      <p v-if="files.length === 0" class="hint">{{ t('view.backup.listeLeer') }}</p>
      <table v-else class="data">
        <thead>
          <tr>
            <th>{{ t('view.backup.colName') }}</th>
            <th class="num">{{ t('view.backup.colGroesse') }}</th>
            <th>{{ t('view.backup.colDatum') }}</th>
            <th>{{ t('view.backup.colAktionen') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files" :key="f.name">
            <td class="mono">
              {{ f.name }}
              <span
                v-if="f.dumpOk === false"
                class="badge-warn"
                :title="t('view.backup.dumpLeerHint')"
              >
                {{ t('view.backup.dumpLeer') }}
              </span>
            </td>
            <td class="num">{{ humanSize(f.size) }}</td>
            <td>{{ humanDate(f.createdAt) }}</td>
            <td class="row-actions">
              <button
                type="button"
                class="secondary small"
                :disabled="backupJob.status === 'running' || restoreJob.status === 'running'"
                @click="dateiHerunterladen(f.name)"
              >
                {{ t('view.backup.aktionDownload') }}
              </button>
              <button
                type="button"
                class="danger small"
                :disabled="
                  backupJob.status === 'running' ||
                  restoreJob.status === 'running' ||
                  f.dumpOk === false
                "
                :title="f.dumpOk === false ? t('view.backup.dumpLeerHint') : undefined"
                @click="dateiRestaurieren(f.name)"
              >
                {{ t('view.backup.aktionRestore') }}
              </button>
              <button
                type="button"
                class="secondary small"
                :disabled="backupJob.status === 'running' || restoreJob.status === 'running'"
                @click="dateiLoeschen(f.name)"
              >
                {{ t('view.backup.aktionLoeschen') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="files.some((f) => f.dumpOk === false)" class="hint hint-warn">
        {{ t('view.backup.dumpLeerListe') }}
      </p>
      <p v-if="backupDir" class="hint mono backup-dir">
        {{ t('view.backup.listePfad') }}: <code>{{ backupDir }}</code>
      </p>
    </div>
  </section>
</template>

<style scoped>
.view {
  max-width: 1000px;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.form {
  display: grid;
  gap: 0.75rem;
  max-width: 24rem;
}
.form label {
  display: grid;
  gap: 0.25rem;
}
.form input {
  padding: 0.4rem 0.6rem;
  font-size: 1em;
  border: 1px solid var(--border);
  border-radius: 0.3rem;
  background: var(--bg-input);
  color: inherit;
}
.form-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.data {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
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
}
.data td.num,
.data th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.data td.mono,
.mono {
  font-family: ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 0.85em;
}
.row-actions {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
.upload-zeile {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
  margin: 0.5rem 0;
}
.badge-warn {
  display: inline-block;
  margin-left: 0.35rem;
  padding: 0.05rem 0.35rem;
  border-radius: 0.25rem;
  font-size: 0.75em;
  font-family: ui-sans-serif, system-ui, sans-serif;
  color: var(--err-accent, #b00020);
  background: var(--err-bg, #fde8e8);
  border: 1px solid var(--err-accent, #b00020);
}
.hint-warn {
  color: var(--err-accent, #b00020);
}
button.small {
  padding: 0.2rem 0.5rem;
  font-size: 0.85em;
}
.error {
  border-left: 3px solid var(--err-accent, #b00020);
  background: var(--err-bg, #fde8e8);
  padding: 0.5rem 0.75rem;
}
.success {
  border-left: 3px solid var(--ok-accent, #2e7d32);
  background: var(--ok-bg, #e6f4ea);
  padding: 0.5rem 0.75rem;
}
.backup-dir {
  margin-top: 0.5rem;
  word-break: break-all;
}
</style>
