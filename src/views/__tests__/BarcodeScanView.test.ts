// Tests der Barcode-Scan-Ansicht.
//
// Erwartetes Verhalten:
//   - Ein bekannter Code (barcode/bestellnummer/id) springt direkt in die
//     Buchungsmaske.
//   - Ein unbekannter Code oeffnet den Dialog "Code nicht gefunden" mit den
//     zwei Wegen: neuen Artikel anlegen ODER bestehenden Artikel mit dem
//     Barcode versehen (danach Artikelsuche).
//   - "Neuen Artikel anlegen" reicht den Code als route.query.barcode an
//     die Artikel-Form weiter.
//   - "Bestehenden Artikel mit diesem Barcode versehen" schreibt den Code
//     per Store-Update an den gewaehlten Artikel und springt in die
//     Buchungsmaske dieses Artikels.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import BarcodeScanView from '../BarcodeScanView.vue'
import { i18n } from '../../i18n'
import { useArtikelStore } from '../../stores/artikel'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'

const mocks = vi.hoisted(() => ({
  onDetected: null as null | ((code: string, format: string) => void),
  start: vi.fn(async () => {}),
  stop: vi.fn(),
}))

// Kamera im Test abschalten — der Scan-Loop wird ueber die manuelle
// Code-Eingabe ausgeloest.
vi.mock('../../composables/useBarcode', async () => {
  const { ref } = await import('vue')
  return {
    useBarcode: (opts: { onDetected: (code: string, format: string) => void }) => {
      mocks.onDetected = opts.onDetected
      return {
        start: mocks.start,
        stop: mocks.stop,
        aktiv: ref(false),
        fehler: ref(null),
        unterstuetzt: ref(true),
      }
    },
  }
})

let pinia: Pinia

beforeEach(async () => {
  resetDbForTests()
  await clearLocalDbForTests()
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = 'de-DE'
  mocks.start.mockClear()
  mocks.stop.mockClear()
})

afterEach(async () => {
  await clearLocalDbForTests()
  vi.restoreAllMocks()
})

async function setupView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/scan', name: 'scan', component: { template: '<div>scan</div>' } },
      { path: '/artikel/neu', name: 'artikel-neu', component: { template: '<div>neu</div>' } },
      { path: '/buchung/neu', name: 'buchung-neu', component: { template: '<div>buchung</div>' } },
    ],
  })
  await router.push({ name: 'scan' })
  await router.isReady()

  const w = mount(BarcodeScanView, { global: { plugins: [pinia, i18n, router] } })
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 50))
  await flushPromises()
  return { w, router }
}

function buttonMitText(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

/** Code manuell eintippen und den Scan ausloesen. */
async function codeEingeben(w: ReturnType<typeof mount>, code: string) {
  const input = w.find('input[inputmode="text"]')
  await input.setValue(code)
  await w.find('form.manual-form').trigger('submit')
  await flushPromises()
}

describe('BarcodeScanView — Scan-Dialog', () => {
  it('springt bei bekanntem Barcode direkt in die Buchungsmaske', async () => {
    const artikel = await useArtikelStore(pinia).anlegen({
      titel: 'Schraube M6',
      typ: 'Material',
      barcode: '4006381333931',
    })
    const { w, router } = await setupView()

    await codeEingeben(w, '4006381333931')

    expect(router.currentRoute.value.name).toBe('buchung-neu')
    expect(router.currentRoute.value.query.artikelId).toBe(artikel.id)
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('bietet bei unbekanntem Code an: neu anlegen oder bestehenden zuordnen', async () => {
    const { w } = await setupView()

    await codeEingeben(w, '9781234567897')

    const dialog = w.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('9781234567897')
    expect(buttonMitText(w, 'Neuen Artikel mit Barcode anlegen')).toBeTruthy()
    expect(buttonMitText(w, 'Bestehenden Artikel mit diesem Barcode versehen')).toBeTruthy()
    expect(buttonMitText(w, 'Abbrechen')).toBeTruthy()
  })

  it('legt auf "Neuen Artikel anlegen" einen Artikel mit dem Barcode an', async () => {
    const { w, router } = await setupView()

    await codeEingeben(w, '9781234567897')
    await buttonMitText(w, 'Neuen Artikel mit Barcode anlegen')!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.name).toBe('artikel-neu')
    expect(router.currentRoute.value.query.barcode).toBe('9781234567897')
  })

  it('weist den Barcode einem bestehenden Artikel zu und bucht ihn', async () => {
    const artikel = await useArtikelStore(pinia).anlegen({
      titel: 'Dübel',
      typ: 'Material',
    })
    const { w, router } = await setupView()

    await codeEingeben(w, '9781234567897')
    await buttonMitText(w, 'Bestehenden Artikel mit diesem Barcode versehen')!.trigger('click')
    await flushPromises()

    // Artikelsuche: Artikel ueber das Suchfeld auswaehlen.
    const suchfeld = w.find('input[type="search"]')
    expect(suchfeld.exists()).toBe(true)
    await suchfeld.setValue('Dübel')
    await flushPromises()

    const treffer = w.findAll('li[role="option"]').find((li) => li.text().includes('Dübel'))
    expect(treffer).toBeTruthy()
    await treffer!.trigger('mousedown')
    await flushPromises()

    const zuweisen = buttonMitText(w, 'Barcode zuweisen')!
    expect(zuweisen.attributes('disabled')).toBeUndefined()
    await zuweisen.trigger('click')
    await flushPromises()
    await new Promise<void>((r) => setTimeout(r, 50))
    await flushPromises()

    // Barcode liegt jetzt am Artikel.
    const aktualisiert = useArtikelStore(pinia).byId(artikel.id)
    expect(aktualisiert?.barcode).toBe('9781234567897')

    // Und weiter in die Buchungsmaske des Artikels.
    expect(router.currentRoute.value.name).toBe('buchung-neu')
    expect(router.currentRoute.value.query.artikelId).toBe(artikel.id)
  })

  it('warnt, wenn der gewaehlte Artikel schon einen Barcode traegt', async () => {
    const artikel = await useArtikelStore(pinia).anlegen({
      titel: 'Dübel',
      typ: 'Material',
      barcode: '1111111111111',
    })
    const { w } = await setupView()

    await codeEingeben(w, '9781234567897')
    await buttonMitText(w, 'Bestehenden Artikel mit diesem Barcode versehen')!.trigger('click')
    await flushPromises()

    const treffer = w.findAll('li[role="option"]').find((li) => li.text().includes('Dübel'))
    await treffer!.trigger('mousedown')
    await flushPromises()

    expect(w.find('.scan-dialog-warnung').text()).toContain('1111111111111')

    await buttonMitText(w, 'Barcode zuweisen')!.trigger('click')
    await flushPromises()
    await new Promise<void>((r) => setTimeout(r, 50))
    await flushPromises()

    expect(useArtikelStore(pinia).byId(artikel.id)?.barcode).toBe('9781234567897')
  })

  it('bricht mit "Abbrechen" ab, ohne etwas zu aendern', async () => {
    const artikel = await useArtikelStore(pinia).anlegen({
      titel: 'Schraube M6',
      typ: 'Material',
    })
    const { w, router } = await setupView()

    await codeEingeben(w, '9781234567897')
    await buttonMitText(w, 'Abbrechen')!.trigger('click')
    await flushPromises()

    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(router.currentRoute.value.name).toBe('scan')
    expect(useArtikelStore(pinia).byId(artikel.id)?.barcode).toBeNull()
  })

  it('findet einen Artikel auch ueber die Bestellnummer', async () => {
    const artikel = await useArtikelStore(pinia).anlegen({
      titel: 'Schraube M6',
      typ: 'Material',
      bestellnummer: 'ART-42',
    })
    const { w, router } = await setupView()

    await codeEingeben(w, 'ART-42')

    expect(router.currentRoute.value.name).toBe('buchung-neu')
    expect(router.currentRoute.value.query.artikelId).toBe(artikel.id)
  })
})
