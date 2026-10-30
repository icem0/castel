// Stellt die OCR-Assets fuer den Kommissions-Scan ("Sannen") bereit.
//
// tesseract.js wuerde Core-WASM und Sprachdaten standardmaessig vom CDN
// laden — das bricht das Offline-first-Versprechen. Dieses Skript legt
// beide lokal unter public/ ab, damit der Service-Worker sie runtime-cacht
// und die Kamera-Texterkennung ohne Netz laeuft:
//
//   public/tesseract/   worker.min.js + tesseract-core-*-lstm.wasm.js
//   public/tessdata/    eng.traineddata.gz  (4.0.0, fast)
//
// Aufgerufen als `npm run ocr:assets` (prebuild/predev). Laeuft der
// Download nicht (CI offline, CDN nicht erreichbar), wird nur gewarnt —
// der Build darf nicht daran scheitern. Die Kamera-OCR meldet dann zur
// Laufzeit einen klaren Fehler statt still zu sein.

import { createWriteStream, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const corePkg = path.join(root, 'node_modules', 'tesseract.js-core')
const distPkg = path.join(root, 'node_modules', 'tesseract.js', 'dist')
const tessDir = path.join(root, 'public', 'tesseract')
const tessdataDir = path.join(root, 'public', 'tessdata')

const TRAINEDDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz'
const TRAINEDDATA = path.join(tessdataDir, 'eng.traineddata.gz')
const MIN_GZ_BYTES = 500_000

function warn(text) {
  console.warn(`[ocr-assets] ${text}`)
}

function prepareTesseract() {
  if (!existsSync(corePkg) || !existsSync(distPkg)) {
    warn('tesseract.js ist nicht installiert – OCR-Assets uebersprungen.')
    return false
  }
  mkdirSync(tessDir, { recursive: true })
  copyFileSync(path.join(distPkg, 'worker.min.js'), path.join(tessDir, 'worker.min.js'))
  const cores = [
    'tesseract-core-lstm.wasm.js',
    'tesseract-core-simd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ]
  let kopiert = 0
  for (const datei of cores) {
    const quelle = path.join(corePkg, datei)
    if (existsSync(quelle)) {
      copyFileSync(quelle, path.join(tessDir, datei))
      kopiert++
    }
  }
  if (kopiert === 0) {
    warn('Keine LSTM-Core-Dateien in tesseract.js-core gefunden – OCR-Assets unvollstaendig.')
    return false
  }
  return true
}

async function prepareTessdata() {
  if (existsSync(TRAINEDDATA) && statSync(TRAINEDDATA).size >= MIN_GZ_BYTES) return true
  mkdirSync(tessdataDir, { recursive: true })
  const antwort = await fetch(TRAINEDDATA_URL)
  if (!antwort.ok || !antwort.body) {
    warn(`eng.traineddata.gz nicht ladbar (HTTP ${antwort.status}).`)
    return false
  }
  const tmp = `${TRAINEDDATA}.tmp`
  await pipeline(antwort.body, createWriteStream(tmp))
  const { renameSync, unlinkSync } = await import('node:fs')
  if (existsSync(TRAINEDDATA)) unlinkSync(TRAINEDDATA)
  renameSync(tmp, TRAINEDDATA)
  return true
}

async function main() {
  const coreOk = prepareTesseract()
  let dataOk = false
  try {
    dataOk = await prepareTessdata()
  } catch (e) {
    warn(`eng.traineddata.gz nicht ladbar: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (coreOk && dataOk) {
    console.log('[ocr-assets] OCR-Assets bereit (public/tesseract + public/tessdata).')
  }
}

main().catch((e) => {
  warn(`OCR-Assets fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`)
})
