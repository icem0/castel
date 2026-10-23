// Tests für die Katalog-Übernahme ins Artikelformular.
//
// Wenn der User unter Einstellungen → Artikelkataloge einen Eintrag in die
// Artikelliste übernimmt, landen die Felder als Query-Params auf /artikel/neu.
// Das Formular muss sie vorbefüllen und — falls der Barcode schon im
// Bestand existiert — davor warnen. Sonst legt der User bei jedem zweiten
// Katalogdurchlauf DoppeltArtikel an.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import type { Artikel } from '../../db/types'
import ArtikelFormView from '../ArtikelFormView.vue'
import de from '../../locales/de-DE'
import { useArtikelStore } from '../../stores/artikel'

const route = { query: {} as Record<string, string> }
const push = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push }),
  RouterLink: { props: ['to'], template: '<a><slot /></a>' },
}))

/** The drawer is covered by its own test suite. */
vi.mock('../../components/HerstellerKatalogDrawer.vue', () => ({
  default: { props: ['offen', 'aktuell'], template: '<div />' },
}))

function artikel(id: string, titel: string, barcode: string | null): Artikel {
  return {
    id,
    titel,
    barcode,
    typ: '',
    status: 'verfuegbar',
    sharePointId: null,
    lieferant: null,
    verpackungseinheit: 1,
    mindestbestand: null,
    nachbestellHinweis: null,
    bestellnummer: null,
    etikettenNeu: false,
    listenpreis: null,
    einkaufspreis: null,
    geaendertAm: '2026-01-01T00:00:00.000Z',
    erstelltAm: '2026-01-01T00:00:00.000Z',
  }
}

function setup(vorhandeneArtikel: Artikel[] = []) {
  setActivePinia(createPinia())
  const artikelStore = useArtikelStore()
  artikelStore.artikel = vorhandeneArtikel

  const i18n = createI18n({ legacy: false, locale: 'de', messages: { de } })
  const wrapper = mount(ArtikelFormView, { global: { plugins: [i18n] } })
  return { wrapper }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of Object.keys(route.query)) delete route.query[key]
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ArtikelFormView — Katalog-Prefill', () => {
  it('füllt Titel, Barcode, Bestellnummer, Lieferant und Preis aus den Query-Params', async () => {
    route.query = {
      katTitel: 'Bleistift HB',
      katEan: '4006381333931',
      katMatchcode: 'ART-1001',
      katPreis: '2.49',
      katLieferant: 'Mueller GmbH',
    }
    const { wrapper } = setup()
    await flushPromises()

    const werte = wrapper.findAll('input').map((i) => i.element as HTMLInputElement)
    expect(werte.some((i) => i.value === 'Bleistift HB')).toBe(true)
    expect(werte.some((i) => i.value === '4006381333931')).toBe(true)
    expect(werte.some((i) => i.value === 'ART-1001')).toBe(true)
    expect(werte.some((i) => i.value === 'Mueller GmbH')).toBe(true)
    expect(werte.some((i) => i.type === 'number' && i.value === '2.49')).toBe(true)
  })

  it('warnt, wenn der Barcode schon zu einem Artikel gehört', async () => {
    route.query = { katTitel: 'Bleistift HB', katEan: '4006381333931' }
    const { wrapper } = setup([artikel('a1', 'Bleistift HB (bereits erfasst)', '4006381333931')])
    await flushPromises()

    expect(wrapper.text()).toContain('Bleistift HB (bereits erfasst)')
    expect(wrapper.text()).toContain('Zum vorhandenen Artikel')
  })

  it('warnt nicht, wenn der Barcode neu ist', async () => {
    route.query = { katTitel: 'Bleistift HB', katEan: '4006381333931' }
    const { wrapper } = setup([artikel('a1', 'Anderer Artikel', '1111111111111')])
    await flushPromises()

    expect(wrapper.text()).not.toContain('Zum vorhandenen Artikel')
  })

  it('ignoriert einen leeren Preis', async () => {
    route.query = { katTitel: 'Bleistift HB', katEan: '', katPreis: '' }
    const { wrapper } = setup()
    await flushPromises()

    // listenpreis bleibt null → das Nummernfeld zeigt keinen Wert.
    const preis = wrapper
      .findAll('input[type="number"]')
      .map((i) => (i.element as HTMLInputElement).value)
    expect(preis).toContain('')
  })

  it('verändert ohne Katalog-Params nichts', async () => {
    const { wrapper } = setup()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Zum vorhandenen Artikel')
    const titel = wrapper.findAll('input').find((i) => (i.element as HTMLInputElement).value === '')
    expect(titel).toBeDefined()
  })
})
