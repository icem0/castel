// Patch-Bump für root package.json + server/package.json.
//
// Wird vom Husky pre-commit Hook aufgerufen. Liest die aktuelle Version,
// inkrementiert die Patch-Nummer (semver: MAJOR.MINOR.PATCH) und schreibt
// die Dateien mit stabiler Formatierung (2-Space-Indent, LF-Zeilenenden,
// trailing newline) zurück.
//
// Pre-Release-Tags (z. B. "0.2.0-beta.1") werden beibehalten — der Patch-
// Zähler wird unabhängig davon erhöht. Build-Metadaten ("+exp.sha.5114f85",
// siehe https://semver.org/#spec-item-10) werden verworfen, da das Repo
// keine Pre-Releases pflegt.
//
// Exit-Codes:
//   0  Erfolg (auch wenn nichts zu bumpen war, weil Version schon am Maximum)
//   1  Fehler (z. B. package.json nicht parsbar, kein gültiger Semver-String)
//
// Das Skript ist bewusst dependency-frei — keine semver-Bibliothek, kein
// JSON-Traversal außer den Hausmitteln von Node. So läuft es auch im
// Husky-Hook ohne npm ci.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TARGETS = [
  { path: resolve(root, 'package.json'), label: 'root' },
  { path: resolve(root, 'server', 'package.json'), label: 'server' },
]

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function bumpPatch(version) {
  const match = SEMVER_RE.exec(version)
  if (!match) return null
  const [, major, minor, patch, pre] = match
  const next = `${major}.${minor}.${Number(patch) + 1}${pre ? `-${pre}` : ''}`
  return next
}

function readJson(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  return JSON.parse(raw)
}

function writeJson(filePath, data) {
  // Trailing newline wie npm es selbst schreibt; 2-Space-Indent entspricht
  // den bestehenden package.json-Dateien.
  const out = JSON.stringify(data, null, 2) + '\n'
  writeFileSync(filePath, out, 'utf8')
}

// Zwei-Phasen-Loop: erst alle Dateien lesen + validieren, dann schreiben.
// So bricht das Skript ab, bevor irgendetwas auf der Platte landet — entweder
// es bumpen beide oder keiner (root und server bleiben synchron).
const planned = []
for (const target of TARGETS) {
  let pkg
  try {
    pkg = readJson(target.path)
  } catch (err) {
    console.error(`[bump] ${target.label}: package.json nicht lesbar (${err.message})`)
    process.exit(1)
  }

  const current = typeof pkg.version === 'string' ? pkg.version : ''
  const next = bumpPatch(current)
  if (!next) {
    console.error(
      `[bump] ${target.label}: aktuelle Version "${current}" ist kein gültiger Semver-String`,
    )
    process.exit(1)
  }

  planned.push({ target, pkg, current, next })
}

for (const { target, pkg, current, next } of planned) {
  pkg.version = next
  writeJson(target.path, pkg)
  console.log(`[bump] ${target.label}: ${current} → ${next}`)
}
