#!/usr/bin/env bash
#
# castel update runner (host side).
#
#   ./scripts/update.sh              check GitHub, pull, rebuild, clean up
#   ./scripts/update.sh --check      only compare local and remote version
#   ./scripts/update.sh --yes        update without confirmation prompt
#   ./scripts/update.sh --skip-git   skip git pull (images only)
#   ./scripts/update.sh --skip-purge skip image cleanup
#
# Runs on the host, not inside a container. It has the real checkout, the real
# docker CLI and the real compose project name. No DB state channel, no
# webhook, no self-update inside a container, no extra helper container.
#
set -Eeuo pipefail

# ---------- Configuration ----------

REPO_SLUG="${CASTEL_REPO_SLUG:-icem0/castel}"
OWN_IMAGES="${CASTEL_OWN_IMAGES:-ghcr.io/icem0/castel-api ghcr.io/icem0/castel-pwa}"
IMAGE_TAG="${CASTEL_IMAGE_TAG:-latest}"
HEALTH_TIMEOUT_SEC="${CASTEL_HEALTH_TIMEOUT_SEC:-180}"
HEALTH_POLL_SEC="${CASTEL_HEALTH_POLL_SEC:-3}"
PULL_RETRIES="${CASTEL_PULL_RETRIES:-3}"
PULL_RETRY_DELAY="${CASTEL_PULL_RETRY_DELAY:-5}"
PURGE_UNTIL="${CASTEL_PURGE_UNTIL:-168h}"

ONLY_IF_REQUESTED=0
ASSUME_YES=0
SKIP_GIT=0
SKIP_PURGE=0
MODE=update

# ---------- Helpers ----------

say() { printf '%s\n' "$*"; }
die() { printf 'update: %s\n' "$*" >&2; exit 1; }

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 25 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=25 "$1"
  elif command -v node >/dev/null 2>&1; then
    node -e '
      fetch(process.argv[1])
        .then(async (r) => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()) })
        .catch(() => process.exit(1))
    ' "$1"
  else
    die 'curl, wget or node is needed to reach GitHub'
  fi
}

# Highest vMAJOR.MINOR.PATCH tag: git first (no API rate limit), then GitHub API.
remote_version() {
  if command -v git >/dev/null 2>&1 &&
    git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local tags version
    tags="$(git -C "$PWD" ls-remote --tags --refs "https://github.com/$REPO_SLUG.git" 'v*' 2>/dev/null || true)"
    version="$(printf '%s\n' "$tags" |
      sed -n 's#.*refs/tags/\(v[0-9][0-9.]*\)$#\1#p' |
      sed 's/^v//' |
      sort -t. -k1,1n -k2,2n -k3,3n |
      tail -n 1)"
    if [ -n "$version" ]; then
      printf 'v%s\n' "$version"
      return 0
    fi
  fi

  local body version
  body="$(fetch "https://api.github.com/repos/$REPO_SLUG/releases/latest" 2>/dev/null || true)"
  version="$(printf '%s\n' "$body" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' |
    head -n 1)"
  if [ -z "$version" ]; then
    body="$(fetch "https://api.github.com/repos/$REPO_SLUG/tags?per_page=100" 2>/dev/null || true)" ||
      die 'cannot read the tags from GitHub'
    version="$(printf '%s\n' "$body" |
      sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' |
      sed 's/^v//' |
      sort -t. -k1,1n -k2,2n -k3,3n |
      tail -n 1)"
    [ -n "$version" ] && version="v$version"
  fi
  [ -n "$version" ] || die 'GitHub returned no version tag'
  printf '%s\n' "$version"
}

# Read version from package.json without node.
read_version() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1 || true
}

# Detect compose CLI (v2 plugin or legacy docker-compose).
detect_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die 'docker compose is not installed'
  fi
}

compose() {
  "${COMPOSE[@]}" "$@"
}

# ---------- Options ----------

for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --yes | -y) ASSUME_YES=1 ;;
    --skip-git) SKIP_GIT=1 ;;
    --skip-purge) SKIP_PURGE=1 ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      die "unknown option: $arg"
      ;;
  esac
done

# ---------- Main ----------

main() {
  command -v docker >/dev/null 2>&1 || die 'docker is not installed'
  detect_compose_cmd
  docker info >/dev/null 2>&1 || die 'Docker daemon not reachable'

  local local_version latest
  local_version="$(read_version ./package.json)"
  latest="$(remote_version)"

  say "Lokale Version: ${local_version:-unbekannt}"
  say "GitHub:         $latest"

  if [ "$MODE" = check ]; then
    if [ -n "$local_version" ] && [ "$local_version" = "${latest#v}" ]; then
      say 'Der Server ist bereits auf der neuesten Version.'
      exit 0
    fi
    say "Update verfügbar: $latest"
    exit 0
  fi

  if [ -n "$local_version" ] && [ "$local_version" = "${latest#v}" ]; then
    say 'Bereits auf der neuesten Version.'
    exit 0
  fi

  if [ "$ASSUME_YES" -ne 1 ]; then
    printf 'Update auf %s jetzt einspielen? [j/N] ' "$latest"
    local answer
    read -r answer || answer=n
    case "$answer" in
      j | J | y | Y | ja | Ja | yes | Yes) ;;
      *) say 'Abgebrochen.'; exit 0 ;;
    esac
  fi

  # Optional git pull (only when a checkout exists).
  if [ "$SKIP_GIT" -eq 0 ] && command -v git >/dev/null 2>&1 && [ -d .git ]; then
    say 'Ziehe das Repository …'
    git -c safe.directory="$PWD" pull --ff-only --autostash ||
      die 'git pull failed'
  fi

  say 'Ziehe neue Images …'
  local attempt=1
  while :; do
    if compose pull; then break; fi
    if [ "$attempt" -ge "$PULL_RETRIES" ]; then
      die "docker compose pull nach $attempt Versuchen fehlgeschlagen"
    fi
    say "Pull fehlgeschlagen - neuer Versuch in ${PULL_RETRY_DELAY}s ($attempt/$PULL_RETRIES)."
    attempt=$((attempt + 1))
    sleep "$PULL_RETRY_DELAY"
  done

  # Stop old containers so their images can be replaced.
  docker compose stop api pwa migrate 2>/dev/null || true

  # Remove superseded images of our own repos (everything except the current tag).
  local repo id keep_tag="$IMAGE_TAG"
  for repo in $OWN_IMAGES; do
    for id in $(docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null |
      grep "^${repo}:" | grep -v ":${keep_tag}$" | awk '{print $2}'); do
      docker rmi -f "$id" >/dev/null 2>&1 || true
    done
  done

  say 'Baue/Startet den Stack neu …'
  compose up -d --remove-orphans

  # Health check: API must become healthy again.
  local API_CONTAINER deadline status
  API_CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=api' --format '{{.Names}}' 2>/dev/null | head -n 1 || true)"
  if [ -n "$API_CONTAINER" ]; then
    say "Health-Check (Timeout ${HEALTH_TIMEOUT_SEC}s) …"
    deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
    while [ "$SECONDS" -lt "$deadline" ]; do
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$API_CONTAINER" 2>/dev/null || echo missing)"
      case "$status" in
        healthy | running)
          say "API-Container ist $status."
          break
          ;;
        unhealthy | exited | dead)
          say "API-Container ist $status - letzte Logzeilen:"
          docker logs --tail 30 "$API_CONTAINER" 2>&1 | sed 's/^/      /' || true
          die 'API-Container wurde nicht gesund.'
          ;;
      esac
      sleep "$HEALTH_POLL_SEC"
    done
    if [ "$SECONDS" -ge "$deadline" ]; then
      say "Timeout - letzter Status: ${status:-unknown}"
      die 'API-Container wurde nicht gesund.'
    fi
  else
    say 'Kein API-Container gefunden - Health-Check übersprungen.'
  fi

  # Image cleanup.
  if [ "$SKIP_PURGE" -eq 0 ]; then
    say 'Bereinige alte Images …'
    docker image prune -f >/dev/null 2>&1 || true
    docker image prune -a -f --filter "until=${PURGE_UNTIL}" >/dev/null 2>&1 || true
    docker builder prune -f >/dev/null 2>&1 || true
  fi

  say "Fertig. Version auf dem Server: $(read_version ./package.json 2>/dev/null || printf 'unbekannt')"
}

main "$@"
