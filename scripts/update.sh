#!/usr/bin/env bash
#
# castel update runner (host side).
#
# Runs the complete stack update:
#   1. git pull --ff-only     - source of truth for compose file, .env, scripts
#   2. docker compose pull    - new images from GHCR
#   3. docker compose up -d   - recreate the containers that changed
#   4. health check           - the api container must become healthy again
#   5. docker image prune     - remove dangling + unused old images
#
# WHY THIS RUNS ON THE HOST AND NOT INSIDE A CONTAINER
#   The api container has no git credentials, no access to the compose project
#   and it would kill itself while recreating itself. On the host we have the
#   real checkout, the real docker CLI and the real compose project name.
#
# WHY THE DB IS THE CHANNEL
#   The update replaces the api container. Anything kept in process memory is
#   gone afterwards. The DB survives, so the request flag and the progress log
#   live in `einstellungen` (key "server.updateState") and the PWA can show
#   them while the stack restarts.
#
# USAGE
#   ./scripts/update.sh                  run the update right now
#   ./scripts/update.sh --if-requested   run only if the PWA requested one
#
# OPTIONS
#   --skip-git          do not touch git (images only)
#   --skip-purge        do not remove any images
#   --no-builder-prune  keep the docker build cache
#   --allow-dirty       proceed even with uncommitted changes in the checkout
#   --purge-until X     age filter for "unused" images (default 168h = 7 days)
#
# ENVIRONMENT
#   CASTEL_REPO_DIR            explicit path of the compose checkout
#   CASTEL_HEALTH_TIMEOUT_SEC  seconds to wait for a healthy api (default 120)
#   CASTEL_PURGE_UNTIL         age filter for unused images (default 168h)
#
set -Eeuo pipefail

# ---------- Configuration ----------

STATE_KEY="server.updateState"
LOG_MAX_CHARS=32000
HEALTH_TIMEOUT_SEC="${CASTEL_HEALTH_TIMEOUT_SEC:-120}"
HEALTH_POLL_SEC="${CASTEL_HEALTH_POLL_SEC:-3}"
PURGE_UNTIL="${CASTEL_PURGE_UNTIL:-168h}"
LOCK_FILE="${CASTEL_UPDATE_LOCK:-/tmp/castel-update.lock}"

# ---------- Runtime state ----------

REPO_DIR=""
PROJECT_NAME=""
COMPOSE_FILES=()
DB_CONTAINER=""
API_CONTAINER=""
LOG_FILE=""
REQUESTED_AT=""
STARTED_AT=""
STARTED_AT_EPOCH=""
FINISHED_AT=""
GIT_BEFORE=""
GIT_AFTER=""
VERSION_BEFORE=""
VERSION_AFTER=""
IMAGE_TAG="latest"
HOSTNAME_VALUE="$(hostname 2>/dev/null || echo unknown)"

PHASE="requested"
STEP=""
MESSAGE=""
EXIT_CODE=""
OK_JSON="null"

# ---------- Options ----------

ONLY_IF_REQUESTED=0
SKIP_GIT=0
SKIP_PURGE=0
ALLOW_DIRTY=0
PURGE_BUILDER=1

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --if-requested) ONLY_IF_REQUESTED=1 ;;
      --skip-git) SKIP_GIT=1 ;;
      --skip-purge) SKIP_PURGE=1 ;;
      --no-builder-prune) PURGE_BUILDER=0 ;;
      --allow-dirty) ALLOW_DIRTY=1 ;;
      --purge-until)
        shift
        [ "$#" -gt 0 ] || { echo "FEHLER: --purge-until braucht einen Wert" >&2; exit 2; }
        PURGE_UNTIL="$1"
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        echo "FEHLER: unbekanntes Argument '$1'" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

# ---------- Small helpers ----------

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Writes a line to stdout and to the log buffer.
log_line() {
  local line="$1"
  printf '%s\n' "$line"
  if [ -n "$LOG_FILE" ]; then
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
  fi
}

# Escapes a string for use inside a JSON string literal. Newlines become \n so
# that the whole document stays on a single line (much easier to parse).
json_escape() {
  printf '%s' "${1:-}" |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' |
    awk '{ if (NR > 1) printf "\\n"; printf "%s", $0 }'
}

# JSON string or null.
jstr() {
  if [ -z "${1:-}" ]; then
    printf 'null'
  else
    printf '"%s"' "$(json_escape "$1")"
  fi
}

# JSON number or null.
jnum() {
  if [ -z "${1:-}" ]; then
    printf 'null'
  else
    printf '%s' "$1"
  fi
}

# Escapes a string for a SQL single quoted literal.
sql_escape() {
  printf '%s' "${1:-}" | sed "s/'/''/g"
}

# Reads a version out of a package.json without requiring node on the host.
read_version() {
  local file="$1"
  [ -f "$file" ] || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1 || true
}

# Reads a KEY=VALUE entry out of an env file (last wins, quotes stripped).
read_env() {
  local key="$1"
  local file="$2"
  [ -f "$file" ] || return 0
  local value
  value="$(sed -n "s/^${key}=\(.*\)$/\1/p" "$file" | tail -n 1)"
  value="${value%$'\r'}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

# First line of a command output, without a SIGPIPE-prone pipe.
first_line() {
  printf '%s\n' "$1" | sed -n '1p'
}

# ---------- State channel (DB) ----------

db_psql() {
  local sql="$1"
  printf '%s' "$sql" |
    docker exec -i "$DB_CONTAINER" sh -c \
      'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' 2>/dev/null
}

state_read() {
  [ -n "$DB_CONTAINER" ] || return 0
  db_psql "SELECT value FROM einstellungen WHERE key = '${STATE_KEY}' AND user_id IS NULL LIMIT 1;" || true
}

# Writes the current state as JSON into einstellungen (global row).
state_write() {
  local phase="$1"
  local ok="$2"
  local exit_code="$3"
  local message="${4:-}"
  local log_tail=""

  if [ -n "$LOG_FILE" ] && [ -f "$LOG_FILE" ]; then
    log_tail="$(tail -c "$LOG_MAX_CHARS" "$LOG_FILE" 2>/dev/null || true)"
  fi

  local json
  json=$(printf '{'
    printf '"phase":%s,' "$(jstr "$phase")"
    printf '"ok":%s,' "$ok"
    printf '"exitCode":%s,' "$(jnum "$exit_code")"
    printf '"requestedAt":%s,' "$(jstr "$REQUESTED_AT")"
    printf '"startedAt":%s,' "$(jstr "$STARTED_AT")"
    printf '"startedAtEpoch":%s,' "$(jnum "$STARTED_AT_EPOCH")"
    printf '"finishedAt":%s,' "$(jstr "$FINISHED_AT")"
    printf '"step":%s,' "$(jstr "$STEP")"
    printf '"message":%s,' "$(jstr "$message")"
    printf '"log":%s,' "$(jstr "$log_tail")"
    printf '"gitBefore":%s,' "$(jstr "$GIT_BEFORE")"
    printf '"gitAfter":%s,' "$(jstr "$GIT_AFTER")"
    printf '"versionBefore":%s,' "$(jstr "$VERSION_BEFORE")"
    printf '"versionAfter":%s,' "$(jstr "$VERSION_AFTER")"
    printf '"imageTag":%s,' "$(jstr "$IMAGE_TAG")"
    printf '"host":%s' "$(jstr "$HOSTNAME_VALUE")"
    printf '}')

  [ -n "$DB_CONTAINER" ] || return 0
  db_psql "INSERT INTO einstellungen (key, user_id, value, geaendert_am) VALUES ('${STATE_KEY}', NULL, '$(sql_escape "$json")', NOW()) ON CONFLICT (key) WHERE (user_id IS NULL) DO UPDATE SET value = EXCLUDED.value, geaendert_am = EXCLUDED.geaendert_am;" \
    >/dev/null 2>&1 || true
}

# Reads a single string field out of the state JSON.
state_field() {
  local json="$1"
  local key="$2"
  # grep exits 1 when the key is absent - that must not abort the script.
  printf '%s' "$json" | grep -o "\"${key}\":\"[^\"]*\"" | head -n 1 | cut -d '"' -f 4 || true
}

# Reads a single numeric field out of the state JSON.
state_number() {
  local json="$1"
  local key="$2"
  printf '%s' "$json" | grep -o "\"${key}\":-\{0,1\}[0-9]*" | head -n 1 | cut -d ':' -f 2 || true
}

# True when a running update is old enough that it can be considered dead.
# The age is compared as plain epoch seconds - no date parsing, so it works on
# every host (GNU date, busybox date, ...).
state_is_stale() {
  local started_epoch="$1"
  local max_age="${CASTEL_UPDATE_STALE_SEC:-1800}"
  [ -n "$started_epoch" ] || return 0
  local now_epoch
  now_epoch="$(date +%s)"
  [ $((now_epoch - started_epoch)) -gt "$max_age" ]
}

# ---------- Detection ----------

detect_containers() {
  local names
  names="$(docker ps --filter "label=com.docker.compose.service=db" --format '{{.Names}}' 2>/dev/null || true)"
  DB_CONTAINER="$(first_line "$names")"

  names="$(docker ps --filter "label=com.docker.compose.service=api" --format '{{.Names}}' 2>/dev/null || true)"
  API_CONTAINER="$(first_line "$names")"
}

# The compose checkout directory on the host. Docker compose v2 stores it in
# the `com.docker.compose.project.working_dir` label of every container.
detect_repo_dir() {
  if [ -n "${CASTEL_REPO_DIR:-}" ]; then
    printf '%s' "$CASTEL_REPO_DIR"
    return 0
  fi

  local dir=""
  dir="$(docker ps --filter "label=com.docker.compose.service=api" \
    --format '{{index .Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null | sed -n '1p' || true)"
  if [ -n "$dir" ]; then
    printf '%s' "$dir"
    return 0
  fi

  # Fallback: derive it from the config file label.
  local files
  files="$(docker ps --filter "label=com.docker.compose.service=api" \
    --format '{{index .Labels "com.docker.compose.project.config_files"}}' 2>/dev/null | sed -n '1p' || true)"
  if [ -n "$files" ]; then
    local first
    first="$(printf '%s' "$files" | cut -d ',' -f 1)"
    printf '%s' "$(dirname "$first")"
    return 0
  fi

  return 1
}

# The compose project name. Without it compose would derive a new name from
# the directory name and create a SECOND stack with fresh volumes.
detect_project_name() {
  local name
  name="$(docker ps --filter "label=com.docker.compose.service=api" \
    --format '{{index .Labels "com.docker.compose.project"}}' 2>/dev/null | sed -n '1p' || true)"
  printf '%s' "$name"
}

# The compose files that the running stack was created from.
detect_compose_files() {
  local files=""
  files="$(docker ps --filter "label=com.docker.compose.service=api" \
    --format '{{index .Labels "com.docker.compose.project.config_files"}}' 2>/dev/null | sed -n '1p' || true)"

  if [ -n "$files" ]; then
    local IFS=','
    local f
    for f in $files; do
      [ -n "$f" ] && COMPOSE_FILES+=("$f")
    done
  fi

  if [ "${#COMPOSE_FILES[@]}" -eq 0 ]; then
    COMPOSE_FILES=("$REPO_DIR/docker-compose.yml")
    if [ -f "$REPO_DIR/docker-compose.override.yml" ]; then
      COMPOSE_FILES+=("$REPO_DIR/docker-compose.override.yml")
    fi
  fi
}

# ---------- Preflight ----------

preflight() {
  command -v docker >/dev/null 2>&1 ||
    { echo "FEHLER: docker nicht im PATH" >&2; exit 10; }
  command -v git >/dev/null 2>&1 ||
    { echo "FEHLER: git nicht im PATH" >&2; exit 10; }
  docker compose version >/dev/null 2>&1 ||
    { echo "FEHLER: 'docker compose' (Plugin v2) nicht verfügbar" >&2; exit 10; }
  docker info >/dev/null 2>&1 ||
    { echo "FEHLER: Docker-Daemon nicht erreichbar" >&2; exit 10; }

  if [ -z "$REPO_DIR" ]; then
    echo "FEHLER: Pfad des Compose-Checkouts nicht ermittelbar." >&2
    echo "       Setze CASTEL_REPO_DIR (z. B. /srv/castel) oder starte das Skript" >&2
    echo "       im Verzeichnis des Checkouts." >&2
    exit 11
  fi
  [ -d "$REPO_DIR" ] ||
    { echo "FEHLER: '$REPO_DIR' existiert nicht" >&2; exit 11; }
  [ -f "$REPO_DIR/.env" ] ||
    { echo "FEHLER: keine .env in '$REPO_DIR' gefunden" >&2; exit 11; }

  local compose_ok=0
  local f
  for f in "${COMPOSE_FILES[@]}"; do
    [ -f "$f" ] && compose_ok=1
  done
  [ "$compose_ok" -eq 1 ] ||
    { echo "FEHLER: keine docker-compose.yml in '$REPO_DIR' gefunden" >&2; exit 11; }

  if [ -z "$PROJECT_NAME" ]; then
    echo "FEHLER: Compose-Projektname nicht ermittelbar (kein laufender api-Container)." >&2
    echo "       Startet der Stack aus einem anderen Verzeichnis, passt der Pfad nicht." >&2
    exit 11
  fi

  if [ -z "$DB_CONTAINER" ]; then
    echo "FEHLER: kein laufender db-Container gefunden - Status kann nicht gemeldet werden." >&2
    exit 11
  fi

  if [ "$SKIP_GIT" -eq 0 ]; then
    [ -d "$REPO_DIR/.git" ] ||
      { echo "FEHLER: '$REPO_DIR' ist kein Git-Checkout (kein .git)." >&2; exit 11; }
    if [ "$ALLOW_DIRTY" -eq 0 ]; then
      local dirty
      dirty="$(git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" status --porcelain 2>/dev/null || true)"
      if [ -n "$dirty" ]; then
        echo "FEHLER: lokale Änderungen im Checkout - Update abgebrochen." >&2
        echo "       Committe sie oder starte mit --allow-dirty." >&2
        exit 12
      fi
    fi
  fi
}

# ---------- Steps ----------

git_pull() {
  [ "$SKIP_GIT" -eq 1 ] && {
    log_line "==> git pull übersprungen (--skip-git)"
    return 0
  }

  STEP="git-pull"
  log_line "==> git pull (${REPO_DIR})"

  local branch
  branch="$(git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"

  if [ "$branch" = "HEAD" ]; then
    git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" fetch --prune origin
    git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" merge --ff-only FETCH_HEAD
  else
    git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" pull --ff-only origin "$branch"
  fi

  GIT_AFTER="$(git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  log_line "    git: ${GIT_BEFORE:-?} -> ${GIT_AFTER:-?}"
}

compose() {
  local args=()
  local f
  for f in "${COMPOSE_FILES[@]}"; do
    args+=(-f "$f")
  done
  docker compose \
    --project-name "$PROJECT_NAME" \
    --project-directory "$REPO_DIR" \
    "${args[@]}" "$@"
}

compose_pull() {
  STEP="compose-pull"
  log_line "==> docker compose pull (Projekt: ${PROJECT_NAME})"
  compose pull
}

compose_up() {
  STEP="compose-up"
  log_line "==> docker compose up -d (Projekt: ${PROJECT_NAME})"
  compose up -d --remove-orphans
}

# Waits until the api container is healthy again (its healthcheck calls
# /api/healthz) and reports the container log when it does not come up.
health_check() {
  STEP="health"
  log_line "==> Health-Check (Timeout ${HEALTH_TIMEOUT_SEC}s)"

  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  local status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$API_CONTAINER" 2>/dev/null || echo missing)"
    case "$status" in
      healthy)
        log_line "    api-Container ist healthy"
        return 0
        ;;
      unhealthy)
        log_line "    api-Container ist unhealthy - letzte Logzeilen:"
        docker logs --tail 30 "$API_CONTAINER" 2>&1 | sed 's/^/      /' || true
        return 1
        ;;
      exited | dead)
        log_line "    api-Container ist beendet - letzte Logzeilen:"
        docker logs --tail 30 "$API_CONTAINER" 2>&1 | sed 's/^/      /' || true
        return 1
        ;;
    esac
    sleep "$HEALTH_POLL_SEC"
  done

  log_line "    Timeout - letzter Status: ${status:-unknown}"
  docker logs --tail 30 "$API_CONTAINER" 2>&1 | sed 's/^/      /' || true
  return 1
}

purge_images() {
  [ "$SKIP_PURGE" -eq 1 ] && {
    log_line "==> Image-Purge übersprungen (--skip-purge)"
    return 0
  }

  STEP="purge"
  log_line "==> docker image prune (dangling)"
  docker image prune -f

  log_line "==> docker image prune -a (ungenutzt, älter als ${PURGE_UNTIL})"
  docker image prune -a -f --filter "until=${PURGE_UNTIL}"

  if [ "$PURGE_BUILDER" -eq 1 ]; then
    log_line "==> docker builder prune"
    docker builder prune -f
  fi
}

# ---------- Error handling ----------

on_error() {
  local exit_code=$?
  local line="${1:-unknown}"
  set +e
  FINISHED_AT="$(now_iso)"
  MESSAGE="Fehler in Zeile ${line} (Exit-Code ${exit_code})"
  log_line "FEHLER: ${MESSAGE}"
  state_write "failed" "false" "$exit_code" "$MESSAGE"
  exit "$exit_code"
}

# ---------- Main ----------

main() {
  parse_args "$@"

  LOG_FILE="$(mktemp -t castel-update.XXXXXX)"
  trap 'rm -f "$LOG_FILE"' EXIT

  REQUESTED_AT="$(now_iso)"

  detect_containers

  if [ "$ONLY_IF_REQUESTED" -eq 1 ]; then
    local state
    state="$(state_read)"
    local phase=""
    phase="$(state_field "$state" "phase")"
    if [ "$phase" != "requested" ]; then
      # A "running" state means another attempt is in flight. It is only
      # retried when it is stale (the runner died), otherwise the timer would
      # start a second update while the first one is still working.
      if [ "$phase" = "running" ]; then
        local started_epoch
        started_epoch="$(state_number "$state" "startedAtEpoch")"
        if state_is_stale "$started_epoch"; then
          log_line "Vorheriger Update-Lauf ist veraltet - neuer Versuch."
        else
          exit 0
        fi
      else
        # Nothing to do - stay quiet, the timer runs every few seconds.
        exit 0
      fi
    fi
    local requested
    requested="$(state_field "$state" "requestedAt")"
    [ -n "$requested" ] && REQUESTED_AT="$requested"
  fi

  # Only one update at a time.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      log_line "Update läuft bereits (Lock: ${LOCK_FILE}) - Abbruch."
      exit 0
    fi
  else
    local lock_dir="${LOCK_FILE}.d"
    if ! mkdir "$lock_dir" 2>/dev/null; then
      log_line "Update läuft bereits (Lock: ${lock_dir}) - Abbruch."
      exit 0
    fi
    trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
  fi

  trap 'on_error $LINENO' ERR

  log_line "==> castel Update gestartet (Host: ${HOSTNAME_VALUE})"

  REPO_DIR="$(detect_repo_dir || true)"
  PROJECT_NAME="$(detect_project_name)"
  detect_compose_files

  log_line "    Checkout: ${REPO_DIR:-nicht ermittelbar}"
  log_line "    Projekt:  ${PROJECT_NAME:-nicht ermittelbar}"
  log_line "    Compose:  ${COMPOSE_FILES[*]:-keine}"

  preflight

  IMAGE_TAG="$(read_env IMAGE_TAG "$REPO_DIR/.env")"
  [ -n "$IMAGE_TAG" ] || IMAGE_TAG="latest"

  GIT_BEFORE="$(git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
  VERSION_BEFORE="$(read_version "$REPO_DIR/package.json")"

  STARTED_AT="$(now_iso)"
  STARTED_AT_EPOCH="$(date +%s)"
  PHASE="running"
  state_write "running" "null" "" "Update läuft."

  git_pull

  VERSION_AFTER="$(read_version "$REPO_DIR/package.json")"
  if [ -z "$VERSION_AFTER" ]; then
    VERSION_AFTER="$VERSION_BEFORE"
  fi

  compose_pull
  compose_up
  health_check

  # The api container was recreated - its name stays stable, but the health
  # status has to be read again.
  detect_containers

  purge_images

  FINISHED_AT="$(now_iso)"
  PHASE="done"
  EXIT_CODE="0"
  OK_JSON="true"
  STEP=""
  MESSAGE="Update abgeschlossen."
  log_line "==> Update abgeschlossen."
  state_write "done" "true" "0" "$MESSAGE"
  exit 0
}

main "$@"
