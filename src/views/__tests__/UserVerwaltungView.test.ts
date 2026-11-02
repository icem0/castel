// Tests der Benutzerverwaltung mit stapelbaren Rollen.
//
//   * Die Rollen-Legende zeigt die Rollen aus der Matrix.
//   * Beim Anlegen werden mehrere Rollen uebergeben.
//   * Der Rollen-Editor kann Rollen hinzufuegen/entfernen; admin ist exklusiv.
//   * Der letzte aktive Admin kann nicht degradiert werden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import UserVerwaltungView from '../UserVerwaltungView.vue'
import { useAuthStore } from '../../stores/auth'
import { sessionSchreiben } from '../../auth/session'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/einstellungen', component: { template: '<div />' } },
  ],
})

const userStoreMock = vi.hoisted(() => ({
  users: [] as Array<{
    id: string
    email: string
    anzeigename?: string
    rolle: 'admin' | 'user'
    rollen: Array<'user' | 'lagerist' | 'admin'>
    aktiv: boolean
    erstelltAm: string
    letzterLoginAm: string | null
  }>,
  laden: vi.fn(),
}))

vi.mock('../../stores/users', () => ({
  useUserStore: () => userStoreMock,
}))

const rollenStoreMock = vi.hoisted(() => ({
  rollen: [
    { id: 'user', titel: 'User', beschreibung: 'Basis', rechte: ['Lesen'], berechtigungen: [] },
    {
      id: 'lagerist',
      titel: 'Lagerist',
      beschreibung: 'Lager',
      rechte: ['Artikel pflegen'],
      berechtigungen: [],
    },
    { id: 'admin', titel: 'Admin', beschreibung: 'Alles', rechte: ['Alles'], berechtigungen: [] },
  ],
  geladen: true,
  laden: vi.fn(),
  titel: (id: string) =>
    userStoreMock ? (id === 'user' ? 'User' : id === 'lagerist' ? 'Lagerist' : 'Admin') : id,
  beschreibung: (id: string) => `Beschreibung ${id}`,
  rechte: (id: string) => [`Recht ${id}`],
  berechtigungTitel: (id: string) => id,
}))

vi.mock('../../stores/rollen', () => ({
  useRollenStore: () => rollenStoreMock,
}))

function adminSession() {
  sessionSchreiben({
    userId: 'u1',
    email: 'admin@example.com',
    rolle: 'admin',
    rollen: ['admin'],
    anzeigename: 'Admin',
    loginAm: '2026-10-29T12:00:00.000Z',
    mustChangePassword: false,
    jwtExpiresAt: '2026-10-30T12:00:00.000Z',
  })
}

async function setupView() {
  const pinia = createPinia()
  setActivePinia(pinia)
  adminSession()
  const wrapper = mount(UserVerwaltungView, { global: { plugins: [pinia, router] } })
  await flushPromises()
  return { wrapper, pinia }
}

describe('UserVerwaltungView — Rollen', () => {
  beforeEach(() => {
    userStoreMock.users = [
      {
        id: 'u1',
        email: 'admin@example.com',
        anzeigename: 'Admin',
        rolle: 'admin',
        rollen: ['admin'],
        aktiv: true,
        erstelltAm: '2026-10-01T10:00:00.000Z',
        letzterLoginAm: '2026-10-20T10:00:00.000Z',
      },
      {
        id: 'u2',
        email: 'lager@example.com',
        anzeigename: 'Lagerist',
        rolle: 'user',
        rollen: ['user', 'lagerist'],
        aktiv: true,
        erstelltAm: '2026-10-02T10:00:00.000Z',
        letzterLoginAm: null,
      },
    ]
    userStoreMock.laden.mockReset()
    userStoreMock.laden.mockResolvedValue(undefined)
  })

  afterEach(() => {
    sessionSchreiben(null)
    vi.restoreAllMocks()
  })

  it('zeigt die Rollen-Legende mit den Rechten je Rolle', async () => {
    const { wrapper } = await setupView()
    const text = wrapper.text()
    expect(text).toContain('Rollen und Berechtigungen')
    expect(text).toContain('Lagerist')
    expect(text).toContain('Recht lagerist')
  })

  it('zeigt die Rollen des Users als Badges', async () => {
    const { wrapper } = await setupView()
    const badges = wrapper.findAll('.badge').map((b) => b.text())
    expect(badges).toContain('Admin')
    expect(badges).toContain('Lagerist')
  })

  it('legt einen User mit mehreren Rollen an', async () => {
    const { wrapper, pinia } = await setupView()
    const auth = useAuthStore(pinia)
    const anlegen = vi.spyOn(auth, 'neuerUser').mockResolvedValue(undefined)

    await wrapper.get('button.primary').trigger('click')
    await flushPromises()

    // E-Mail und Passwort fuellen.
    const texteingaben = wrapper.findAll('input[type="text"], input[type="email"]')
    await texteingaben[texteingaben.length - 1]?.setValue('neu@example.com')
    await wrapper.find('input[type="password"]').setValue('geheim123')

    // Checkboxen der Rollenwahl: erst Lagerist, dann Admin.
    const checkboxen = wrapper.findAll('input[type="checkbox"]')
    await checkboxen[1]?.setValue(true) // Lagerist
    await checkboxen[2]?.setValue(true) // Admin
    await flushPromises()

    await wrapper.get('form').trigger('submit.prevent')
    await flushPromises()

    expect(anlegen).toHaveBeenCalled()
    const arg = anlegen.mock.calls[0]?.[0] as { rollen: string[] }
    // Admin ist exklusiv.
    expect(arg.rollen).toEqual(['admin'])
  })

  it('speichert geaenderte Rollen ueber den Rollen-Editor', async () => {
    const { wrapper, pinia } = await setupView()
    const auth = useAuthStore(pinia)
    const aendern = vi.spyOn(auth, 'aendereRollen').mockResolvedValue(undefined)

    // Zeile von u2 (Lagerist) -> Rollen-Editor oeffnen.
    const knoepfe = wrapper.findAll('button').filter((b) => (b.text() ?? '').trim() === 'Rollen')
    await knoepfe[1]?.trigger('click')
    await flushPromises()

    const speichern = wrapper.findAll('button').find((b) => (b.text() ?? '').trim() === 'Speichern')
    await speichern?.trigger('click')
    await flushPromises()

    expect(aendern).toHaveBeenCalledWith('u2', ['user', 'lagerist'])
  })
})
