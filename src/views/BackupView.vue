<script setup lang="ts">
// Admin-View: Backup & Restore.
//
// Funktionen:
//   - "Jetzt Backup herunterladen" -> Server baut on-the-fly ein ZIP
//     (sync -> pg_dump -Fc -> FOTOS_DIR -> zip -> Stream) und der Browser
//     speichert es.
//   - "Jetzt Backup erstellen"     -> legt das ZIP im BACKUP_DIR-Volume ab.
//   - Schedule-Formular            -> HH:MM (Cronjob) + Anzahl Kopien.
//   - Liste vorhandener Backups    -> loeschen, herunterladen, restaurieren.

import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { apiFetch, getApiBaseUrl } from '../auth/api'
import { jwtLesen } from '../auth/session'

const { t } = useI18n()

interface BackupSettings {
  schedule: string
  keepCopies: number
}

interface BackupDatei {
  name: string
  size: number
  createdAt: string
}

interface BackupListResponse {
  files: BackupDatei[]
  dir: string
}

interface RunResponse {
  filename: string
  bytes: number
  size: number
  geloescht: number
  total: number
}

const settings = ref<BackupSettings>({ schedule: '', keepCopies: 7 })
const files = ref<BackupDatei[]>([])
const backupDir = ref<string>('')

const laedt = ref(false)
const speichert = ref(false)
const fehler = ref<string | null>(null)
const erfolg = ref<string | null>(null)
const laufAktion = ref<null | 'download' | 'run' | string>(null)

const letzteRun = ref<RunResponse | null>(null)
const settingsDirty = ref(false)

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
    settingsDirty.value = false
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
    settingsDirty.value = false
    erfolg.value = t('view.backup.settingsGespeichert')
    setTimeout(() => (erfolg.value = null), 2000)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    speichert.value = false
  }
}

async function backupHerunterladen(): Promise<void> {
  laufAktion.value = 'download'
  fehler.value = null
  erfolg.value = null
  try {
    const url = `${getApiBaseUrl()}/api/admin/backup/download`
    const res = await fetchStream(url, { method: 'POST' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
    }
    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') ?? ''
    const m = cd.match(/filename="?([^";]+)"?/)
    const filename = m?.[1] ?? `castel-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    a.click()
    URL.revokeObjectURL(objectUrl)
    erfolg.value = t('view.backup.downloadErfolg', { filename })
    setTimeout(() => (erfolg.value = null), 4000)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufAktion.value = null
  }
}

async function backupErstellen(): Promise<void> {
  laufAktion.value = 'run'
  fehler.value = null
  erfolg.value = null
  try {
    const r = await apiFetch<RunResponse>('/api/admin/backup/run', { method: 'POST' })
    letzteRun.value = r
    erfolg.value = t('view.backup.runErfolg', { filename: r.filename, geloescht: r.geloescht })
    setTimeout(() => (erfolg.value = null), 4000)
    await ladeAlles()
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufAktion.value = null
  }
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
  if (
    !confirm(
      t('view.backup.restoreFrage2', {
        default: 'Wirklich? Letzte Chance — der Server muss vorher gestoppt sein!',
      }),
    )
  )
    return
  laufAktion.value = name
  fehler.value = null
  try {
    await apiFetch('/api/admin/backup/restore', {
      method: 'POST',
      body: { name, confirm: 'yes' },
    })
    erfolg.value = t('view.backup.restoreErfolg', { name })
    setTimeout(() => (erfolg.value = null), 4000)
  } catch (e) {
    fehler.value = e instanceof Error ? e.message : String(e)
  } finally {
    laufAktion.value = null
  }
}

onMounted(ladeAlles)

const scheduleHint = computed(() => {
  if (settings.value.schedule === '') return t('view.backup.scheduleAus')
  return t('view.backup.scheduleAn', { zeit: settings.value.schedule })
})
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
          :disabled="laufAktion !== null"
          @click="backupHerunterladen"
        >
          {{
            laufAktion === 'download'
              ? t('view.backup.laeuft')
              : t('view.backup.jetztHerunterladen')
          }}
        </button>
        <button type="button" :disabled="laufAktion !== null" @click="backupErstellen">
          {{ laufAktion === 'run' ? t('view.backup.laeuft') : t('view.backup.jetztErstellen') }}
        </button>
        <button type="button" class="secondary" :disabled="laedt" @click="ladeAlles">
          {{ t('view.backup.aktualisieren') }}
        </button>
      </div>
      <p v-if="letzteRun" class="hint hint-ok">
        {{
          t('view.backup.letzterRun', {
            filename: letzteRun.filename,
            bytes: humanSize(letzteRun.size),
            geloescht: letzteRun.geloescht,
            total: letzteRun.total,
          })
        }}
      </p>
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
            <td class="mono">{{ f.name }}</td>
            <td class="num">{{ humanSize(f.size) }}</td>
            <td>{{ humanDate(f.createdAt) }}</td>
            <td class="row-actions">
              <button
                type="button"
                class="secondary small"
                :disabled="laufAktion === f.name"
                @click="dateiHerunterladen(f.name)"
              >
                {{ t('view.backup.aktionDownload') }}
              </button>
              <button
                type="button"
                class="danger small"
                :disabled="laufAktion === f.name"
                @click="dateiRestaurieren(f.name)"
              >
                {{ t('view.backup.aktionRestore') }}
              </button>
              <button
                type="button"
                class="secondary small"
                :disabled="laufAktion === f.name"
                @click="dateiLoeschen(f.name)"
              >
                {{ t('view.backup.aktionLoeschen') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
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
  border: 1px solid var(--border, #ccc);
  border-radius: 0.3rem;
  background: var(--input-bg, #fff);
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
