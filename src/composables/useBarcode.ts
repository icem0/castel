// useBarcode — Composable für Kamera-Barcode-Scan.
// Nutzt die Web-Barcodedetector-API wenn verfügbar, sonst ZXing-Fallback.

import { ref, onBeforeUnmount } from 'vue'
import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'

export interface UseBarcodeOptions {
  onDetected: (code: string, format: string) => void
  /** Welche Formate bevorzugt werden (Web-API: ean_13, code_128, …). */
  formats?: string[]
}

export function useBarcode(opts: UseBarcodeOptions) {
  const aktiv = ref(false)
  const fehler = ref<string | null>(null)
  const unterstuetzt = ref(true)
  let video: HTMLVideoElement | null = null
  let stream: MediaStream | null = null
  let detector: unknown = null
  let detectorInterval: number | null = null
  let zxingControls: IScannerControls | null = null

  const FORMATS = opts.formats ?? ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a']

  async function start(videoEl: HTMLVideoElement): Promise<void> {
    video = videoEl
    fehler.value = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      video.srcObject = stream
      await video.play()
      aktiv.value = true
    } catch (e) {
      fehler.value = e instanceof Error ? e.message : String(e)
      unterstuetzt.value = false
      return
    }

    // Variante 1: native BarcodeDetector-API (Android-Chrome, iOS 17+)
    const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector
    if (typeof BarcodeDetectorCtor === 'function') {
      try {
        detector = new (
          BarcodeDetectorCtor as new (init: { formats: string[] }) => {
            detect: (
              source: HTMLVideoElement,
            ) => Promise<Array<{ rawValue: string; format: string }>>
          }
        )({ formats: FORMATS })
        detectorInterval = window.setInterval(async () => {
          if (!video || !detector) return
          try {
            const codes = await (
              detector as {
                detect: (
                  s: HTMLVideoElement,
                ) => Promise<Array<{ rawValue: string; format: string }>>
              }
            ).detect(video)
            if (codes.length > 0 && codes[0]) {
              const c = codes[0]
              stop()
              opts.onDetected(c.rawValue, c.format)
            }
          } catch {
            // ignore frame errors
          }
        }, 250)
        return
      } catch {
        detector = null
      }
    }

    // Fallback: ZXing
    try {
      const reader = new BrowserMultiFormatReader()
      zxingControls = await reader.decodeFromVideoElement(video, (result) => {
        if (result) {
          stop()
          opts.onDetected(result.getText(), result.getBarcodeFormat().toString())
        }
      })
    } catch (e) {
      fehler.value = `Barcode-Scan nicht verfügbar: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  function stop(): void {
    aktiv.value = false
    if (detectorInterval !== null) {
      clearInterval(detectorInterval)
      detectorInterval = null
    }
    if (zxingControls) {
      zxingControls.stop()
      zxingControls = null
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    if (video) {
      video.srcObject = null
      video = null
    }
  }

  onBeforeUnmount(stop)

  return { start, stop, aktiv, fehler, unterstuetzt }
}
