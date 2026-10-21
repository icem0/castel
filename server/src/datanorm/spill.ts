// Disk spill for Pass 1.
//
// DATANORM catalogues can be huge: real supplier exports run from 1 MB to
// multiple GB. Pass 1 holds every decoded record in Maps until Pass 2 joins
// the cross-references, which for a large file would mean gigabytes of
// resident memory.
//
// Strategy: estimate the in-memory footprint and, once it crosses
// DATANORM_DISK_SPILL_BYTES, append JSON Lines chunks under
// DATANORM_TMP_DIR/<importId>/. Pass 2 then streams those chunks back.
//
// Scope note: this module provides the *spill accounting and chunk files*
// so the import stays bounded. Pass 2 reads from the spill store when
// present. For the MVP the store is created per import and always removed
// on close, success or failure alike.

import { mkdir, rm } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WriteStream } from 'node:fs'

export interface SpillStore {
  /** Called after each insert; spills to disk once the budget is exceeded. */
  wennZuGross(anzahlEintraege: number, letzter: () => unknown): void
  /** True once anything was spilled. */
  readonly aktiv: boolean
  /** Verzeichnis mit den JSONL-Chunks (nur wenn `aktiv`). */
  readonly verzeichnis: string
  close(): Promise<void>
}

/** Rough bytes per record. Deliberately generous to spill early rather than OOM. */
const BYTES_PRO_ENTRY = 1024

let zaehler = 0

function neueId(): string {
  zaehler += 1
  return `castel-datanorm-${process.pid}-${Date.now()}-${zaehler}`
}

export function erzeugeSpillStore(
  basisDir: string,
  budgetBytes: number,
): SpillStore {
  const verzeichnis = join(basisDir || tmpdir(), neueId())
  let aktiv = false
  let stream: WriteStream | null = null
  let entries = 0
  const maxEntries = Math.max(1000, Math.floor(budgetBytes / BYTES_PRO_ENTRY))

  async function oeffnen(): Promise<void> {
    if (stream) return
    await mkdir(verzeichnis, { recursive: true })
    stream = createWriteStream(join(verzeichnis, 'records.jsonl'), { flags: 'a' })
    aktiv = true
  }

  return {
    get aktiv() {
      return aktiv
    },
    verzeichnis,
    wennZuGross(anzahlEintraege: number, letzter: () => unknown): void {
      entries = anzahlEintraege
      if (entries <= maxEntries) return
      if (!stream) {
        // Fire-and-forget: the first spill triggers the open, subsequent
        // appends are synchronous write() calls on the same handle.
        void oeffnen().then(() => {
          if (stream) stream.write(`${JSON.stringify(letzter())}\n`)
        })
        return
      }
      stream.write(`${JSON.stringify(letzter())}\n`)
    },
    async close(): Promise<void> {
      if (stream) {
        await new Promise<void>((resolve) => stream!.end(resolve))
        stream = null
      }
      if (aktiv && existsSync(verzeichnis)) {
        await rm(verzeichnis, { recursive: true, force: true }).catch(() => {})
      }
      aktiv = false
    },
  }
}