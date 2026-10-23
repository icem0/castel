import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArtikelDetailView from '../ArtikelDetailView.vue'
import { i18n } from '../../i18n'
import { useArtikelStore } from '../../stores/artikel'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'

let pinia: Pinia

beforeEach(async () => {
  resetDbForTests()
  await clearLocalDbForTests()
  pinia = createPinia()
  setActivePinia(pinia)
  i18n.global.locale.value = 'de-DE'
})

afterEach(async () => {
  await clearLocalDbForTests()
})

async function setupView(barcode: string | null) {
  const store = useArtikelStore(pinia)
  const artikel = await store.anlegen({ titel: 'Schraube M6', typ: 'Material', barcode })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/artikel/:id', component: { template: '<div />' } }],
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
  return { w, artikel }
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
