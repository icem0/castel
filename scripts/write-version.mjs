// Erzeugt src/version.ts mit Build-Metadaten.
// Wird vor jedem Build ausgeführt (npm-Skript "version:write").
//
// Felder:
//   - version:   aus package.json
//   - commit:    Git-HEAD-Hash (kurz, 7 Zeichen)
//   - branch:    Git-Branch-Name
//   - buildDate: ISO-Zeitstempel des Builds

import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readPackageVersion() {
  try {
    const raw = readFileSync(resolve(root, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function gitOrNull(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const version = readPackageVersion()

// Commit/Branch können in zwei Quellen kommen:
//   1. ENV GIT_COMMIT / GIT_BRANCH — vom Dockerfile oder CI als Build-Arg gesetzt
//      (docker buildx hat kein .git/, also fallen wir sonst auf 'unbekannt' zurück)
//   2. git rev-parse — funktioniert lokal und in CI-Workern, die mit actions/checkout
//      einen echten .git/-Ordner haben
const commitFromEnv = (process.env.GIT_COMMIT ?? '').replace(/[^a-f0-9]/gi, '').slice(0, 7)
const branchFromEnv = (process.env.GIT_BRANCH ?? '').replace(/[^a-zA-Z0-9._/-]/g, '')

const commitFromGit = gitOrNull('rev-parse --short HEAD') ?? ''
const branchFromGit = gitOrNull('rev-parse --abbrev-ref HEAD') ?? ''

const commit = commitFromEnv || commitFromGit.replace(/[^a-f0-9]/gi, '') || 'unbekannt'
const branch = branchFromEnv || branchFromGit || 'unbekannt'

const buildDate = new Date().toISOString()

const out = `// AUTO-GENERATED durch scripts/write-version.mjs.
// Nicht per Hand bearbeiten – wird bei jedem npm run build überschrieben.
export const version: string = '${version.replace(/'/g, "\\'")}'
export const commit: string = '${commit.replace(/'/g, "\\'")}'
export const branch: string = '${branch.replace(/'/g, "\\'")}'
export const buildDate: string = '${buildDate.replace(/'/g, "\\'")}'
`

const target = resolve(root, 'src', 'version.ts')
writeFileSync(target, out, 'utf8')
console.log(`[version] v${version} · ${commit} · ${branch} · ${buildDate}`)
