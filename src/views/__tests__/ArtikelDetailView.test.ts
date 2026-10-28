import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArtikelDetailView from '../ArtikelDetailView.vue'
import { i18n } from '../../i18n'
import { useArtikelStore, type ArtikelEingabe } from '../../stores/artikel'
import { getDb, resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { sessionSchreiben } from '../../auth/session'
import * as lookup from '../../services/datanorm/lookup'

vi.mock('../../services/datanorm/lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/datanorm/lookup')>()
  return {
    ...actual,
    ladeLieferanten: vi.fn(),
    sucheHerstellerArtikel: vi.fn(),
    leseLetztenLieferant: vi.fn(() => null),
    speichereLetztenLieferant: vi.fn(),
    leseLetztesBeispiel: vi.fn(() => null),
    speichereLetztesBeispiel: vi.fn(),
  }
})

const LIEFERANTEN = [
  {
    id: 'l1',
    name: 'Mueller GmbH',
    matchcode: 'MUE',
    aktiv: true,
    ort: null,
    format: 'auto' as const,
    geaendertAm: '',
  },
]

const TREFFER = {
  id: 'a1',
  matchcode: 'ART-1001',
  matchcode2: null,
  ean: '4006381333931',
  titel: 'Bleistift HB',
  beschreibung: 'Härtegrad HB',
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

let pinia: Pinia

beforeEach(async () => {
  resetDbForTests()
  await clearLocalDbForTests()
  document.body.innerHTML = ''
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = 'de-DE'

  vi.clearAllMocks()
  vi.mocked(lookup.ladeLieferanten).mockResolvedValue(LIEFERANTEN)
  vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
    lieferant: { id: 'l1', name: 'Mueller GmbH' },
    suchstrategie: 'titel',
    treffer: [TREFFER],
    page: 1,
    pageSize: 25,
    total: 1,
    hasMore: false,
  })
})

afterEach(async () => {
  await clearLocalDbForTests()
  document.body.innerHTML = ''
})

async function setupView(
  barcode: string | null,
  weitere: Array<{ titel: string; barcode: string | null }> = [],
  extra: Partial<ArtikelEingabe> = {},
) {
  const store = useArtikelStore(pinia)
  const artikel = await store.anlegen({ titel: 'Schraube M6', typ: 'Material', barcode, ...extra })
  const andere = []
  for (const r of weitere) {
    andere.push(await store.anlegen({ titel: r.titel, typ: 'Material', barcode: r.barcode }))
  }

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/artikel/:id', name: 'artikel-detail', component: { template: '<div />' } }],
  })
  await router.push(`/artikel/${artikel.id}`)
  await router.isReady()

  const w = mount(ArtikelDetailView, {
    global: {
      plugins: [pinia, i18n, router],
      stubs: { FotoUpload: true },
    },
  })
  await flushPromises()
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
  await flushPromises()
  return { w, artikel, andere }
}

function knopf(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().startsWith(text),
  ) as HTMLButtonElement | undefined
}

async function setzeWert(input: HTMLSelectElement | HTMLInputElement, wert: string): Promise<void> {
  input.value = wert
  input.dispatchEvent(new Event(input instanceof HTMLInputElement ? 'input' : 'change'))
  await flushPromises()
}

async function warte(timeout = 10): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, timeout))
  await flushPromises()
}

function eingabeFuer(wrapper: { element: Element }, labelText: string): HTMLInputElement {
  const labels = Array.from(wrapper.element.querySelectorAll('label'))
  const label = labels.find((l) => (l.textContent ?? '').trim().startsWith(labelText))
  const input = label?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Kein Eingabefeld für ${labelText}`)
  }
  return input
}

async function fuehreKataloguebernahmeDurch(
  wrapper: { element: Element },
  barcode: string | null,
): Promise<void> {
  if (barcode !== null) {
    const barcodeFeld = eingabeFuer(wrapper, 'Barcode')
    await setzeWert(barcodeFeld, barcode)
  }
}

describe('ArtikelDetailView — Barcode', () => {
  it('rendert den Barcode des Artikels als SVG', async () => {
    const { w } = await setupView('4006381333931')

    expect(w.text()).toContain('Schraube M6')
    expect(w.text()).toContain('4006381333931')

    const svg = w.find('.barcode-row svg')
    expect(svg.exists()).toBe(true)
    expect(svg.findAll('rect').length).toBeGreaterThan(0)

    w.unmount()
  })
})

describe('ArtikelDetailView — Bestellnummer kopieren', () => {
  it('kopiert die Bestellnummer in die Zwischenablage und zeigt den Erfolg', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    const { w } = await setupView(null, [], { bestellnummer: 'B-42' })

    const button = w.get('[data-testid="artikel-detail-bestellnummer-kopieren"]')
    await button.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('B-42')
    expect(button.classes()).toContain('state-ok')

    w.unmount()
  })
})

describe('ArtikelDetailView — Katalogübernahme', () => {
  it('zeigt im Bearbeitungsformular einen Katalog-Button und schreibt übernommene Werte ins Formular', async () => {
    const { w } = await setupView(null)

    await w.get('[data-testid="artikel-detail-bearbeiten"]').trigger('click')
    await flushPromises()

    const katalogKnopf = w.get('[data-testid="artikel-detail-katalog-oeffnen"]')
    expect(katalogKnopf.text()).toContain('Katalog')

    await katalogKnopf.trigger('click')
    await warte(20)

    const lieferantSelect = document.body.querySelector(
      '.drawer-body select',
    ) as HTMLSelectElement | null
    const suchInput = document.body.querySelector('input[type="search"]') as HTMLInputElement | null
    expect(lieferantSelect).not.toBeNull()
    expect(suchInput).not.toBeNull()
    if (!lieferantSelect || !suchInput) return

    await setzeWert(lieferantSelect, 'l1')
    await setzeWert(suchInput, 'Bleistift')
    knopf('Suchen')?.click()
    await flushPromises()

    expect(knopf('Übernehmen')).toBeDefined()
    knopf('Übernehmen')?.click()
    await warte()

    expect(eingabeFuer(w, 'Titel').value).toBe('Bleistift HB')
    expect(eingabeFuer(w, 'Barcode').value).toBe('4006381333931')
    expect(eingabeFuer(w, 'Bestellnummer').value).toBe('ART-1001')
    expect(eingabeFuer(w, 'Listenpreis').value).toBe('2.49')
    expect(document.body.querySelector('.drawer-backdrop')).toBeNull()

    w.unmount()
  })

  it('belegt den Katalog-Drawer aus dem Artikel und startet die Suche', async () => {
    const { w } = await setupView(null, [], {
      bestellnummer: 'B-42',
      lieferant: 'Mueller GmbH',
    })

    await w.get('[data-testid="artikel-detail-bearbeiten"]').trigger('click')
    await flushPromises()

    await w.get('[data-testid="artikel-detail-katalog-oeffnen"]').trigger('click')
    await warte(20)

    const lieferantSelect = document.body.querySelector(
      '.drawer-body select',
    ) as HTMLSelectElement | null
    const suchInput = document.body.querySelector('input[type="search"]') as HTMLInputElement | null
    expect(lieferantSelect).not.toBeNull()
    expect(suchInput).not.toBeNull()
    if (!lieferantSelect || !suchInput) return

    // Lieferant aus dem Artikel gewaehlt, Bestellnummer als Suchbegriff.
    expect(lieferantSelect.value).toBe('l1')
    expect(suchInput.value).toBe('B-42')

    // Die Suche laeuft bereits, die Trefferliste ist sichtbar.
    expect(lookup.sucheHerstellerArtikel).toHaveBeenCalledWith(
      expect.objectContaining({ lieferantId: 'l1', q: 'B-42' }),
    )
    expect(document.body.querySelector('.treffer')?.textContent).toContain('Bleistift HB')

    w.unmount()
  })

  it('warnt vor einem bereits anderweitig vergebenen Barcode', async () => {
    const { w, andere } = await setupView(null, [{ titel: 'Zwilling', barcode: '4006381333931' }])
    const duplikat = andere[0]
    expect(duplikat).toBeDefined()

    await w.get('[data-testid="artikel-detail-bearbeiten"]').trigger('click')
    await flushPromises()
    await fuehreKataloguebernahmeDurch(w, '4006381333931')

    const banner = w.element.querySelector('.duplikat-banner')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('Zwilling')

    const link = banner?.querySelector('a') as HTMLAnchorElement | null
    expect(link?.getAttribute('href')).toBe(`/artikel/${duplikat?.id}`)

    w.unmount()
  })
})

describe('ArtikelDetailView — Bestellen-Button', () => {
  async function setupMitBestellkontakt(hersteller: {
    bestellEmail: string | null
    bestellWebseite: string | null
  }) {
    await getDb().hersteller.add({
      id: 'h-bestell',
      name: 'Lieferant Bestell-GmbH',
      bestellEmail: hersteller.bestellEmail,
      bestellWebseite: hersteller.bestellWebseite,
      rabattsatz: 0,
      geaendertAm: '2026-10-19T10:00:00.000Z',
      erstelltAm: '2026-10-19T10:00:00.000Z',
    })
    return setupView(null, [], { herstellerId: 'h-bestell', bestellnummer: 'B-42' })
  }

  it('verlinkt den Bestell-Button mit der Bestell-E-Mail des Lieferanten', async () => {
    const { w } = await setupMitBestellkontakt({
      bestellEmail: 'order@example.com',
      bestellWebseite: 'https://shop.example.com',
    })

    const link = w.get('[data-testid="artikel-detail-bestellen"]').element as HTMLAnchorElement
    expect(link.textContent).toContain('Bestellen')
    expect(link.getAttribute('href')).toContain('mailto:order@example.com')
    expect(link.getAttribute('href')).toContain('Bestellung%3A%20Schraube%20M6')
    expect(link.getAttribute('href')).toContain('B-42')

    w.unmount()
  })

  it('nutzt die Lieferanten-Website, wenn keine Bestell-E-Mail gepflegt ist', async () => {
    const { w } = await setupMitBestellkontakt({
      bestellEmail: null,
      bestellWebseite: 'shop.example.com',
    })

    const link = w.get('[data-testid="artikel-detail-bestellen"]').element as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://shop.example.com')
    expect(link.getAttribute('target')).toBe('_blank')

    w.unmount()
  })

  it('blendet den Bestell-Button ohne Bestellkontakt aus', async () => {
    const { w } = await setupMitBestellkontakt({
      bestellEmail: null,
      bestellWebseite: null,
    })

    expect(w.find('[data-testid="artikel-detail-bestellen"]').exists()).toBe(false)

    w.unmount()
  })
})

describe('ArtikelDetailView — Einkaufspreis aus dem Lieferantenrabatt', () => {
  beforeEach(() => {
    sessionSchreiben({
      userId: 'u1',
      email: 'admin@example.com',
      rolle: 'admin',
      anzeigename: 'Admin',
      loginAm: '2026-10-19T10:00:00.000Z',
      mustChangePassword: false,
      jwtExpiresAt: '2026-10-20T10:00:00.000Z',
    })
  })

  afterEach(() => {
    sessionSchreiben(null)
  })

  async function setupMitLieferant(rabattsatz: number) {
    await getDb().hersteller.add({
      id: 'h-1',
      name: 'Muster GmbH',
      bestellEmail: null,
      bestellWebseite: null,
      rabattsatz,
      geaendertAm: '2026-10-19T10:00:00.000Z',
      erstelltAm: '2026-10-19T10:00:00.000Z',
    })
    return setupView(null, [], { herstellerId: 'h-1', listenpreis: 10000 })
  }

  it('erzeugt den Einkaufspreis aus Listenpreis und Rabattsatz', async () => {
    const { w } = await setupMitLieferant(20)

    await w.get('[data-testid="artikel-detail-bearbeiten"]').trigger('click')
    await flushPromises()

    // Listenpreis im Formular (Euro) aendern -> EK folgt automatisch.
    await setzeWert(eingabeFuer(w, 'Listenpreis'), '200')
    await flushPromises()

    const ekFeld = w.get('[data-testid="artikel-detail-einkaufspreis"]')
    expect((ekFeld.element as HTMLInputElement).value).toBe('160')
    expect(w.text()).toContain('20 %')

    w.unmount()
  })

  it('lässt den Einkaufspreis unberührt, wenn kein Rabatt hinterlegt ist', async () => {
    const { w } = await setupMitLieferant(0)

    await w.get('[data-testid="artikel-detail-bearbeiten"]').trigger('click')
    await flushPromises()

    await setzeWert(eingabeFuer(w, 'Listenpreis'), '200')
    await flushPromises()

    const ekFeld = w.get('[data-testid="artikel-detail-einkaufspreis"]')
    expect((ekFeld.element as HTMLInputElement).value).toBe('')

    w.unmount()
  })
})
