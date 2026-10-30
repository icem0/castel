// Tests der KommissionKameraScan-Komponente.
//
// Die OCR-Engine wird gemockt (kein echtes tesseract.js im Test).
// Erwartetes Verhalten:
//   - Die Kamera startet auf Knopfdruck.
//   - Das erkannte Ergebnis landet im korrigierbaren Nummernfeld.
//   - Ein Treffer in der bestehenden Liste wird uebernommen, ohne eine
//     neue Kommission anzulegen.
//   - Eine unbekannte Nummer legt eine neue Kommission an.
//   - Die Nummer kann vor dem Uebernehmen korrigiert werden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import KommissionKameraScan from '../KommissionKameraScan.vue'
import { useSettingsStore } from '../../stores/settings'
import { resetDbForTests } from '../../db/database'
import { clearLocalDbForTests } from '../../services/sync/reset-local-db'
import { sessionSchreiben } from '../../auth/session'
import { jetztIso } from '../../domain/ids'
import { i18n } from '../../i18n'

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('../../composables/useKommissionOcr', async () => {
  const { ref } = await import('vue')
  return {
    useKommissionOcr: () => ({
      status: ref('ready'),
      fehler: ref(null),
      scan: mocks.scan,
      stop: mocks.stop,
    }),
  }
})

let pinia: Pinia

function session(rolle: 'admin' | 'user'): void {
  sessionSchreiben({
    userId: 'user-1',
    email: 'user@example.com',
    rolle,
    anzeigename: 'Test User',
    loginAm: jetztIso(),
    mustChangePassword: false,
    jwtExpiresAt: jetztIso(),
  })
}

async function warteAufStore(): Promise<void> {
  await flushPromises()
  await new Promise<void>((r) => setTimeout(r, 60))
  await flushPromises()
}

function kameraMock(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [],
      }),
    },
    configurable: true,
  })
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined)
}

function mountKamera() {
  return mount(KommissionKameraScan, {
    props: { modelValue: '' },
    global: { plugins: [pinia, i18n] },
  })
}

describe('KommissionKameraScan', () => {
  beforeEach(async () => {
    resetDbForTests()
    await clearLocalDbForTests()
    pinia = createPinia()
    setActivePinia(pinia)
    i18n.global.locale.value = 'de-DE'
    localStorage.removeItem('castel.auth.session')
    session('user')
    kameraMock()
    mocks.scan.mockReset()
    mocks.stop.mockReset()
  })

  afterEach(async () => {
    localStorage.removeItem('castel.auth.session')
    await clearLocalDbForTests()
  })

  it('startet die Kamera auf Knopfdruck', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mountKamera()
    await flushPromises()

    expect(w.find('.kamera-start').exists()).toBe(true)
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled()
    expect(w.find('video').exists()).toBe(true)
    expect(w.find('.crop-overlay').exists()).toBe(true)
    settings.stop()
  })

  it('uebernimmt eine bestehende Kommission, ohne neu anzulegen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['AA 1234'])
    await warteAufStore()

    mocks.scan.mockResolvedValue({
      text: 'Projektnummer: AA 1234',
      kandidaten: [
        {
          wert: 'AA 1234',
          keyword: 'Projektnummer',
          kontext: 'Projektnummer: AA 1234',
          quelle: 'label',
        },
      ],
      beste: {
        wert: 'AA 1234',
        keyword: 'Projektnummer',
        kontext: 'Projektnummer: AA 1234',
        quelle: 'label',
      },
    })

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()
    await w.find('.scan-btn').trigger('click')
    await flushPromises()

    expect((w.find('.nummer-feld input').element as HTMLInputElement).value).toBe('AA 1234')
    expect(w.text()).toContain('Bestehende Kommission: AA 1234')

    await w.find('.scan-ergebnis .primary').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 1234'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['AA 1234'])
    settings.stop()
  })

  it('legt eine unbekannte Nummer als neue Kommission an', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue({
      text: 'Projektnummer: AA 9876',
      kandidaten: [
        {
          wert: 'AA 9876',
          keyword: 'Projektnummer',
          kontext: 'Projektnummer: AA 9876',
          quelle: 'label',
        },
      ],
      beste: {
        wert: 'AA 9876',
        keyword: 'Projektnummer',
        kontext: 'Projektnummer: AA 9876',
        quelle: 'label',
      },
    })

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()
    await w.find('.scan-btn').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Wird als neue Kommission angelegt')

    await w.find('.scan-ergebnis .primary').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 9876'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['AA 9876'])
    settings.stop()
  })

  it('erlaubt das Korrigieren der Nummer vor dem Uebernehmen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue({
      text: 'Projektnummer: AA 98?6',
      kandidaten: [
        {
          wert: 'AA 98?6',
          keyword: 'Projektnummer',
          kontext: 'Projektnummer: AA 98?6',
          quelle: 'label',
        },
      ],
      beste: {
        wert: 'AA 98?6',
        keyword: 'Projektnummer',
        kontext: 'Projektnummer: AA 98?6',
        quelle: 'label',
      },
    })

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()
    await w.find('.scan-btn').trigger('click')
    await flushPromises()

    await w.find('.nummer-feld input').setValue('AA 9876')
    await w.find('.scan-ergebnis .primary').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 9876'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['AA 9876'])
    settings.stop()
  })

  it('meldet einen OCR-Fehler', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockRejectedValue(new Error('OCR kaputt'))

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()
    await w.find('.scan-btn').trigger('click')
    await flushPromises()

    expect(w.find('.fehler').text()).toContain('OCR kaputt')
    settings.stop()
  })
})
