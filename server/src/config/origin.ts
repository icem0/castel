// Pure helpers for origin/URL values coming from the .env.
//
// A deployer who types only the bare domain ("castel.example.com") must not
// hit a hard config error: `z.string().url()` rejects a schemeless value and
// the process exits 1 with a message the operator cannot act on. These helpers
// add the safest scheme and keep the intent visible instead.

/** True for origins that can only be reached over plain http (dev, LAN). */
export function isLanOrigin(raw: string): boolean {
  const value = raw.trim().replace(/^https?:\/\//, '').toLowerCase()
  if (value === '') return false
  if (value.startsWith('localhost') || value.startsWith('127.')) return true
  if (value.startsWith('[::1]') || value === '::1') return true
  // Pure numeric host (optionally with port): an IP address, no TLS possible.
  return /^[\d.]+(:\d+)?$/.test(value)
}

/**
 * Normalises a configured origin into a full URL.
 *
 * - keeps an explicit `http://` or `https://` untouched
 * - treats any other scheme (`ws://`, `blob:`, ...) as already resolved
 * - adds `https://` for a bare domain, `http://` for localhost/IP origins
 * - drops a trailing slash, which would break the exact CORS-Origin match
 */
export function normaliseOrigin(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''

  const lower = trimmed.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '')
  }
  if (trimmed.includes('://')) return trimmed

  const withoutSlashes = trimmed.replace(/^\/+/, '')
  if (withoutSlashes === '') return ''

  const host = withoutSlashes.replace(/\/+$/, '')
  const scheme = isLanOrigin(host) ? 'http://' : 'https://'
  return `${scheme}${host}`
}
