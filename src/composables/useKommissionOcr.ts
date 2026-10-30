// useKommissionOcr — OCR-gestütztes Scannen der Kommissionsnummer per Kamera.
//
// Nutzt tesseract.js komplett clientseitig. Ein Videoframe wird auf einen
// vom User markierten Ausschnitt zugeschnitten und per OCR ausgelesen.
// Daraus werden die Kommissionsnummern-Kandidaten extrahiert (siehe
// domain/kommission-ocr.ts) und gegen die bestehenden Kommissionen
// gematcht.
//
// Die OCR-Assets (Worker-Skript, WASM-Core, Sprachdaten) liegen lokal
// unter /tesseract bzw. /tessdata — sie werden von
// scripts/fetch-ocr-assets.mjs bereitgestellt. So funktioniert der
// Scan auch offline (der Service-Worker cacht die Assets runtime).

import { ref } from 'vue'
import { createWorker, type Worker } from 'tesseract.js'
import { extrahiereKommissionsNummer, type OcrKandidat } from '../domain/kommission-ocr'

export type OcrStatus = 'idle' | 'loading' | 'ready' | 'scanning' | 'error'

export interface OcrResult {
  /** Der erkannte Rohtext des Crops. */
  text: string
  /** Extrahierte Kommissionsnummern-Kandidaten (beste zuerst). */
  kandidaten: OcrKandidat[]
  /** Der beste Kandidat. */
  beste: OcrKandidat | null
}

export interface UseKommissionOcrOptions {
  /** tesseract-Sprache (Default: 'eng' — für alphanumere Nummern ausreichend). */
  lang?: string
  /** Pfad zum tesseract Worker-Skript. */
  workerPath?: string
  /** Pfad zum tesseract WASM-Core (Verzeichnis oder einzelne Datei). */
  corePath?: string
  /** Pfad zu den traineddata-Dateien. */
  langPath?: string
  /** Logger für tesseract-Events (optional). */
  onProgress?: (info: { status: string; progress?: number }) => void
}

/** Basis-URL der App (Vite, Default '/'). */
const BASIS = import.meta.env.BASE_URL

export function useKommissionOcr(opts: UseKommissionOcrOptions = {}) {
  const lang = opts.lang ?? 'eng'
  const workerPath = opts.workerPath ?? `${BASIS}tesseract/worker.min.js`
  const corePath = opts.corePath ?? `${BASIS}tesseract/`
  const langPath = opts.langPath ?? `${BASIS}tessdata/`

  const status = ref<OcrStatus>('idle')
  const fehler = ref<string | null>(null)
  let worker: Worker | null = null
  let workerPromise: Promise<Worker> | null = null

  async function ensureWorker(): Promise<Worker> {
    if (worker) return worker
    if (workerPromise) return workerPromise

    status.value = 'loading'
    fehler.value = null

    workerPromise = createWorker(lang, undefined, {
      workerPath,
      corePath,
      langPath,
      logger: (m) => {
        opts.onProgress?.({ status: m.status, progress: m.progress })
      },
    })

    try {
      worker = await workerPromise
      status.value = 'ready'
      return worker
    } catch (e) {
      status.value = 'error'
      fehler.value = e instanceof Error ? e.message : String(e)
      worker = null
      workerPromise = null
      throw e
    }
  }

  /**
   * Nimmt einen Videoframe, schneidet den markierten Ausschnitt aus und
   * führt OCR durch. Gibt die erkannten Kommissionsnummern zurück.
   *
   * @param videoEl Das <video>-Element mit dem Kamerabild.
   * @param cropRect Ausschnitt in normalisierten Koordinaten (0..1)
   *                 relativ zur Video-Darstellung: { x, y, width, height }.
   */
  async function scan(
    videoEl: HTMLVideoElement,
    cropRect: { x: number; y: number; width: number; height: number },
  ): Promise<OcrResult> {
    const w = await ensureWorker()

    const videoWidth = videoEl.videoWidth || videoEl.clientWidth
    const videoHeight = videoEl.videoHeight || videoEl.clientHeight

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(videoWidth * cropRect.width))
    canvas.height = Math.max(1, Math.round(videoHeight * cropRect.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas-Kontext nicht verfügbar')

    ctx.drawImage(
      videoEl,
      Math.round(videoWidth * cropRect.x),
      Math.round(videoHeight * cropRect.y),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    )

    status.value = 'scanning'
    fehler.value = null

    try {
      const { data } = await w.recognize(canvas)
      const text = data.text ?? ''
      const kandidaten = extrahiereKommissionsNummer(text)
      const beste = kandidaten[0] ?? null
      status.value = 'ready'
      return { text, kandidaten, beste }
    } catch (e) {
      status.value = 'error'
      fehler.value = e instanceof Error ? e.message : String(e)
      throw e
    }
  }

  async function stop(): Promise<void> {
    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // ignore
      }
      worker = null
    }
    workerPromise = null
    if (status.value !== 'error') status.value = 'idle'
  }

  return {
    status,
    fehler,
    scan,
    stop,
    ensureWorker,
    extrahiereKommissionsNummer,
  }
}
