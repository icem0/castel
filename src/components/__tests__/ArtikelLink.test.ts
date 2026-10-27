// Tests for the shared article link component used wherever an article title
// is listed (booking list, minimum-stock panel, label sheets).
//
// Expectations:
//   - A resolvable article renders as a router link to the detail view.
//   - An unresolvable article renders plain fallback text (never a broken link).
//   - An explicitly passed title wins over the store lookup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import ArtikelLink from '../ArtikelLink.vue'
import { useArtikelStore } from '../../stores/artikel'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'

let pinia: Pinia

function routerMit() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/artikel/:id', component: { template: '<div />' } }],
  })
  return router
}

/** The store fills itself through a Dexie liveQuery — give it one tick. */
async function warteAufStore() {
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 50))
  await flushPromises()
}

describe('ArtikelLink', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
    useArtikelStore(pinia).start()
  })

  afterEach(async () => {
    useArtikelStore(pinia).stop()
    await clearLocalDbForTests()
  })

  it('verlinkt den Titel auf die Artikel-Detailansicht', async () => {
    const router = routerMit()
    await router.push('/artikel/a1')
    await router.isReady()
    const a = await useArtikelStore(pinia).anlegen({
      titel: 'Schraube M6',
      typ: 'Material',
      barcode: '4006381333931',
    })
    await warteAufStore()

    const w = mount(ArtikelLink, {
      props: { artikelId: a.id },
      global: { plugins: [pinia, router] },
    })
    await flushPromises()

    const link = w.get('a')
    expect(link.text()).toBe('Schraube M6')
    expect(link.attributes('href')).toBe(`/artikel/${a.id}`)
  })

  it('zeigt Fallback-Text statt eines kaputten Links, wenn der Artikel fehlt', async () => {
    const router = routerMit()
    const w = mount(ArtikelLink, {
      props: { artikelId: 'unbekannt', fallback: '…' },
      global: { plugins: [pinia, router] },
    })

    expect(w.find('a').exists()).toBe(false)
    expect(w.text()).toBe('…')
  })

  it('nutzt einen explizit uebergebenen Titel', async () => {
    const router = routerMit()
    await router.push('/artikel/a1')
    await router.isReady()
    const a = await useArtikelStore(pinia).anlegen({
      titel: 'Dübel',
      typ: 'Material',
      barcode: '12345678',
    })
    await warteAufStore()

    const w = mount(ArtikelLink, {
      props: { artikelId: a.id, titel: 'Dübel 8mm' },
      global: { plugins: [pinia, router] },
    })
    await flushPromises()

    expect(w.get('a').text()).toBe('Dübel 8mm')
  })
})
