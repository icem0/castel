// Tests für ArtikelKatalogeView (Einstellungen → Stammdaten → Artikelkataloge).
//
// Abgedeckt: Katalog-Browser für alle User, Admin-Karten nur für Admins,
// Übernahme-Navigation ins vorbefüllte Artikelformular, Lieferanten-Anlage.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../../stores/auth'
import de from '../../locales/de-DE'
import ArtikelKatalogeView from '../ArtikelKatalogeView.vue'
import * as admin from '../../services/datanorm/admin'
import * as lookup from '../../services/datanorm/lookup'

const push = vi.fn()

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: '<a><slot /></a>' },
}))

vi.mock('../../services/datanorm/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/datanorm/admin')>()
  return {
    ...actual,
    ladeLieferanten: vi.fn(),
    anlageLieferant: vi.fn(),
    patchLieferant: vi.fn(),
    uploadDatanormDatei: vi.fn(),
    ladeImporte: vi.fn(),
  }
})

vi.mock('../../services/datanorm/lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/datanorm/lookup')>()
  return {
    ...actual,
    ladeLieferanten: vi.fn(),
    sucheHerstellerArtikel: vi.fn(),
  }
})

const LIEFERANTEN = [
  { id: 'l1', name: 'Mueller GmbH', matchcode: 'MUE', aktiv: true, ort: null, geaendertAm: '' },
  { id: 'l2', name: 'Sanitaer Meier', matchcode: 'MEI', aktiv: true, ort: 'Bern', geaendertAm: '' },
]

const TREFFER = {
  id: 'a1',
  matchcode: 'ART-1001',
  matchcode2: null,
  ean: '4006381333931',
  titel: 'Bleistift HB',
  beschreibung: null,
  mengeneinheit: 'STK',
  preiseinheit: null,
  inhalt: null,
  warengruppe: 'WG-1',
  preisNettoCent: 249,
  preisBruttoCent: 299,
  gueltigAb: null,
  ersatzMatchcode: null,
  deaktiviert: false,
  deaktiviertAm: null,
  geaendertAm: '',
}

/** Builds the component with a logged-in user of the given role. */
function setup(rolle: 'admin' | 'user' = 'user') {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.session = {
    userId: 'u1',
    email: 'a@example.de',
    rolle,
    loginAm: '2026-01-01T00:00:00.000Z',
    mustChangePassword: false,
    jwtExpiresAt: '2099-01-01T00:00:00.000Z',
  }

  const i18n = createI18n({ legacy: false, locale: 'de', messages: { de } })
  const wrapper = mount(ArtikelKatalogeView, { global: { plugins: [i18n] } })
  return { wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(lookup.ladeLieferanten).mockResolvedValue(LIEFERANTEN)
  vi.mocked(admin.ladeImporte).mockResolvedValue([])
  vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
    lieferant: { id: 'l1', name: 'Mueller GmbH' },
    suchstrategie: 'titel',
    treffer: [TREFFER],
    page: 1,
    pageSize: 25,
    total: 42,
    hasMore: false,
  })
})

describe('ArtikelKatalogeView', () => {
  it('lädt die Lieferanten und füllt das Select', async () => {
    const { wrapper } = setup()
    await flushPromises()
    expect(lookup.ladeLieferanten).toHaveBeenCalled()
    const optionen = Array.from(wrapper.findAll('option')).map((o) => o.text())
    expect(optionen.some((t) => t.includes('Mueller GmbH'))).toBe(true)
  })

  it('sucht erst, wenn ein Lieferant gewählt ist', async () => {
    const { wrapper } = setup()
    await flushPromises()
    // Erster Lieferant wird vorselektiert.
    const suchen = wrapper.find('[data-testid="katalog-suchen"]')
    expect((suchen.element as HTMLButtonElement).disabled).toBe(false)

    await wrapper.find('[data-testid="katalog-suche"]').setValue('Bleistift')
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()

    expect(lookup.sucheHerstellerArtikel).toHaveBeenCalledWith(
      expect.objectContaining({ lieferantId: 'l1', q: 'Bleistift', limit: 25 }),
    )
    expect(wrapper.text()).toContain('Bleistift HB')
    expect(wrapper.text()).toContain('42 Artikel im Katalog')
  })

  it('verwirft Treffer beim Lieferantenwechsel', async () => {
    const { wrapper } = setup()
    await flushPromises()
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Bleistift HB')

    await wrapper.find('[data-testid="katalog-lieferant"]').setValue('l2')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Bleistift HB')
  })

  it('meldet leere Treffer und leere Lieferantenliste', async () => {
    vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
      lieferant: { id: 'l1', name: 'Mueller GmbH' },
      suchstrategie: 'titel',
      treffer: [],
      page: 1,
      pageSize: 25,
      total: 0,
      hasMore: false,
    })
    const { wrapper } = setup()
    await flushPromises()
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Keine passenden Artikel gefunden')
  })

  it('zeigt den Hinweis, wenn noch kein Katalog existiert', async () => {
    vi.mocked(lookup.ladeLieferanten).mockResolvedValue([])
    const { wrapper } = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('Noch kein Lieferant-Katalog vorhanden')
  })

  it('übernimmt den Katalogeintrag ins vorbefüllte Artikelformular', async () => {
    const { wrapper } = setup()
    await flushPromises()
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()

    await wrapper.findAll('[data-testid="katalog-uebernehmen"]')[0]!.trigger('click')

    expect(push).toHaveBeenCalledWith({
      name: 'artikel-neu',
      query: {
        katTitel: 'Bleistift HB',
        katEan: '4006381333931',
        katMatchcode: 'ART-1001',
        katPreis: '2.49',
        katLieferant: 'Mueller GmbH',
      },
    })
  })

  it('übernimmt den Brutto-Preis, wenn kein Netto-Preis vorliegt', async () => {
    vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
      lieferant: { id: 'l1', name: 'Mueller GmbH' },
      suchstrategie: 'titel',
      treffer: [{ ...TREFFER, preisNettoCent: null, preisBruttoCent: 500 }],
      page: 1,
      pageSize: 25,
      total: 1,
      hasMore: false,
    })
    const { wrapper } = setup()
    await flushPromises()
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()
    await wrapper.findAll('[data-testid="katalog-uebernehmen"]')[0]!.trigger('click')

    const arg = push.mock.calls[0]![0] as { query: Record<string, string> }
    expect(arg.query.katPreis).toBe('5')
  })

  it('markiert zurückgezogene Katalogeinträge', async () => {
    vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
      lieferant: { id: 'l1', name: 'Mueller GmbH' },
      suchstrategie: 'titel',
      treffer: [{ ...TREFFER, deaktiviert: true, deaktiviertAm: '2026-01-15T00:00:00.000Z' }],
      page: 1,
      pageSize: 25,
      total: 1,
      hasMore: false,
    })
    const { wrapper } = setup()
    await flushPromises()
    await wrapper.find('[data-testid="katalog-suchen"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Nicht mehr lieferbar')
  })

  it('versteckt Upload- und Lieferantenkarten für Nicht-Admins', async () => {
    const { wrapper } = setup('user')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Katalog-Datei hochladen')
    expect(wrapper.text()).not.toContain('Lieferanten verwalten')
    expect(admin.ladeImporte).not.toHaveBeenCalled()
  })

  it('legt einen Lieferanten an (Admin)', async () => {
    const { wrapper } = setup('admin')
    await flushPromises()

    await wrapper.find('[data-testid="lieferant-name"]').setValue('Neuer Lieferant')
    await wrapper.find('[data-testid="lieferant-matchcode"]').setValue('NEU')
    await wrapper.find('[data-testid="lieferant-ort"]').setValue('Köln')
    await wrapper.find('[data-testid="lieferant-anlegen"]').trigger('submit')
    await flushPromises()

    expect(admin.anlageLieferant).toHaveBeenCalledWith({
      name: 'Neuer Lieferant',
      matchcode: 'NEU',
      ort: 'Köln',
      aktiv: true,
    })
  })

  it('deaktiviert einen Lieferanten über den Schalter (Admin)', async () => {
    vi.mocked(lookup.ladeLieferanten).mockResolvedValue([LIEFERANTEN[0]!])
    vi.mocked(admin.patchLieferant).mockResolvedValue({ ok: true })
    const { wrapper } = setup('admin')
    await flushPromises()

    const schalter = wrapper.find('input[type="checkbox"]')
    expect((schalter.element as HTMLInputElement).checked).toBe(true)
    await schalter.trigger('change')
    await flushPromises()

    expect(admin.patchLieferant).toHaveBeenCalledWith('l1', { aktiv: false })
  })

  it('lädt die Import-Historie (Admin)', async () => {
    vi.mocked(admin.ladeImporte).mockResolvedValue([
      {
        id: 'i1',
        lieferantId: 'l1',
        originalDateiname: 'mueller.dat',
        status: 'fertig',
        artikelAnzahl: 120,
        artikelNeu: 118,
        artikelAktualisiert: 2,
        artikelDeaktiviert: 0,
        fehlerAnzahl: 3,
        gestartetAm: '2026-01-01T10:00:00.000Z',
        beendetAm: '2026-01-01T10:01:00.000Z',
      },
    ])
    const { wrapper } = setup('admin')
    await flushPromises()
    expect(wrapper.text()).toContain('mueller.dat')
    expect(wrapper.text()).toContain('118')
  })

  it('lädt eine DATANORM-Datei hoch und verfolgt den Fortschritt (Admin)', async () => {
    vi.mocked(admin.uploadDatanormDatei).mockResolvedValue({
      importId: 'imp-1',
      status: 'fertig',
      artikelAnzahl: 1,
      artikelNeu: 1,
      artikelAktualisiert: 0,
      artikelDeaktiviert: 0,
      fehlerAnzahl: 0,
      gestartetAm: '2026-01-01T00:00:00.000Z',
    })

    const eventSources: Array<{
      addEventListener: (t: string, cb: (e: MessageEvent<string>) => void) => void
      close: () => void
      onerror: (() => void) | null
      /** Test helper: fires a server event at the registered listener. */
      emit: (typ: string, data: unknown) => void
    }> = []
    const spy = vi.fn(function (this: unknown) {
      const handler: Record<string, (e: MessageEvent<string>) => void> = {}
      const es = {
        addEventListener: (typ: string, cb: (e: MessageEvent<string>) => void) => {
          handler[typ] = cb
        },
        close: () => {},
        onerror: null as (() => void) | null,
        emit: (typ: string, data: unknown) =>
          handler[typ]?.({ data: JSON.stringify(data) } as MessageEvent<string>),
      }
      eventSources.push(es)
      return es
    })
    // jsdom kennt EventSource nicht — Stub global setzen, dann spyen.
    vi.stubGlobal('EventSource', spy)

    const { wrapper } = setup('admin')
    await flushPromises()

    await wrapper.find('[data-testid="upload-lieferant"]').setValue('l1')
    const file = new File(['x'], 'mueller.dat', { type: 'application/octet-stream' })
    const fileInput = wrapper.find('[data-testid="upload-datei"]')
    Object.defineProperty(fileInput.element, 'files', { value: [file] })
    await fileInput.trigger('change')
    await flushPromises()

    await wrapper.find('[data-testid="upload-start"]').trigger('click')
    await flushPromises()

    expect(admin.uploadDatanormDatei).toHaveBeenCalledWith(file, 'l1', undefined)
    expect(eventSources).toHaveLength(1)

    // Ein Fortschritts-Tick des Servers muss die Anzeige füllen.
    eventSources[0]!.emit('fortschritt', { phase: 'parse', verarbeitet: 30, gesamt: 120 })
    await flushPromises()
    expect(wrapper.find('.fuellung').attributes('style')).toContain('25%')

    eventSources[0]!.emit('abschluss', { status: 'fertig' })
    await flushPromises()
    vi.unstubAllGlobals()
  })

  it('zeigt den Offline-Hinweis, wenn die Lieferantenliste nicht lädt', async () => {
    vi.mocked(lookup.ladeLieferanten).mockRejectedValue(new Error('Failed to fetch'))
    const { wrapper } = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('Keine Verbindung zum Server')
  })
})
