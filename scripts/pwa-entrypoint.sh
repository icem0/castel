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

set -eu

VITE_API_URL="${VITE_API_URL-}"
VITE_DEV_MODE="${VITE_DEV_MODE-false}"

# JS-String-Escapung: Backslashes und Anfuehrungszeichen.
escaped_url=$(printf '%s' "$VITE_API_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')

# DEV-MODE auf kanonische Werte normalisieren, damit die PWA immer
# exakt 'true' oder 'false' sieht. Alles andere (z. B. '1', 'yes',
# 'on', leer) faellt auf 'false' zurueck.
case "$(printf '%s' "$VITE_DEV_MODE" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes|on) dev_mode="true" ;;
  *)            dev_mode="false" ;;
esac

cat > /usr/share/nginx/html/config.js <<EOF
// AUTO-GENERATED at container start from \$VITE_API_URL and \$VITE_DEV_MODE. Do not edit.
window.__CASTEL_API_URL__ = "${escaped_url}";
window.__CASTEL_DEV_MODE__ = "${dev_mode}";
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

exec "$@"
