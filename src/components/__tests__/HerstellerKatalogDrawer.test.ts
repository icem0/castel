// Tests for the supplier catalogue drawer.
//
// The drawer is the piece where a bad interaction is expensive: it writes
// values into the article form. These tests cover the parts that must never
// be wrong — what gets copied, what does not, and that the supplier step
// actually gates the search.
//
// Note: the drawer renders through <Teleport to="body">, so queries go
// through document.body rather than the wrapper.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import de from '../../locales/de-DE'
import HerstellerKatalogDrawer from '../HerstellerKatalogDrawer.vue'
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
  { id: 'l1', name: 'Mueller GmbH', matchcode: 'MUE', aktiv: true, ort: null, geaendertAm: '' },
  { id: 'l2', name: 'Sanitaer Meier', matchcode: 'MEI', aktiv: true, ort: null, geaendertAm: '' },
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

const AKTUELL = {
  titel: '',
  barcode: '',
  bestellnummer: '',
  lieferant: '',
  listenpreis: null,
  verpackungseinheit: 1,
}

function setup(props: Record<string, unknown> = {}) {
  const i18n = createI18n({ legacy: false, locale: 'de', messages: { 'de-DE': de, de } })
  const wrapper = mount(HerstellerKatalogDrawer, {
    props: { offen: true, aktuell: AKTUELL, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  const body = document.body

  const knopf = (text: string) =>
    Array.from(body.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').trim().startsWith(text),
    ) as HTMLButtonElement | undefined

  /** Picks a supplier and enters a search term, the way a user would. */
  async function waehleUndSuche(lieferantId: string, begriff: string) {
    const select = body.querySelector('select') as HTMLSelectElement
    select.value = lieferantId
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    const input = body.querySelector('input[type="search"]') as HTMLInputElement
    input.value = begriff
    input.dispatchEvent(new Event('input'))
    await flushPromises()
  }

  return {
    wrapper,
    body,
    knopf,
    waehleUndSuche,
    text: () => body.textContent ?? '',
  }
}

let mounted: ReturnType<typeof setup> | null = null

function start(props: Record<string, unknown> = {}) {
  mounted = setup(props)
  return mounted
}

beforeEach(() => {
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

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  document.body.innerHTML = ''
})

describe('HerstellerKatalogDrawer', () => {
  it('lädt die Lieferantenliste beim Öffnen', async () => {
    const w = start()
    await flushPromises()
    expect(lookup.ladeLieferanten).toHaveBeenCalled()
    const optionen = Array.from(w.body.querySelectorAll('option')).map((o) => o.textContent)
    expect(optionen.some((t) => t?.includes('Mueller GmbH'))).toBe(true)
  })

  it('sucht erst nach Auswahl eines Lieferanten', async () => {
    const w = start()
    await flushPromises()

    // Ohne Lieferant ist der Suchknopf deaktiviert.
    expect(w.knopf('Suchen')?.disabled).toBe(true)

    await w.waehleUndSuche('l1', '')
    expect(w.knopf('Suchen')?.disabled).toBe(false)
  })

  it('übernimmt Titel, EAN, Bestellnummer und Preis aus dem Treffer', async () => {
    const w = start()
    await flushPromises()
    await w.waehleUndSuche('l1', 'Bleistift')
    w.knopf('Suchen')?.click()
    await flushPromises()

    const knopf = w.knopf('Übernehmen')
    expect(knopf).toBeDefined()
    knopf?.click()
    await flushPromises()

    const payload = w.wrapper.emitted('uebernehmen')?.[0]?.[0] as Record<string, unknown>
    expect(payload).toMatchObject({
      titel: 'Bleistift HB',
      barcode: '4006381333931',
      bestellnummer: 'ART-1001',
      listenpreis: 2.49,
      lieferant: 'Mueller GmbH',
    })
    expect(w.wrapper.emitted('schliessen')).toBeTruthy()
  })

  it('übernimmt nur das einzelne Feld, wenn auf den Feld-Link geklickt wird', async () => {
    const w = start({ aktuell: { ...AKTUELL, titel: 'Eigener Titel' } })
    await flushPromises()
    await w.waehleUndSuche('l1', '')
    w.knopf('Suchen')?.click()
    await flushPromises()

    const einzel = w.knopf('Nur dieses Feld übernehmen')
    expect(einzel).toBeDefined()
    einzel?.click()
    await flushPromises()

    const payload = w.wrapper.emitted('uebernehmen')?.[0]?.[0] as Record<string, unknown>
    expect(Object.keys(payload)).toHaveLength(1)
    // Der Drawer bleibt offen, damit mehrere Felder nacheinander möglich sind.
    expect(w.wrapper.emitted('schliessen')).toBeFalsy()
  })

  it('listet nur Felder auf, die sich tatsächlich ändern', async () => {
    const w = start({ aktuell: { ...AKTUELL, titel: 'Bleistift HB' } })
    await flushPromises()
    await w.waehleUndSuche('l1', '')
    w.knopf('Suchen')?.click()
    await flushPromises()

    // Der Titel stimmt bereits — er darf nicht in der Diff-Liste stehen.
    const diffLabels = Array.from(w.body.querySelectorAll('.diff-label')).map((e) =>
      e.textContent?.trim(),
    )
    expect(diffLabels).not.toContain('Titel')
    expect(diffLabels).toContain('Barcode')
  })

  it('markiert zurückgezogene Artikel sichtbar', async () => {
    vi.mocked(lookup.sucheHerstellerArtikel).mockResolvedValue({
      lieferant: { id: 'l1', name: 'Mueller GmbH' },
      suchstrategie: 'titel',
      treffer: [
        {
          ...TREFFER,
          id: 'a2',
          matchcode: 'ART-OLD',
          titel: 'Altes Produkt',
          deaktiviert: true,
          deaktiviertAm: '2026-01-15T00:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      hasMore: false,
    })
    const w = start()
    await flushPromises()
    await w.waehleUndSuche('l1', 'Altes')
    w.knopf('Suchen')?.click()
    await flushPromises()

    expect(w.text()).toContain('Nicht mehr lieferbar')
  })

  it('schließt bei Escape', async () => {
    const w = start()
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.wrapper.emitted('schliessen')).toBeTruthy()
  })

  it('meldet den Offline-Fall freundlich statt zu crashen', async () => {
    vi.mocked(lookup.ladeLieferanten).mockRejectedValue(new Error('Failed to fetch'))
    const w = start()
    await flushPromises()
    expect(w.text()).toContain('Keine Verbindung zum Server')
  })

  it('schliesst den Drawer bei Wisch nach rechts über dem Schwellenwert', async () => {
    const w = start()
    await flushPromises()
    const vm = w.wrapper.vm as { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: () => void }
    const startX = 100
    const preventDefault = vi.fn()
    vm.onTouchStart({
      touches: [{ clientX: startX, clientY: 200 }],
    } as unknown as TouchEvent)
    vm.onTouchMove({
      touches: [{ clientX: startX + 100, clientY: 200 }],
      preventDefault,
    } as unknown as TouchEvent)
    vm.onTouchEnd()
    await flushPromises()
    expect(preventDefault).toHaveBeenCalled()
    expect(w.wrapper.emitted('schliessen')).toBeTruthy()
  })

  it('schliesst den Drawer nicht bei Wisch nach links oder unter dem Schwellenwert', async () => {
    const w = start()
    await flushPromises()
    const vm = w.wrapper.vm as { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: () => void }
    const startX = 200
    vm.onTouchStart({
      touches: [{ clientX: startX, clientY: 200 }],
    } as unknown as TouchEvent)
    vm.onTouchMove({
      touches: [{ clientX: startX - 100, clientY: 200 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent)
    vm.onTouchEnd()
    await flushPromises()
    expect(w.wrapper.emitted('schliessen')).toBeFalsy()
  })

  it('verhindert Default-Verhalten beim horizontalen Wisch (kein Browser-Back)', async () => {
    const w = start()
    await flushPromises()
    const vm = w.wrapper.vm as { onTouchStart: (e: TouchEvent) => void; onTouchMove: (e: TouchEvent) => void; onTouchEnd: () => void }
    const preventDefault = vi.fn()
    vm.onTouchStart({
      touches: [{ clientX: 50, clientY: 200 }],
    } as unknown as TouchEvent)
    vm.onTouchMove({
      touches: [{ clientX: 200, clientY: 200 }],
      preventDefault,
    } as unknown as TouchEvent)
    expect(preventDefault).toHaveBeenCalled()
  })
})
