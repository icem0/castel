// Prefixes the commit subject with the current version, e.g.
// "v1.0.77 — feat(sync): outbox retry".
//
// GitHub uses the commit subject as workflow run name (run-name cannot read
// package.json before the jobs start). The Husky commit-msg hook runs this
// script after pre-commit bumped the version, so the run name always carries
// the version of the pushed commit.
//
// Usage: node scripts/prefix-version.mjs <commit-message-file>

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const messageFile = process.argv[2]

if (!messageFile) {
  console.error('[prefix-version] Pfad zur Commit-Message fehlt')
  process.exit(1)
}

let version
try {
  version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
} catch (err) {
  console.error(`[prefix-version] package.json nicht lesbar (${err.message})`)
  process.exit(1)
}

if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[prefix-version] Ungültige Version "${version}"`)
  process.exit(1)
}

const raw = readFileSync(messageFile, 'utf8')
const lines = raw.split('\n')

// The subject is the first non-empty, non-comment line.
let subjectIndex = -1
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i].trim()
  if (line !== '' && !line.startsWith('#')) {
    subjectIndex = i
    break
  }
}

if (subjectIndex === -1) {
  // Nothing to prefix (e.g. an empty message); let commitlint report it.
  process.exit(0)
}

const subject = lines[subjectIndex]
const alreadyPrefixed = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+[—–-]\s+/.test(subject)

if (!alreadyPrefixed) {
  lines[subjectIndex] = `v${version} — ${subject}`
  writeFileSync(messageFile, lines.join('\n'), 'utf8')
  console.log(`[prefix-version] ${lines[subjectIndex]}`)
}
