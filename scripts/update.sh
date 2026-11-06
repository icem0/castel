#!/usr/bin/env bash
#
# castel update runner (host side).
#
# Runs the complete stack update:
#   1. git pull --ff-only     - only when the checkout is a clean git repo
#   2. docker compose pull    - new images from GHCR (with retries)
#   3. docker compose up -d   - recreate the containers that changed
#   4. health check           - the api container must become healthy again
#   5. docker image prune     - remove dangling + unused old images
#
# DESIGNED TO WORK IN MANY ENVIRONMENTS
#   The runner does not assume a git checkout, a .env file or a specific
#   compose version. It degrades gracefully:
#     - no .git / no git binary  -> git step is skipped automatically
#     - no .env                  -> warns and continues (env may come from the
#                                   orchestrator, e.g. Arcane/Variables)
#     - no db container          -> update runs, progress is only logged
#     - docker compose v1        -> falls back to `docker-compose`
#   It finds the stack from the compose labels of the running containers
#   (works for stacks deployed by Arcane, Portainer, plain `docker compose`,
#   systemd, ...), with `docker compose ls` and the current directory as
#   additional fallbacks.
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
#   them while the stack restarts. Without a reachable db the runner still
#   updates the stack, it just cannot report progress back.
#
# USAGE
#   ./scripts/update.sh                  run the update right now
#   ./scripts/update.sh --if-requested   run only if the PWA requested one
#   sudo ./scripts/update.sh             when the docker socket needs root
#
# OPTIONS
#   --if-requested      only run when the PWA requested an update
#   --skip-git          do not touch git (images only)
#   --skip-purge        do not remove any images
#   --no-builder-prune  keep the docker build cache
#   --allow-dirty       proceed even with uncommitted changes in the checkout
#   --purge-until X     age filter for "unused" images (default 168h = 7 days)
#
# ENVIRONMENT
#   CASTEL_REPO_DIR            absolute path of the Castel checkout on the host
#                              e.g. CASTEL_REPO_DIR=/var/lib/docker/volumes/arcane_arcane-data/_data/projects/castel
#                              Without it, the script tries to detect the
#                              project directory from compose labels or the
#                              current working directory.
#   CASTEL_PROJECT_NAME        explicit compose project name
#   CASTEL_PROJECT_DIR         alias for the project directory (fallback)
#   CASTEL_HEALTH_TIMEOUT_SEC  seconds to wait for a healthy api (default 180)
#   CASTEL_PULL_RETRIES        attempts for `docker compose pull` (default 3)
#   CASTEL_PULL_RETRY_DELAY    seconds between pull attempts (default 5)
#   CASTEL_PURGE_UNTIL         age filter for unused images (default 168h)
#
set -Eeuo pipefail

# ---------- Configuration ----------

STATE_KEY="server.updateState"
LOG_MAX_CHARS=32000
HEALTH_TIMEOUT_SEC="${CASTEL_HEALTH_TIMEOUT_SEC:-180}"
HEALTH_POLL_SEC="${CASTEL_HEALTH_POLL_SEC:-3}"
PURGE_UNTIL="${CASTEL_PURGE_UNTIL:-168h}"
PULL_RETRIES="${CASTEL_PULL_RETRIES:-3}"
PULL_RETRY_DELAY="${CASTEL_PULL_RETRY_DELAY:-5}"
LOCK_FILE="${CASTEL_UPDATE_LOCK:-/tmp/castel-update.lock}"

# ---------- Runtime state ----------

REPO_DIR=""
PROJECT_NAME=""
COMPOSE_FILES=()
COMPOSE_CLI=()
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

STEP=""
MESSAGE=""

# ---------- Options ----------

ONLY_IF_REQUESTED=0
SKIP_GIT=0
SKIP_PURGE=0
ALLOW_DIRTY=0
PURGE_BUILDER=1

usage() {
  sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'
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

# ---------- Docker / compose detection ----------

# Chooses the compose CLI once. Supports the v2 plugin and the legacy
# `docker-compose` binary so the runner works on older hosts too.
detect_compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_CLI=(docker compose)
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CLI=(docker-compose)
    return 0
  fi
  COMPOSE_CLI=()
}

# Reads a label from running containers, optionally limited to the detected
# project and one service. Returns one value per line.
ps_label() {
  local key="$1"
  local service="${2:-}"
  local args=(--format "{{.Label \"$key\"}}")
  if [ -n "$PROJECT_NAME" ]; then
    args=(--filter "label=com.docker.compose.project=$PROJECT_NAME" "${args[@]}")
  fi
  if [ -n "$service" ]; then
    args+=(--filter "label=com.docker.compose.service=$service")
  fi
  docker ps "${args[@]}" 2>/dev/null | sed '/^[[:space:]]*$/d' || true
}

# Container names for a service label (optionally limited to the project).
ps_names() {
  local service="$1"
  local args=(--filter "label=com.docker.compose.service=$service" --format '{{.Names}}')
  if [ -n "$PROJECT_NAME" ]; then
    args=(--filter "label=com.docker.compose.project=$PROJECT_NAME" "${args[@]}")
  fi
  docker ps "${args[@]}" 2>/dev/null | sed '/^[[:space:]]*$/d' || true
}

# The compose project name. Prefers explicit configuration, then the label of
# any running container (works for Arcane/Portainer/plain compose), then a
# project discovered via `docker compose ls`.
detect_project_name() {
  if [ -n "${CASTEL_PROJECT_NAME:-}" ]; then
    printf '%s' "$CASTEL_PROJECT_NAME"
    return 0
  fi
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s' "$COMPOSE_PROJECT_NAME"
    return 0
  fi

  local names=""
  names="$(docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null |
    sed '/^[[:space:]]*$/d' | sort -u || true)"

  local pick=""
  if [ -n "$names" ]; then
    pick="$(printf '%s\n' "$names" | grep -i 'castel' | head -n 1 || true)"
    if [ -z "$pick" ] && [ "$(printf '%s\n' "$names" | wc -l | tr -d ' ')" = "1" ]; then
      pick="$names"
    fi
  fi

  if [ -z "$pick" ] && [ "${#COMPOSE_CLI[@]}" -gt 0 ]; then
    local ls_json=""
    ls_json="$("${COMPOSE_CLI[@]}" ls --format json 2>/dev/null || true)"
    if [ -n "$ls_json" ]; then
      pick="$(printf '%s' "$ls_json" |
        grep -o '"Name"[[:space:]]*:[[:space:]]*"[^"]*"' |
        sed 's/.*"\([^"]*\)"$/\1/' | grep -i 'castel' | head -n 1 || true)"
      if [ -z "$pick" ]; then
        pick="$(printf '%s' "$ls_json" |
          grep -o '"Name"[[:space:]]*:[[:space:]]*"[^"]*"' |
          sed 's/.*"\([^"]*\)"$/\1/' | head -n 1 || true)"
      fi
    fi
  fi

  printf '%s' "$pick"
}

# Finds the db and api containers. Both are optional: a missing db only
# disables progress reporting, a missing api only simplifies the health check.
detect_containers() {
  DB_CONTAINER="${CASTEL_DB_CONTAINER:-}"
  if [ -z "$DB_CONTAINER" ]; then
    DB_CONTAINER="$(first_line "$(ps_names db)")"
  fi
  if [ -z "$DB_CONTAINER" ]; then
    DB_CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' 2>/dev/null |
      awk -F'\t' 'tolower($2) ~ /postgres/ {print $1; exit}' || true)"
  fi

  API_CONTAINER="${CASTEL_API_CONTAINER:-}"
  if [ -z "$API_CONTAINER" ]; then
    API_CONTAINER="$(first_line "$(ps_names api)")"
  fi
  return 0
}

# The compose checkout directory on the host. Docker compose v2 stores it in
# the `com.docker.compose.project.working_dir` label of every container.
detect_repo_dir() {
  if [ -n "${CASTEL_REPO_DIR:-}" ]; then
    printf '%s' "$CASTEL_REPO_DIR"
    return 0
  fi
  if [ -n "${REPO_DIR:-}" ]; then
    printf '%s' "$REPO_DIR"
    return 0
  fi
  if [ -n "${CASTEL_PROJECT_DIR:-}" ]; then
    printf '%s' "$CASTEL_PROJECT_DIR"
    return 0
  fi

  local dir=""
  dir="$(first_line "$(ps_label 'com.docker.compose.project.working_dir')")"
  if [ -n "$dir" ]; then
    printf '%s' "$dir"
    return 0
  fi

  # Fallback: derive it from the config file label.
  local files=""
  files="$(first_line "$(ps_label 'com.docker.compose.project.config_files')")"
  if [ -n "$files" ]; then
    local first="${files%%,*}"
    if [ -n "$first" ]; then
      printf '%s' "$(dirname "$first")"
      return 0
    fi
  fi

  # Last resort: the current directory, when it contains a compose file.
  local c
  for c in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
    if [ -f "$c" ]; then
      printf '%s' "$(pwd)"
      return 0
    fi
  done

  return 1
}

# The compose files that the running stack was created from. Falls back to the
# usual filenames inside the project directory.
detect_compose_files() {
  COMPOSE_FILES=()

  local files=""
  files="$(first_line "$(ps_label 'com.docker.compose.project.config_files')")"
  if [ -n "$files" ]; then
    local IFS=','
    local f
    for f in $files; do
      [ -n "$f" ] && COMPOSE_FILES+=("$f")
    done
    unset IFS
  fi

  if [ "${#COMPOSE_FILES[@]}" -eq 0 ] && [ -n "$REPO_DIR" ]; then
    local c
    for c in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
      [ -f "$REPO_DIR/$c" ] && COMPOSE_FILES+=("$REPO_DIR/$c")
    done
    for c in compose.override.yaml compose.override.yml docker-compose.override.yml docker-compose.override.yaml; do
      [ -f "$REPO_DIR/$c" ] && COMPOSE_FILES+=("$REPO_DIR/$c")
    done
  fi
  return 0
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

# ---------- Preflight ----------

preflight() {
  command -v docker >/dev/null 2>&1 ||
    { echo "FEHLER: docker nicht im PATH" >&2; exit 10; }

  if [ "${#COMPOSE_CLI[@]}" -eq 0 ]; then
    echo "FEHLER: weder 'docker compose' (v2) noch 'docker-compose' (v1) verfügbar" >&2
    exit 10
  fi

  docker info >/dev/null 2>&1 ||
    { echo "FEHLER: Docker-Daemon nicht erreichbar (evtl. mit sudo starten)" >&2; exit 10; }

  # Resolve the project directory from the compose files if still unknown.
  if [ -z "$REPO_DIR" ] && [ "${#COMPOSE_FILES[@]}" -gt 0 ]; then
    REPO_DIR="$(dirname "${COMPOSE_FILES[0]}")"
  fi

  if [ -z "$REPO_DIR" ]; then
    echo "FEHLER: Pfad des Compose-Projekts nicht ermittelbar." >&2
    echo "       Setze CASTEL_REPO_DIR (z. B. /opt/docker/castel) oder starte das" >&2
    echo "       Skript im Verzeichnis des Compose-Projekts." >&2
    exit 11
  fi
  [ -d "$REPO_DIR" ] ||
    { echo "FEHLER: '$REPO_DIR' existiert nicht" >&2; exit 11; }

  # At least one compose file must exist. If none is known, the project dir
  # must contain a standard compose file (compose auto-detects it).
  if [ "${#COMPOSE_FILES[@]}" -eq 0 ]; then
    local found=0 c
    for c in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
      [ -f "$REPO_DIR/$c" ] && found=1
    done
    [ "$found" -eq 1 ] ||
      { echo "FEHLER: keine Compose-Datei in '$REPO_DIR' gefunden" >&2; exit 11; }
  else
    local any=0 f
    for f in "${COMPOSE_FILES[@]}"; do
      [ -f "$f" ] && any=1
    done
    [ "$any" -eq 1 ] ||
      { echo "FEHLER: keine der Compose-Dateien existiert (${COMPOSE_FILES[*]})" >&2; exit 11; }
  fi

  # The project name is required so we do not create a SECOND stack with fresh
  # volumes. Fall back to the directory name (same default compose would use).
  if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME="$(basename "$REPO_DIR")"
    log_line "    WARNUNG: Compose-Projektname nicht ermittelbar - verwende '$PROJECT_NAME'."
    log_line "             Bei abweichendem Namen CASTEL_PROJECT_NAME setzen."
  fi

  # .env is optional: the orchestrator may inject the variables instead. We
  # still load it when present (compose does that automatically).
  if [ ! -f "$REPO_DIR/.env" ]; then
    log_line "    HINWEIS: keine .env in '$REPO_DIR' - fahre fort (Variablen kommen ggf. von außen)."
  fi

  # git is optional: Arcane/Portainer deployments are often plain folders, not
  # git checkouts. In that case the source already is what it is - only images
  # need updating.
  if [ "$SKIP_GIT" -eq 0 ]; then
    if ! command -v git >/dev/null 2>&1; then
      SKIP_GIT=1
      log_line "    HINWEIS: git nicht im PATH - git-Schritt wird übersprungen."
    elif [ ! -d "$REPO_DIR/.git" ]; then
      SKIP_GIT=1
      log_line "    HINWEIS: kein Git-Checkout in '$REPO_DIR' - git-Schritt wird übersprungen."
    elif [ "$ALLOW_DIRTY" -eq 0 ]; then
      local dirty
      dirty="$(git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" status --porcelain 2>/dev/null || true)"
      if [ -n "$dirty" ]; then
        echo "FEHLER: lokale Änderungen im Checkout - Update abgebrochen." >&2
        echo "       Committe sie oder starte mit --allow-dirty." >&2
        exit 12
      fi
    fi
  fi

  # The status channel is nice-to-have, not a hard requirement.
  if [ -z "$DB_CONTAINER" ]; then
    log_line "    HINWEIS: kein db-Container gefunden - Fortschritt wird nicht in die DB geschrieben."
  fi
}

# ---------- Steps ----------

git_pull() {
  [ "$SKIP_GIT" -eq 1 ] && {
    log_line "==> git pull übersprungen"
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
  local project_args=()
  local file_args=()
  local f

  [ -n "$PROJECT_NAME" ] && project_args+=(--project-name "$PROJECT_NAME")
  [ -n "$REPO_DIR" ] && project_args+=(--project-directory "$REPO_DIR")
  for f in "${COMPOSE_FILES[@]}"; do
    file_args+=(-f "$f")
  done

  "${COMPOSE_CLI[@]}" \
    "${project_args[@]+"${project_args[@]}"}" \
    "${file_args[@]+"${file_args[@]}"}" "$@"
}

compose_pull() {
  STEP="compose-pull"
  log_line "==> docker compose pull (Projekt: ${PROJECT_NAME})"

  local attempt=1
  while :; do
    if compose pull; then
      return 0
    fi
    if [ "$attempt" -ge "$PULL_RETRIES" ]; then
      log_line "FEHLER: docker compose pull nach ${attempt} Versuchen fehlgeschlagen."
      log_line "        Bei privaten Images ggf. 'docker login ghcr.io' auf dem Host ausführen."
      return 1
    fi
    log_line "    Pull fehlgeschlagen - neuer Versuch in ${PULL_RETRY_DELAY}s (${attempt}/${PULL_RETRIES})."
    attempt=$((attempt + 1))
    sleep "$PULL_RETRY_DELAY"
  done
}

compose_up() {
  STEP="compose-up"
  log_line "==> docker compose up -d (Projekt: ${PROJECT_NAME})"
  compose up -d --remove-orphans
}

# Entfernt alle Images der castel-Repositories, die nicht das aktuell
# konfigurierte IMAGE_TAG tragen. Nach `docker compose pull` ist :latest (oder
# der konfigurierte Tag) das neue Image; alle anderen Tags (z. B. :v1.0.83,
# :pre-release, :<sha>) zeigen auf das alte Image und würden als verwaiste
# (untagged) Images zurückbleiben, weil sie weder "dangling" noch älter als
# PURGE_UNTIL sind.
remove_superseded_images() {
  local keep_tag="${IMAGE_TAG:-latest}"
  local repo
  for repo in ghcr.io/icem0/castel-api ghcr.io/icem0/castel-pwa; do
    docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' 2>/dev/null \
      | grep "^${repo}:" \
      | grep -v ":${keep_tag}$" \
      | awk '{print $2}' \
      | xargs -r docker rmi -f 2>/dev/null || true
  done
}

# Waits until the api container is healthy again (its healthcheck calls
# /api/healthz) and reports the container log when it does not come up. When
# no api container can be identified the check is skipped.
health_check() {
  STEP="health"

  if [ -z "$API_CONTAINER" ]; then
    log_line "==> Health-Check übersprungen (kein api-Container ermittelbar)"
    return 0
  fi

  log_line "==> Health-Check (Timeout ${HEALTH_TIMEOUT_SEC}s)"

  local deadline=$((SECONDS + HEALTH_TIMEOUT_SEC))
  local status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      "$API_CONTAINER" 2>/dev/null || echo missing)"
    case "$status" in
      healthy | running)
        log_line "    api-Container ist ${status}"
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

# Entfernt ungetagte (dangling) Images. Läuft sowohl im Erfolgs- als auch im
# Fehlerpfad, sodass ein abgebrochenes Pull/Retag keine <none>:<none> Images
# zurücklässt.
purge_dangling() {
  log_line "==> docker image prune (dangling / ungetagt)"
  docker image prune -f || true
}

purge_images() {
  [ "$SKIP_PURGE" -eq 1 ] && {
    log_line "==> Image-Purge übersprungen (--skip-purge)"
    return 0
  }

  STEP="purge"
  purge_dangling

  log_line "==> docker image prune -a (ungenutzt, älter als ${PURGE_UNTIL})"
  docker image prune -a -f --filter "until=${PURGE_UNTIL}" || true

  if [ "$PURGE_BUILDER" -eq 1 ]; then
    log_line "==> docker builder prune"
    docker builder prune -f || true
  fi
}

# ---------- Error handling ----------

on_error() {
  local exit_code=$?
  local line="${1:-unknown}"
  set +e
  FINISHED_AT="$(now_iso)"
  MESSAGE="Fehler in Schritt '${STEP:-unbekannt}' (Zeile ${line}, Exit-Code ${exit_code})"
  log_line "FEHLER: ${MESSAGE}"
  # Auch bei einem fehlgeschlagenen Lauf die ungetagten (dangling) Images
  # aufräumen, die durch einen abgebrochenen Pull/Retag zurückbleiben.
  purge_dangling || true
  state_write "failed" "false" "$exit_code" "$MESSAGE"
  exit "$exit_code"
}

# ---------- Main ----------

main() {
  parse_args "$@"

  LOG_FILE="$(mktemp -t castel-update.XXXXXX)"
  trap 'rm -f "$LOG_FILE"' EXIT

  REQUESTED_AT="$(now_iso)"

  detect_compose_cmd
  PROJECT_NAME="$(detect_project_name)"
  detect_containers

  if [ "$ONLY_IF_REQUESTED" -eq 1 ]; then
    if [ -z "$DB_CONTAINER" ]; then
      echo "FEHLER: kein db-Container erreichbar - Update-Anforderung kann nicht aus der DB gelesen werden." >&2
      echo "        Prüfen Sie, ob der Postgres-Container läuft und erreichbar ist." >&2
      exit 20
    fi
    local state
    state="$(state_read)"
    if [ -z "$state" ]; then
      echo "FEHLER: keine Update-Anforderung in der DB gefunden (einstellungen: key='server.updateState')." >&2
      echo "        Führen Sie den Update-Request in der PWA (Einstellungen → Entwicklung) aus." >&2
      exit 21
    fi
    local phase=""
    phase="$(state_field "$state" "phase")"
    if [ "$phase" != "requested" ]; then
      if [ "$phase" = "running" ]; then
        local started_epoch
        started_epoch="$(state_number "$state" "startedAtEpoch")"
        if state_is_stale "$started_epoch"; then
          log_line "Vorheriger Update-Lauf ist veraltet - neuer Versuch."
        else
          echo "FEHLER: ein Update läuft bereits (phase=running, gestartet am ${started_epoch:-unbekannt})." >&2
          echo "        Warten Sie, bis dieser abgeschlossen ist, oder setzen Sie den Status zurück." >&2
          exit 22
        fi
      else
        echo "FEHLER: keine offene Update-Anforderung (phase='${phase:-nichts gesetzt}')." >&2
        echo "        Führen Sie den Update-Request in der PWA (Einstellungen → Entwicklung) aus." >&2
        exit 23
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
  state_write "running" "null" "" "Update läuft."

  git_pull

  VERSION_AFTER="$(read_version "$REPO_DIR/package.json")"
  if [ -z "$VERSION_AFTER" ]; then
    VERSION_AFTER="$VERSION_BEFORE"
  fi

  compose_pull

  # Alte Container stoppen, damit ihre Images freigegeben werden können, und
  # alle veralteten Images entfernen (außer dem aktuellen IMAGE_TAG), sodass
  # nach dem Update kein altes / untagged Image zurückbleibt.
  docker compose stop api pwa 2>/dev/null || true
  remove_superseded_images

  compose_up
  health_check

  # The api container was recreated - its name stays stable, but the health
  # status has to be read again.
  detect_containers

  purge_images

  FINISHED_AT="$(now_iso)"
  STEP=""
  MESSAGE="Update abgeschlossen."
  log_line "==> Update abgeschlossen."
  state_write "done" "true" "0" "$MESSAGE"
  exit 0
}

main "$@"
