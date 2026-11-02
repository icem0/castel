// Tests der KommissionKameraScan-Komponente.
//
// Die OCR-Engine wird gemockt (kein echtes tesseract.js im Test).
// Erwartetes Verhalten:
//   - Die Kamera startet auf Knopfdruck.
//   - „Bestaetigen" liest genau das markierte Feld aus (Crop wird korrekt
//     auf die Video-Pixel umgerechnet).
//   - Ein Treffer in der bestehenden Liste wird uebernommen, ohne eine
//     neue Kommission anzulegen.
//   - Bei einem Fehlschlag wird nachgefragt, ob eine neue Kommission
//     angelegt werden soll.
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
  ensureWorker: vi.fn(),
}))

vi.mock('../../composables/useKommissionOcr', async () => {
  const { ref } = await import('vue')
  return {
    useKommissionOcr: () => ({
      status: ref('ready'),
      fehler: ref(null),
      scan: mocks.scan,
      stop: mocks.stop,
      ensureWorker: mocks.ensureWorker,
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

/** Kamera-Stub: liefert ein 1280x720-Bild und ein 640x360-Container-Fenster. */
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
  // jsdom liefert fuer videoWidth/videoHeight eigene Getter — deshalb
  // auf HTMLVideoElement.prototype ueberschreiben.
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
    get: () => 1280,
    configurable: true,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
    get: () => 720,
    configurable: true,
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    get: () => 4,
    configurable: true,
  })
  Element.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 640,
      bottom: 360,
      width: 640,
      height: 360,
      toJSON: () => ({}),
    }) as DOMRect
}

function mountKamera() {
  return mount(KommissionKameraScan, {
    props: { modelValue: '' },
    global: { plugins: [pinia, i18n] },
  })
}

async function scanne(w: ReturnType<typeof mountKamera>): Promise<void> {
  await w.find('.kamera-start button').trigger('click')
  await flushPromises()
  await w.find('.scan-btn').trigger('click')
  await flushPromises()
}

function ocrErgebnis(wert: string, keyword = 'Projektnummer') {
  const kontext = `${keyword}: ${wert}`
  return {
    text: kontext,
    kandidaten: [{ wert, keyword, kontext, quelle: 'label' as const }],
    beste: { wert, keyword, kontext, quelle: 'label' as const },
  }
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
    mocks.ensureWorker.mockReset()
    mocks.ensureWorker.mockResolvedValue(undefined)
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

  it('zeigt einen breiten Scan-Streifen (eine Zeile mit rund zehn Ziffern)', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()

    const style = w.find('.crop-overlay').attributes('style') ?? ''
    const prozent = (name: string): number => {
      const treffer = style.match(new RegExp(`${name}:\\s*([\\d.]+)%`))
      return treffer ? Number(treffer[1]) : Number.NaN
    }

    const breite = prozent('width')
    const hoehe = prozent('height')
    expect(breite).toBeGreaterThan(80)
    // Ein Streifen fuer eine Zeile Ziffern: deutlich breiter als hoch.
    expect(breite / hoehe).toBeGreaterThan(5)
    settings.stop()
  })

  it('liest genau das markierte Feld aus (Crop auf Video-Pixel umgerechnet)', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue(ocrErgebnis('AA 1234'))

    const w = mountKamera()
    await flushPromises()
    await scanne(w)

    expect(mocks.scan).toHaveBeenCalledTimes(1)
    const ausschnitt = mocks.scan.mock.calls[0]?.[1] as {
      x: number
      y: number
      width: number
      height: number
    }
    // Container 640x360, Video 1280x720 (gleiches Seitenverhaeltnis) —
    // der Streifen muss 1:1 auf die Video-Pixel abbilden.
    expect(ausschnitt.x).toBeCloseTo(0.04, 2)
    expect(ausschnitt.y).toBeCloseTo(0.43, 2)
    expect(ausschnitt.width).toBeCloseTo(0.92, 2)
    expect(ausschnitt.height).toBeCloseTo(0.14, 2)
    settings.stop()
  })

  it('uebernimmt eine bestehende Kommission, ohne neu anzulegen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['AA 1234'])
    await warteAufStore()

    mocks.scan.mockResolvedValue(ocrErgebnis('AA 1234'))

    const w = mountKamera()
    await flushPromises()
    await scanne(w)

    expect((w.find('.nummer-feld input').element as HTMLInputElement).value).toBe('AA 1234')
    expect(w.text()).toContain('Bestehende Kommission: AA 1234')

    await w.find('.ergebnis-karte .primary').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 1234'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['AA 1234'])
    settings.stop()
  })

  it('fragt nach, wenn keine bestehende Kommission passt, und legt sie an', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue(ocrErgebnis('AA 9876'))

    const w = mountKamera()
    await flushPromises()
    await scanne(w)

    // Es wird gefragt — es wird NICHT automatisch angelegt.
    expect(w.text()).toContain('Keine bestehende Kommission zu „AA 9876“ gefunden')
    expect(settings.settings.kommissionen).toEqual([])

    await w.find('.ergebnis-karte .primary').trigger('click')
    await warteAufStore()

    expect(settings.settings.kommissionen).toEqual(['AA 9876'])
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['AA 9876'])
    settings.stop()
  })

  it('erlaubt das Verwerfen des Ergebnisses', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue(ocrErgebnis('AA 9876'))

    const w = mountKamera()
    await flushPromises()
    await scanne(w)

    await w.find('.ergebnis-karte .btn').trigger('click')
    await flushPromises()

    expect(w.find('.scan-ergebnis').exists()).toBe(false)
    expect(settings.settings.kommissionen).toEqual([])
    expect(w.emitted('update:modelValue')).toBeUndefined()
    settings.stop()
  })

  it('erlaubt das Korrigieren der Nummer vor dem Uebernehmen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scan.mockResolvedValue(ocrErgebnis('AA 98?6'))

    const w = mountKamera()
    await flushPromises()
    await scanne(w)

    await w.find('.nummer-feld input').setValue('AA 9876')
    await w.find('.ergebnis-karte .primary').trigger('click')
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
    await scanne(w)

    expect(w.find('.fehler').text()).toContain('OCR kaputt')
    settings.stop()
  })
})
