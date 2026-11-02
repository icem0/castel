// Tests der KommissionKameraScan-Komponente.
//
// Die OCR-Engine wird gemockt (kein echtes tesseract.js im Test).
// Erwartetes Verhalten:
//   - Die Kamera startet auf Knopfdruck.
//   - Der Ablauf ist zweistufig: erst "Bild aufnehmen", dann "Auswerten".
//     Die OCR laeuft erst beim Auswerten — und genau auf dem aufgenommenen
//     Bild.
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
import { MIN_OCR_HOEHE, berechneOcrSkalierung } from '../../domain/kommission-ocr'
import { i18n } from '../../i18n'

const mocks = vi.hoisted(() => ({
  scanBild: vi.fn(),
  stop: vi.fn(),
  ensureWorker: vi.fn(),
}))

vi.mock('../../composables/useKommissionOcr', async () => {
  const { ref } = await import('vue')
  return {
    useKommissionOcr: () => ({
      status: ref('ready'),
      fehler: ref(null),
      scanBild: mocks.scanBild,
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
  Element.prototype.getBoundingClientRect = function (this: Element) {
    // WICHTIG: Das Kamera-Fenster (.video-wrap) ist 640x360, der
    // Komponenten-Root dagegen 640x600 (Aktionsleiste, Bildvorschau,
    // Ergebnispanel). Der Scan-Rahmen ist relativ zum Kamera-Fenster
    // positioniert — der Crop MUSS daher auch relativ zum Kamera-Fenster
    // berechnet werden. Mit dem Root als Bezug landet der Ausschnitt an
    // einer voellig anderen Stelle und die OCR liest ins Leere.
    const istFenster = this.classList.contains('video-wrap')
    const hoehe = istFenster ? 360 : 600
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 640,
      bottom: hoehe,
      width: 640,
      height: hoehe,
      toJSON: () => ({}),
    } as DOMRect
  }
  // Canvas wird fuer die Aufnahme gebraucht (jsdom hat kein 2D-Canvas).
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
    drawImage: vi.fn(),
  }) as unknown as HTMLCanvasElement['getContext']
  HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/png;base64,AAA')
}

function mountKamera() {
  return mount(KommissionKameraScan, {
    props: { modelValue: '' },
    global: { plugins: [pinia, i18n] },
  })
}

async function nimmAuf(w: ReturnType<typeof mountKamera>): Promise<void> {
  await w.find('.kamera-start button').trigger('click')
  await flushPromises()
  await w.find('.scan-aktionen .btn').trigger('click')
  await flushPromises()
}

async function werteAus(w: ReturnType<typeof mountKamera>): Promise<void> {
  await w.find('.scan-aktionen .primary').trigger('click')
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
    mocks.scanBild.mockReset()
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

  it('haelt die Aktionsleiste ausserhalb des Kamera-Fensters (sonst wird sie abgeschnitten)', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    const w = mountKamera()
    await flushPromises()
    await w.find('.kamera-start button').trigger('click')
    await flushPromises()

    // Das Kamera-Fenster hat overflow:hidden — Buttons darin waeren
    // unsichtbar. Die Leiste muss ausserhalb liegen.
    expect(w.find('.video-wrap .scan-aktionen').exists()).toBe(false)
    expect(w.find('.scan-aktionen .btn').exists()).toBe(true)
    expect(w.find('.scan-aktionen .primary').exists()).toBe(true)
    settings.stop()
  })

  it('fuehrt die OCR erst nach "Auswerten" aus — nicht schon beim Aufnehmen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 1234'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)

    // Aufgenommen, aber noch nicht ausgewertet.
    expect(mocks.scanBild).not.toHaveBeenCalled()
    expect(w.find('.aufnahme img').exists()).toBe(true)
    expect(w.find('.scan-ergebnis').exists()).toBe(false)

    await werteAus(w)
    expect(mocks.scanBild).toHaveBeenCalledTimes(1)
    settings.stop()
  })

  it('wertet genau das aufgenommene Bild aus', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await warteAufStore()

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 1234'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

    const bild = mocks.scanBild.mock.calls[0]?.[0] as HTMLCanvasElement
    expect(bild).toBeInstanceOf(HTMLCanvasElement)
    // Container 640x360, Video 1280x720 (gleiches Seitenverhaeltnis) —
    // der Streifen muss 1:1 auf die Video-Pixel abbilden …
    const breite = Math.round(1280 * 0.92)
    const hoehe = Math.round(720 * 0.14)
    // … und wird anschliessend hochskaliert, damit tesseract ihn liest.
    const skala = berechneOcrSkalierung(breite, hoehe)
    expect(bild.width).toBe(Math.round(breite * skala))
    expect(bild.height).toBe(Math.round(hoehe * skala))
    expect(bild.height).toBeGreaterThanOrEqual(MIN_OCR_HOEHE)
    settings.stop()
  })

  it('uebernimmt eine bestehende Kommission, ohne neu anzulegen', async () => {
    const settings = useSettingsStore(pinia)
    settings.start()
    await settings.setKommissionen(['AA 1234'])
    await warteAufStore()

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 1234'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

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

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 9876'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

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

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 9876'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

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

    mocks.scanBild.mockResolvedValue(ocrErgebnis('AA 98?6'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

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

    mocks.scanBild.mockRejectedValue(new Error('OCR kaputt'))

    const w = mountKamera()
    await flushPromises()
    await nimmAuf(w)
    await werteAus(w)

    expect(w.find('.fehler').text()).toContain('OCR kaputt')
    settings.stop()
  })
})
