// Tests für die Backup-&-Restore-Ansicht.
//
// Erwartetes Verhalten:
//   - Ein zuvor heruntergeladenes Backup-ZIP kann hochgeladen und
//     eingespielt werden (Notfall-Weg: Server neu aufgesetzt, Backup-Volume
//     leer). Der Upload nutzt multipart (FormData) und meldet die
//     Bestätigung als Query-Parameter.
//   - Der Restore läuft asynchron: der Server antwortet mit einer Job-ID,
//     der Status wird gepollt. Erst danach wird der lokale Stand neu
//     aufgebaut (resetLocalDbAndPull) — der Server-Stand ist Source of Truth.
//   - Ohne Datei oder mit einer Nicht-ZIP-Datei wird nichts hochgeladen.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import BackupView from '../BackupView.vue'
import { i18n } from '../../i18n'

const apiFetchMock = vi.hoisted(() => vi.fn())
const resetMock = vi.hoisted(() =>
  vi.fn(async (_opts: { token: string | null; apiBase: string }) => ({
    deletedDb: 'castel',
    pulled: {
      artikel: 0,
      standorte: 0,
      commission: 0,
      buchungen: 0,
      einstellungen: 0,
      mindestbestandEreignisse: 0,
      artikelStandortMindestbestaende: 0,
      akkuNetzteile: 0,
      akkuProjekte: 0,
      akkuBestellungen: 0,
    },
    reloaded: false,
  })),
)

vi.mock('../../auth/api', () => ({
  apiFetch: apiFetchMock,
  getApiBaseUrl: () => '',
}))

vi.mock('../../services/sync/reset-local-db', () => ({
  resetLocalDbAndPull: resetMock,
  wipeLocalDbWithoutPull: vi.fn(),
  DB_NAME: 'castel',
}))

const testRouter = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/einstellungen/backup', component: { template: '<div />' } }],
})

function mountView() {
  return mount(BackupView, { global: { plugins: [i18n, testRouter] } })
}

function zipFile(name = 'backup.zip'): File {
  return new File(['PK'], name, { type: 'application/zip' })
}

describe('BackupView — Restore aus einem hochgeladenen ZIP', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'de-DE'
    apiFetchMock.mockReset()
    resetMock.mockClear()
    localStorage.setItem('castel.auth.jwt', 'jwt-fuer-restore')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/admin/backup/settings') return { schedule: '', keepCopies: 7 }
      if (path === '/api/admin/backup/list') {
        return { files: [], dir: '/var/lib/castel/backups' }
      }
      if (path === '/api/admin/backup/restore/upload?confirm=yes') {
        return { jobId: 'job-42', status: 'running', name: 'castel-backup-x.zip' }
      }
      if (path.startsWith('/api/admin/backup/status/')) {
        return {
          status: 'done',
          kind: 'restore',
          filename: 'castel-backup-x.zip',
          result: {
            dumpBytes: 2048,
            fotoDateien: 3,
            datanormDateien: 1,
            userWiederhergestellt: true,
            restoreEpoch: '2026-11-02T10:00:00.000Z',
          },
        }
      }
      return {}
    })
  })

  it('zeigt einen Datei-Auswahl-Dialog für das Backup-ZIP', () => {
    const w = mountView()
    const input = w.find('[data-testid="backup-upload-datei"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('accept')).toContain('.zip')
  })

  it('lädt das ZIP per multipart hoch und spielt es ein', async () => {
    vi.useFakeTimers()
    try {
      const w = mountView()
      const input = w.find('[data-testid="backup-upload-datei"]')
      const datei = zipFile()
      Object.defineProperty(input.element, 'files', { value: [datei], configurable: true })
      await input.trigger('change')
      await w.vm.$nextTick()

      // Ohne Datei ist der Button deaktiviert, mit Datei aktiv.
      const knopf = w.findAll('button').find((b) => b.text().includes('Hochladen'))
      expect(knopf?.attributes('disabled')).toBeUndefined()

      await knopf!.trigger('click')
      await vi.advanceTimersByTimeAsync(2500)
      await w.vm.$nextTick()

      const uploadAufruf = apiFetchMock.mock.calls.find((c) =>
        String(c[0]).startsWith('/api/admin/backup/restore/upload'),
      )
      expect(uploadAufruf).toBeDefined()
      expect(uploadAufruf?.[0]).toBe('/api/admin/backup/restore/upload?confirm=yes')
      expect(uploadAufruf?.[1]).toMatchObject({ method: 'POST' })
      // Der Body ist multipart (FormData) — kein JSON.
      expect(uploadAufruf?.[1]?.body).toBeInstanceOf(FormData)

      // Danach wurde der lokale Stand neu aufgebaut (Server ist Source of Truth).
      expect(resetMock).toHaveBeenCalledTimes(1)
      expect(resetMock.mock.calls[0]?.[0]).toMatchObject({ token: 'jwt-fuer-restore' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('lädt ohne Datei nicht hoch und nennt den Grund', async () => {
    const w = mountView()
    const knopf = w.findAll('button').find((b) => b.text().includes('Hochladen'))
    expect(knopf?.attributes('disabled')).toBeDefined()
    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('restore/upload'))).toBe(false)
  })

  it('lehnt eine Datei ab, die kein ZIP ist', async () => {
    const w = mountView()
    const input = w.find('[data-testid="backup-upload-datei"]')
    const datei = new File(['text'], 'notiz.txt', { type: 'text/plain' })
    Object.defineProperty(input.element, 'files', { value: [datei], configurable: true })
    await input.trigger('change')
    await w.vm.$nextTick()

    const knopf = w.findAll('button').find((b) => b.text().includes('Hochladen'))
    await knopf!.trigger('click')
    await w.vm.$nextTick()

    expect(apiFetchMock.mock.calls.some((c) => String(c[0]).includes('restore/upload'))).toBe(false)
    expect(w.find('[role="alert"]').text()).toContain('.zip')
  })

  it('fragt vor dem Einspielen zweimal nach Bestätigung', async () => {
    vi.useFakeTimers()
    try {
      const w = mountView()
      const input = w.find('[data-testid="backup-upload-datei"]')
      Object.defineProperty(input.element, 'files', { value: [zipFile()], configurable: true })
      await input.trigger('change')
      await w.vm.$nextTick()

      const knopf = w.findAll('button').find((b) => b.text().includes('Hochladen'))
      await knopf!.trigger('click')
      await w.vm.$nextTick()

      expect(window.confirm).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
