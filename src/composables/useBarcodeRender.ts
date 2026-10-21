// useBarcodeRender — bindet einen SVG-Ref an einen Barcode-Wert und
// re-rendert automatisch, wenn sich der Wert ODER das globale Barcode-
// Format (settings.settings.barcodeTyp) aendert.
//
// Robuste SVG-Bereinigung: JsBarcode haengt je nach Browser-Version
// <defs>/<style>-Kinder in den SVG, die bei einem simplen innerHTML = ''
// erhalten bleiben und das frisch gerenderte Bild ueberlagern koennten.
// Wir raeumen daher explizit per removeChild-Schleife auf.
//
// Format-Quelle: IMMER settings.settings.barcodeTyp. Es gibt keine
// Per-Call-Override-Moechlichkeit; das Format wird ausschliesslich in
// den Settings festgelegt (siehe SettingsView.vue).
//
// Name: useBarcodeRender (nicht useBarcode) — useBarcode ist bereits
// durch das Kamera-Scan-Composable in BarcodeScanView belegt.

import { onBeforeUnmount, onMounted, ref, watch, nextTick, type Ref } from 'vue'
import JsBarcode from 'jsbarcode'
import { useSettingsStore } from '../stores/settings'

export interface UseBarcodeRenderOptions {
  width?: number
  height?: number
  displayValue?: boolean
  fontSize?: number
  margin?: number
}

export function useBarcodeRender(
  source: Ref<string | null | undefined>,
  options: UseBarcodeRenderOptions = {},
): { el: Ref<SVGSVGElement | null>; fehler: Ref<string> } {
  const settings = useSettingsStore()
  const el = ref<SVGSVGElement | null>(null)
  const fehler = ref('')

  function clearSvg(node: SVGSVGElement): void {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function render(): void {
    const node = el.value
    if (!node) return
    const wert = (source.value ?? '').trim()
    if (!wert) {
      clearSvg(node)
      fehler.value = ''
      return
    }
    try {
      clearSvg(node)
      JsBarcode(node, wert, {
        format: settings.settings.barcodeTyp,
        width: options.width ?? 2,
        height: options.height ?? 50,
        displayValue: options.displayValue ?? false,
        fontSize: options.fontSize ?? 12,
        margin: options.margin ?? 5,
      })
      fehler.value = ''
    } catch (e) {
      clearSvg(node)
      fehler.value = e instanceof Error ? e.message : String(e)
    }
  }

  onMounted(() => {
    settings.start()
    nextTick(render)
  })

  watch([() => source.value, () => settings.settings.barcodeTyp], () => {
    nextTick(render)
  })

  onBeforeUnmount(() => {
    if (el.value) clearSvg(el.value)
  })

  return { el, fehler }
}
