// Tests für die Geräte-Ansicht (Einstellungen → Daten → Lokaler Speicher).
//
// Erwartetes Verhalten:
//   - Die Route ist NICHT admin-only. Die lokale IndexedDB ist ein flüchtiger
//     Spiegel des Servers — jeder User muss sie neu aufbauen können, sonst
//     ist ein festgefahrener Sync (Geister-Buchungen) für ihn unlösbar.
//   - Der Reset braucht eine Bestätigung und läuft über resetLocalDbAndPull
//     (Worker stoppen, IndexedDB löschen, vollen Snapshot ziehen).
//   - Noch nicht übertragene Outbox-Änderungen werden vor dem Reset explizit
//     gemahnt — sie würden sonst kommentarlos verloren gehen.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import GeraetView from '../GeraetView.vue'
import { i18n } from '../../i18n'
import { router } from '../../router'
import { useSyncStore } from '../../stores/sync'
import { sessionSchreiben } from '../../auth/session'
import { jetztIso } from '../../domain/ids'

const resetMock = vi.hoisted(() =>
  vi.fn(async (_opts: { token: string | null; apiBase: string }) => ({
    deletedDb: 'castel',
    pulled: {
      artikel: 4,
      standorte: 2,
      commission: 1,
      buchungen: 7,
      einstellungen: 3,
      mindestbestandEreignisse: 0,
      artikelStandortMindestbestaende: 0,
      akkuNetzteile: 0,
      akkuProjekte: 0,
      akkuBestellungen: 0,
    },
    reloaded: false,
  })),
)

vi.mock('../../services/sync/reset-local-db', () => ({
  resetLocalDbAndPull: resetMock,
  wipeLocalDbWithoutPull: vi.fn(),
  DB_NAME: 'castel',
}))

const LS_SESSION = 'castel.auth.session'

/**
 * The app router is only imported to read its route metadata. Mounting with
 * it would run an initial navigation (and jsdom has no `window.scrollTo`), so
 * the component gets a throwaway memory router.
 */
const testRouter = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/einstellungen/geraet', component: { template: '<div />' } }],
})

function anzahlen(
  pinia: Pinia,
  local: Record<string, number>,
  server: Record<string, number>,
  pending = 0,
): void {
  const sync = useSyncStore(pinia)
  sync.status = {
    ...sync.status,
    localCounts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0, ...local },
    serverCounts: { artikel: 0, standorte: 0, commission: 0, buchungen: 0, ...server },
    pending,
  }
}

function mountView(pinia: Pinia) {
  return mount(GeraetView, { global: { plugins: [pinia, i18n, testRouter] } })
}

function zeile(w: ReturnType<typeof mountView>, label: string): string {
  const row = w.findAll('tbody tr').find((r) => r.text().includes(label))
  return row?.text() ?? ''
}

describe('GeraetView — Reset der lokalen DB für jede Rolle', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'de-DE'
    localStorage.removeItem(LS_SESSION)
    localStorage.removeItem('castel.auth.jwt')
    resetMock.mockClear()
    sessionSchreiben({
      userId: 'user-normal',
      email: 'normal@example.com',
      rolle: 'user',
      anzeigename: 'Normaler User',
      loginAm: jetztIso(),
      mustChangePassword: false,
      jwtExpiresAt: jetztIso(),
    })
  })

  it('die Route ist ohne Admin-Rechte erreichbar', () => {
    const route = router.getRoutes().find((r) => r.name === 'einstellungen-geraet')
    expect(route).toBeDefined()
    expect(route?.meta.requiresAdmin).toBeUndefined()
    expect(route?.path).toBe('/einstellungen/geraet')
  })

  it('zeigt lokale und Server-Zähler für Artikel und Buchungen', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    anzahlen(pinia, { artikel: 3, buchungen: 9 }, { artikel: 3, buchungen: 7 })

    const w = mountView(pinia)
    expect(zeile(w, 'Buchungen')).toContain('9')
    expect(zeile(w, 'Buchungen')).toContain('7')
    expect(zeile(w, 'Artikel')).toContain('3')
  })

  it('mahnt offene Outbox-Änderungen, bevor zurückgesetzt wird', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    anzahlen(pinia, { buchungen: 9 }, { buchungen: 9 }, 2)

    const w = mountView(pinia)
    await w.find('button.danger').trigger('click')
    await w.vm.$nextTick()

    const bestätigung = w.find('[role="alertdialog"]')
    expect(bestätigung.exists()).toBe(true)
    expect(bestätigung.text()).toContain('nicht übertragen')
    expect(resetMock).not.toHaveBeenCalled()
  })

  it('setzt die lokale Datenbank nach Bestätigung hart zurück und zieht den Snapshot', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    localStorage.setItem('castel.auth.jwt', 'jwt-fuer-reset')
    anzahlen(pinia, { buchungen: 9 }, { buchungen: 9 }, 0)

    const w = mountView(pinia)
    await w.find('button.danger').trigger('click')
    await w.vm.$nextTick()

    const bestätigen = w
      .findAll('[role="alertdialog"] button')
      .find((b) => b.text().includes('zurücksetzen'))
    expect(bestätigen).toBeDefined()
    await bestätigen!.trigger('click')
    await w.vm.$nextTick()
    await new Promise<void>((r) => setTimeout(r, 10))

    expect(resetMock).toHaveBeenCalledTimes(1)
    expect(resetMock.mock.calls[0]?.[0]).toMatchObject({ token: 'jwt-fuer-reset' })
    expect(w.find('[role="alertdialog"]').text()).toContain('neu aufgebaut')
  })

  it('ein Abbruch lösch nichts', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    anzahlen(pinia, { buchungen: 9 }, { buchungen: 9 }, 0)

    const w = mountView(pinia)
    await w.find('button.danger').trigger('click')
    await w.vm.$nextTick()
    const abbrechen = w.findAll('[role="alertdialog"] button').find((b) => b.text() === 'Abbrechen')
    expect(abbrechen).toBeDefined()
    await abbrechen!.trigger('click')
    await w.vm.$nextTick()

    expect(resetMock).not.toHaveBeenCalled()
    expect(w.find('[role="alertdialog"]').exists()).toBe(false)
  })
})
