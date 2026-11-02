// Runtime configuration of the PWA.
//
// The frontend is served as a static bundle. The browser cannot read the
// server's .env — the container entrypoint translates it into /config.js at
// startup (scripts/pwa-entrypoint.sh), which is loaded before the app bundle
// (index.html). That is why the runtime flags live as window globals and are
// only available at runtime.
//
// Read here:
//   window.__CASTEL_API_URL__             — API base URL (see api.ts)
//   window.__CASTEL_ALLOW_INSECURE_HTTP__ — 'true' | 'false'

interface CastelRuntimeConfig {
  __CASTEL_ALLOW_INSECURE_HTTP__?: string | boolean
}

/**
 * true when the browser runs in a secure context (HTTPS, or http://localhost).
 * On http://<IP> it is false — SubtleCrypto (PBKDF2) and service worker
 * registration are missing there.
 */
export function istSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true
}

/**
 * true when the operator deliberately allowed operation without HTTPS
 * (ALLOW_INSECURE_HTTP=true in the server's .env).
 *
 * Without HTTPS, SubtleCrypto is missing. That is harmless for the login
 * itself (the server response is enough), but the PBKDF2 cache used for
 * offline login cannot be written — and without a service worker there is no
 * offline mode anyway.
 */
export function insecureHttpErlaubt(): boolean {
  const raw = (globalThis as typeof globalThis & CastelRuntimeConfig).__CASTEL_ALLOW_INSECURE_HTTP__
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true'
  return false
}
