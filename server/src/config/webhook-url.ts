// Pure logic for the update-webhook address (UPDATE_WEBHOOK_URL).
//
// The API container cannot update itself: it has no Docker socket and no updater
// sidecar, so the real work always runs on the HOST (scripts/update.sh). The
// address the API therefore has to reach is never `localhost` (inside the
// container that is the API itself) but the host port of the PWA, whose nginx
// proxies `/api/*` straight to the API container.
//
// `host.docker.internal` is mapped by `extra_hosts: host-gateway` in
// docker-compose.yml, so the container sees the host machine. Deriving the URL
// from PWA_PORT keeps the operator from hardcoding a port that already stands
// in the .env: unset UPDATE_WEBHOOK_URL means "use the PWA endpoint on the
// host", which is exactly the systemd-timer variant documented on the help
// page. Any explicit value still wins unchanged.

/**
 * Resolves the effective UPDATE_WEBHOOK_URL.
 *
 * - an explicit, non-empty value is kept untouched (only trimmed)
 * - an unset value falls back to the inbound endpoint on the host, addressed
 *   through the PWA port (`http://host.docker.internal:<PWA_PORT>/...`)
 * - a port that is not a usable integer falls back to 4280 (the compose default)
 */
export function resolveUpdateWebhookUrl(rawUrl: string, pwaPort: unknown): string {
  const explicit = rawUrl.trim()
  if (explicit !== '') return explicit
  return `http://host.docker.internal:${safePort(pwaPort)}/api/admin/update/webhook`
}

/** Host port of the PWA; anything unusable falls back to the compose default. */
function safePort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(String(value ?? ''))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 4280
  return port
}

/**
 * True when a URL can only address the API container itself.
 *
 * Mirrors the check in `admin/update-webhook-routes.ts` so the config layer can
 * warn about a misconfigured .env at startup instead of failing at the first
 * button click. `host.docker.internal` and any LAN IP are fine.
 */
export function isSelfCallWebhookUrl(rawUrl: string, ownPort: unknown): boolean {
  const value = rawUrl.trim()
  if (value === '') return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') return false
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  return port === safePort(ownPort === undefined ? 3000 : ownPort)
}
