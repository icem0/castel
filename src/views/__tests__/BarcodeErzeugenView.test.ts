// Tests der Etiketten-Ansicht (Serien-Etiketten, DIN A4).
//
// Erwartetes Verhalten:
//   - Die Artikelliste nutzt dieselben Filter wie die Artikel-Uebersicht
//     (Suche/Typ/Status/Standort) plus den Filter "Nur neue Artikel".
//   - Artikel ohne Barcode sind nicht auswaehlbar.
//   - "Alle sichtbaren auswaehlen" markiert genau die sichtbaren Artikel
//     mit Barcode.
//   - Die beiden Tag-Buttons setzen/loeschen den Marker "neu" an allen
//     Artikeln (ueber den Store -> Outbox -> Sync).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import BarcodeErzeugenView from '../BarcodeErzeugenView.vue'
import { i18n } from '../../i18n'
import { useArtikelStore } from '../../stores/artikel'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'

let pinia: Pinia

function artikelAnlegen(titel: string, barcode: string | null) {
  return useArtikelStore(pinia).anlegen({ titel, typ: 'Material', barcode })
}

async function setupView() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/etiketten', component: { template: '<div />' } }],
  })
  await router.push('/etiketten')
  await router.isReady()
  const w = mount(BarcodeErzeugenView, {
    global: { plugins: [pinia, i18n, router] },
  })
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 50))
  await flushPromises()
  return { w }
}

function buttonMitText(w: ReturnType<typeof mount>, text: string) {
  return w.findAll('button').find((b) => b.text().includes(text))
}

describe('BarcodeErzeugenView — Serien-Etiketten', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'de-DE'
  })

  afterEach(async () => {
    await clearLocalDbForTests()
    vi.restoreAllMocks()
  })

  it('zeigt die Artikel mit "neu"-Badge und waehlt alle sichtbaren aus', async () => {
    await artikelAnlegen('Schraube M6', '4006381333931')
    await artikelAnlegen('Dübel', '12345678')
    const { w } = await setupView()

    const zeilen = w.findAll('tbody tr')
    expect(zeilen).toHaveLength(2)
    expect(w.findAll('.badge-neu')).toHaveLength(2)

    await buttonMitText(w, 'Alle sichtbaren auswählen')!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('2 Etiketten ausgewählt')
  })

  it('laesst Artikel ohne Barcode nicht auswaehlen', async () => {
    await artikelAnlegen('Mit Barcode', '4006381333931')
    await artikelAnlegen('Ohne Barcode', null)
    const { w } = await setupView()

    const checkboxen = w.findAll('tbody input[type="checkbox"]')
    expect(checkboxen).toHaveLength(2)
    expect((checkboxen[0]!.element as HTMLInputElement).disabled).toBe(false)
    expect((checkboxen[1]!.element as HTMLInputElement).disabled).toBe(true)

    await buttonMitText(w, 'Alle sichtbaren auswählen')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('1 Etiketten ausgewählt')
    expect(w.text()).toContain('1 Artikel ohne Barcode')
  })

  it('filtert mit "Nur neue Artikel"', async () => {
    const store = useArtikelStore(pinia)
    const a = await store.anlegen({ titel: 'Neu', typ: 'Material', barcode: '111' })
    await store.anlegen({ titel: 'Alt', typ: 'Material', barcode: '222' })
    await store.markiereEtikettenNeu([a.id], false)

    const { w } = await setupView()
    // Standard: nur "neue" Artikel
    expect(w.findAll('tbody tr')).toHaveLength(1)
    expect(w.text()).toContain('Neu')

    // Filter abschalten -> alle Artikel
    const nurNeu = w
      .findAll('input[type="checkbox"]')
      .find((c) =>
        (c.element as HTMLInputElement).closest('label')?.textContent?.includes('Nur neue'),
      )
    await nurNeu!.setValue(false)
    await flushPromises()
    expect(w.findAll('tbody tr')).toHaveLength(2)
  })

  it('loescht und setzt die "neu"-Tags ueber den Store', async () => {
    const store = useArtikelStore(pinia)
    const a = await store.anlegen({ titel: 'Artikel', typ: 'Material', barcode: '111' })
    const spy = vi.spyOn(store, 'markiereEtikettenNeu').mockResolvedValue(1)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const { w } = await setupView()

    await buttonMitText(w, 'Tags löschen')!.trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith([a.id], false)

    await buttonMitText(w, 'als „neu" markieren')!.trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith([a.id], true)
  })
})
