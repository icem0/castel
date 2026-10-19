// Lokaler Type-Shim fuer 'archiver'. Das npm-Paket @types/archiver
// ist veraltet (zu archiver 5.x) und exportiert die vendoring function
// `archiver(format, opts)` nicht mehr. Wir shimmen das Modul hier
// komplett, damit unser Code typsicher bleibt.
//
// Aufruf im Code:
//   import archiver from 'archiver'
//   const a = archiver('zip', { zlib: { level: 6 } })

declare module 'archiver' {
  import type { Transform } from 'node:stream'

  export type ArchiverFormat = 'zip' | 'tar' | 'json'

  export interface ArchiverOptions {
    zlib?: { level?: number } | undefined
    gzip?: boolean | undefined
    statConcurrency?: number | undefined
  }

  export class Archiver extends Transform {
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'warning', listener: (err: NodeJS.ErrnoException) => void): this
    on(event: 'entry', listener: (entry: unknown) => void): this
    on(event: 'progress', listener: (entry: unknown) => void): this
    on(event: string, listener: (...args: unknown[]) => void): this
    append(source: unknown, data?: { name?: string } | { prefix?: string }): this
    directory(dir: string, dest: string, data?: unknown): this
    file(name: string, data: unknown): this
    glob(pattern: string, data?: unknown): this
    finalize(): Promise<void>
    abort(): void
    pointer(): number
    use(plugin: unknown): this
    pipe<T>(dest: T, options?: { end?: boolean }): T
  }

  function archiver(format: ArchiverFormat, options?: ArchiverOptions): Archiver
  export { archiver as default }
}
