#!/bin/sh
# Entrypoint fuer den PWA-Container (nginx).
#
# Erzeugt beim Container-Start /usr/share/nginx/html/config.js aus den
# ENV-Variablen. Die PWA laedt /config.js vor dem App-Bundle und liest
# daraus window.__CASTEL_API_URL__ (siehe src/auth/api.ts) und
# window.__CASTEL_DEV_MODE__ (siehe src/composables/useDevMode.ts).
#
# ENV-Variablen:
#   VITE_API_URL  Basis-URL des API-Backends.
#                 Leer oder ungesetzt -> window.__CASTEL_API_URL__ = ''  (gleicher
#                 Origin, nginx proxied /api/* an die API).
#                 Sonst -> absolute URL, z. B. http://api.example.com:4242.
#   VITE_DEV_MODE 'true' | 'false'. Steuert das "DEV MODE"-Badge in
#                 Login-Screen und Header. Default 'false'.
#   ALLOW_INSECURE_HTTP 'true' | 'false'. Allows running without HTTPS.
#                 Default 'false': the PWA requires a secure browser context
#                 because SubtleCrypto (PBKDF2) and the service worker are
#                 missing there. 'true' = HTTP mode is deliberately allowed
#                 (login without the offline cache).
#   FORCE_HTTPS       'auto' | 'true' | 'false'. Sends a 301 http -> https
#                 already at this nginx, so typing the bare domain in the
#                 address bar no longer lands in an insecure browser context.
#                 'auto' (default) = on as long as ALLOW_INSECURE_HTTP=false.
#                 Never fires for localhost/IP hosts and not while Cloudflare
#                 "Flexible SSL" speaks plain http to the origin (loop trap).
#   HTTPS_REDIRECT_PORT Optional https port when it is NOT 443, e.g. 8443.
#   HSTS_MAX_AGE_SECONDS Strict-Transport-Security age in seconds.
#                 'auto' (default) = 31536000 (12 months) when ALLOW_INSECURE_HTTP
#                 is off, 0 (clears the policy) when it is on. 0 = disabled.
#   HSTS_SUBDOMAINS     'true' | 'false' (default false).
#   HSTS_PRELOAD        'true' | 'false' (default false). Only set this to
#                 true knowingly: preload is a one-way, globally cached opt-in.
#

set -eu

VITE_API_URL="${VITE_API_URL-}"
VITE_DEV_MODE="${VITE_DEV_MODE-false}"
ALLOW_INSECURE_HTTP="${ALLOW_INSECURE_HTTP-false}"
FORCE_HTTPS="${FORCE_HTTPS-auto}"
HTTPS_REDIRECT_PORT="${HTTPS_REDIRECT_PORT-}"
HSTS_MAX_AGE_SECONDS="${HSTS_MAX_AGE_SECONDS-auto}"
HSTS_SUBDOMAINS="${HSTS_SUBDOMAINS-false}"
HSTS_PRELOAD="${HSTS_PRELOAD-false}"

# A bare domain in VITE_API_URL ("api.example.com") is no valid fetch target.
# Assume https (the only safe default) and tell the operator, instead of
# letting the PWA fail with "Server not reachable". LAN hosts (localhost, IP)
# keep http - mirroring server/src/config/origin.ts normaliseOrigin().
case "$VITE_API_URL" in
  https://* | http://* | '') ;;
  *)
    bare="${VITE_API_URL#//}"
    host_part="${bare%%[:/]*}"
    scheme="https://"
    case "$host_part" in
      localhost*) scheme="http://" ;;
      127.*) scheme="http://" ;;
      *[!0-9.]) ;;
      *.*) scheme="http://" ;;
    esac
    printf '[pwa-entrypoint] WARN: VITE_API_URL "%s" has no scheme -> assuming %s. Set the full origin in the .env.\n' "$VITE_API_URL" "${scheme}${bare}" >&2
    VITE_API_URL="${scheme}${bare}"
    ;;
esac

# JS-String-Escapung: Backslashes und Anfuehrungszeichen.
escaped_url=$(printf '%s' "$VITE_API_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

# DEV-MODE auf kanonische Werte normalisieren, damit die PWA immer
# exakt 'true' oder 'false' sieht. Alles andere (z. B. '1', 'yes',
# 'on', leer) faellt auf 'false' zurueck.
case "$(printf '%s' "$VITE_DEV_MODE" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) dev_mode="true" ;;
  *)            dev_mode="false" ;;
esac

# Normalise ALLOW_INSECURE_HTTP to canonical values.
case "$(printf '%s' "$ALLOW_INSECURE_HTTP" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) allow_insecure_http="true" ;;
  *)            allow_insecure_http="false" ;;
esac

cat > /usr/share/nginx/html/config.js <<EOF
// AUTO-GENERATED at container start from \$VITE_API_URL, \$VITE_DEV_MODE and
// \$ALLOW_INSECURE_HTTP. Do not edit.
window.__CASTEL_API_URL__ = "${escaped_url}";
window.__CASTEL_DEV_MODE__ = "${dev_mode}";
window.__CASTEL_ALLOW_INSECURE_HTTP__ = "${allow_insecure_http}";
EOF

# Hinweis: VITE_API_URL ist die Origin-Basis. Die App haengt '/api/...'
# selbst an. Ein trailing '/api' fuehrt sonst zu '/api/api/...' und 404.
# src/auth/api.ts entfernt ein trailing '/api' automatisch, aber sauberer
# ist die Origin-Basis ohne '/api'-Suffix.
case "$escaped_url" in
  */api)
    printf '[pwa-entrypoint] WARN: VITE_API_URL ends with /api — auto-trimmed at runtime. Set the origin instead (e.g. https://example.com).\n' >&2
    ;;
esac

# ---- .env-driven nginx snippets (http -> https 301 and HSTS) ----
# Rewritten on every start, so a changed .env takes effect without rebuilding
# the image. nginx-pwa.conf includes both through a glob, therefore the stale
# variant of the other mode must be removed first.

case "$(printf '%s' "$FORCE_HTTPS" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) force_https="true" ;;
  false|0|off|no) force_https="false" ;;
  *) force_https="$([ "$allow_insecure_http" = false ] && echo true || echo false)" ;;
esac

# Explicit FORCE_HTTPS=true next to ALLOW_INSECURE_HTTP=true is a contradiction:
# the operator wants to serve plain http, the redirect would undo it.
if [ "$allow_insecure_http" = true ] && [ "$force_https" = true ]; then
  printf '[pwa-entrypoint] WARN: ALLOW_INSECURE_HTTP=true but FORCE_HTTPS=true -> redirect disabled. Plain http stays http.\n' >&2
  force_https=false
fi

case "$HTTPS_REDIRECT_PORT" in
  '') port_suffix='' ;;
  *[!0-9]*)
    printf '[pwa-entrypoint] WARN: HTTPS_REDIRECT_PORT "%s" is not a number -> ignored (https://$host used).\n' "$HTTPS_REDIRECT_PORT" >&2
    port_suffix=''
    ;;
  *) port_suffix=":$HTTPS_REDIRECT_PORT" ;;
esac

rm -f /etc/nginx/force-https-on.conf /etc/nginx/force-https-off.conf
if [ "$force_https" = true ]; then
  cat >/etc/nginx/force-https-on.conf <<EOF
# AUTO-GENERATED at container start from \$FORCE_HTTPS. Do not edit.
# \$castel_redirect starts at 1 and gets reset for LAN hosts, for Cloudflare
# Flexible SSL and for requests that already arrived as https. Only then
# the catch-all location / in nginx-pwa.conf sends the 301 - /api/ and
# /fotos/ deliberately stay plain http.
set \$castel_redirect 1;
set \$castel_https_target "https://\$host${port_suffix}";
if (\$castel_host_is_lan = 1)         { set \$castel_redirect 0; }
if (\$castel_cf_flexible = 1)         { set \$castel_redirect 0; }
if (\$castel_cf_insecure = 1)         { set \$castel_redirect 0; }
if (\$scheme = https)                 { set \$castel_redirect 0; }
if (\$http_x_forwarded_proto = https) { set \$castel_redirect 0; }
EOF
  printf '[pwa-entrypoint] NOTE: FORCE_HTTPS active - plain http gets a 301 to https://$host. Something has to answer https (Cloudflare Full/Fixed, Caddy, own nginx or in-stack TLS); for LAN/IP hosts the redirect is skipped.\n' >&2
else
  cat >/etc/nginx/force-https-off.conf <<EOF
# AUTO-GENERATED: FORCE_HTTPS off - plain http is served as it is.
EOF
fi

case "$HSTS_MAX_AGE_SECONDS" in
  auto | '')
    if [ "$allow_insecure_http" = true ]; then hsts_age=0; else hsts_age=31536000; fi
    ;;
  *[!0-9]*)
    printf '[pwa-entrypoint] WARN: HSTS_MAX_AGE_SECONDS "%s" is not a number -> HSTS cleared (max-age=0).\n' "$HSTS_MAX_AGE_SECONDS" >&2
    hsts_age=0
    ;;
  *) hsts_age="$HSTS_MAX_AGE_SECONDS" ;;
esac

hsts_flags=''
case "$(printf '%s' "$HSTS_SUBDOMAINS" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) hsts_flags='; secure' ;;
esac
case "$(printf '%s' "$HSTS_PRELOAD" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) hsts_flags="${hsts_flags}; preload" ;;
esac

rm -f /etc/nginx/hsts-on.conf /etc/nginx/hsts-off.conf
if [ "$hsts_age" -gt 0 ]; then
  cat >/etc/nginx/hsts-on.conf <<EOF
# AUTO-GENERATED at container start from \$HSTS_*. Do not edit.
add_header Strict-Transport-Security "max-age=${hsts_age}${hsts_flags}" always;
EOF
  printf '[pwa-entrypoint] NOTE: HSTS sent (max-age=%ss) - the browser rewrites http:// to https:// on its own from the next visit on.\n' "$hsts_age" >&2
else
  cat >/etc/nginx/hsts-off.conf <<EOF
# AUTO-GENERATED: HSTS disabled - max-age=0 clears any policy a browser cached before.
add_header Strict-Transport-Security "max-age=0" always;
EOF
fi

# Belt and braces: the snippets above are generated at runtime, so a typo would
# otherwise kill the container at nginx start. Validate them here and degrade to
# the previous, known-good behaviour instead of leaving the PWA dead.
if ! nginx -t >/tmp/nginx-check.out 2>&1; then
  printf '[pwa-entrypoint] ERROR: generated nginx snippets invalid -> http->https and HSTS disabled, please report this.\n' >&2
  tail -n 6 /tmp/nginx-check.out >&2
  rm -f /etc/nginx/force-https-on.conf /etc/nginx/hsts-on.conf
  cat >/etc/nginx/force-https-off.conf <<EOF
# AUTO-GENERATED fallback: snippet rejected by nginx -t.
EOF
  cat >/etc/nginx/hsts-off.conf <<EOF
add_header Strict-Transport-Security "max-age=0" always;
EOF
  if ! nginx -t >/dev/null 2>&1; then
    printf '[pwa-entrypoint] ERROR: nginx config still broken, starting anyway - check the log.\n' >&2
  fi
fi

exec "$@"
