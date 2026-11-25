#!/usr/bin/env bash
#
# Interactive installer for the host-side update service ("the webhook system").
#
# The PWA can only MARK an update request; something on the host must EXECUTE
# scripts/update.sh. This installer asks where the stack runs and installs that
# runner exactly where it belongs, so the admin does not have to piece the
# systemd/webhook setup together by hand:
#
#   variant timer     systemd-Timer on the host, calls scripts/update.sh
#                     --if-requested every minute. No extra HTTP service.
#   variant webhook   adnanh/webhook receiver on the host (HTTP on a port),
#                     calls scripts/update-hook.sh.
#   variant container adnanh/webhook receiver inside a small container
#                     (docker run with socket + checkout mounts, the port
#                     published so host.docker.internal reaches it).
#
# Idempotent: an existing UPDATE_WEBHOOK_TOKEN is kept, the compose file only
# gets touched when something is missing, and --dry-run prints every action
# without writing anything. Nothing is deleted; changed files keep a
# `.castel-bak` copy beside them.
#
# USAGE
#   sudo ./scripts/webhook-setup.sh                     interactive
#   ./scripts/webhook-setup.sh --help                   options
#   ./scripts/webhook-setup.sh --variant timer --repo-dir /srv/castel --dry-run
#
# OPTIONS
#   --variant timer|webhook|container  runner to install (default: timer)
#   --repo-dir PATH                    checkout that holds docker-compose.yml
#   --container-name NAME              api container name (default: detected)
#   --project-name NAME                compose project name (default: detected)
#   --compose-file PATH                compose file (default: detected)
#   --pwa-port N                       published PWA port (default: from .env)
#   --webhook-port N                   port for variant webhook/container
#   --token VALUE                      shared secret (default: generated once)
#   --env-file PATH                    .env to write into (default: <repo>/.env)
#   --patch-compose                    patch compose: extra_hosts + PWA port
#   --skip-runner                      only .env + compose, no runner installed
#   --no-prompt                        use flags/env, never ask
#   --dry-run                          print actions, change nothing
#   --help                             show this help
#
# ENVIRONMENT (used when --no-prompt, flags win over env)
#   CASTEL_REPO_DIR CASTEL_PROJECT_NAME CASTEL_CONTAINER_NAME
#   PWA_PORT WEBHOOK_PORT UPDATE_WEBHOOK_TOKEN

set -Eeuo pipefail

# ---------- Options ----------

VARIANT="${CASTEL_WV_VARIANT:-timer}"
REPO_DIR="${CASTEL_REPO_DIR:-}"
PROJECT_NAME="${CASTEL_PROJECT_NAME:-}"
CONTAINER_NAME="${CASTEL_CONTAINER_NAME:-}"
COMPOSE_FILE="${CASTEL_COMPOSE_FILE:-}"
ENV_FILE=""
PWA_PORT="${PWA_PORT:-}"
WEBHOOK_PORT="${WEBHOOK_PORT:-9000}"
TOKEN="${UPDATE_WEBHOOK_TOKEN:-}"
PATCH_COMPOSE=0
SKIP_RUNNER=0
NO_PROMPT=0
DRY_RUN=0
WHERE=""

usage() {
  awk 'NR == 1 { next } /^set -Eeuo/ { exit } { sub(/^# ?/, ""); print }' "$0"
}

while (($#)); do
  case "$1" in
    --variant) VARIANT="$2"; shift 2 ;;
    --variant=*) VARIANT="${1#*=}"; shift ;;
    --repo-dir) REPO_DIR="$2"; shift 2 ;;
    --repo-dir=*) REPO_DIR="${1#*=}"; shift ;;
    --project-name) PROJECT_NAME="$2"; shift 2 ;;
    --container-name) CONTAINER_NAME="$2"; shift 2 ;;
    --compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    --pwa-port) PWA_PORT="$2"; shift 2 ;;
    --webhook-port) WEBHOOK_PORT="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --patch-compose) PATCH_COMPOSE=1; shift ;;
    --skip-runner) SKIP_RUNNER=1; shift ;;
    --no-prompt) NO_PROMPT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1"; exit 2 ;;
  esac
done

case "$VARIANT" in
  timer | webhook | container) ;;
  *) printf 'unknown variant: %s (timer|webhook|container)\n' "$VARIANT"; exit 2 ;;
esac

# ---------- Helpers ----------

SUDO=()
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  else
    printf 'not root and no sudo found - run the script as root.\n'
    exit 1
  fi
fi

say() { printf '%s\n' "$*"; }
say_i() { printf '  -> %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

ask() { # ask <var> <label> <default>
  local -n out="$1"
  local label="$2" def="$3" reply
  if [ -n "$out" ]; then
    say_i "$label: $out"
    return
  fi
  if [ "$NO_PROMPT" = 1 ]; then
    out="$def"
    return
  fi
  printf '%s [%s]: ' "$label" "$def"
  read -r reply || reply=""
  out="${reply:-$def}"
}

ask_choice() { # ask_choice <var> <label> <default> <options...>
  local -n out="$1"
  local label="$2" def="$3"
  shift 3
  local opts=("$@") reply o
  if [ -n "$out" ]; then
    for o in "${opts[@]}"; do
      if [ "$out" = "$o" ]; then say_i "$label: $out"; return; fi
    done
  fi
  if [ "$NO_PROMPT" = 1 ]; then out="$def"; return; fi
  while :; do
    printf '%s [%s] (%s): ' "$label" "$def" "${opts[*]}"
    read -r reply || reply=""
    reply="${reply:-$def}"
    for o in "${opts[@]}"; do
      if [ "$reply" = "$o" ]; then out="$reply"; return; fi
    done
    warn "choose one of: ${opts[*]}"
  done
}

confirm() { # confirm <label> <default y|n> -> exit 0 on yes
  local label="$1" def="${2:-n}" reply
  if [ "$NO_PROMPT" = 1 ]; then reply="$def"; else
    printf '%s [%s] (y/n): ' "$label" "$def"
    read -r reply || reply=""
    reply="${reply:-$def}"
  fi
  case "$reply" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

run() { # run <label> <cmd...>
  local label="$1"
  shift
  if [ "$DRY_RUN" = 1 ]; then
    say_i "[dry-run] $label: $*"
    return
  fi
  say_i "$label"
  "$@"
}

write_file() { # write_file <path> - body on stdin
  local path="$1"
  if [ "$DRY_RUN" = 1 ]; then
    say_i "[dry-run] would write $path:"
    sed 's/^/     | /'
    return
  fi
  if [ -f "$path" ]; then
    "${SUDO[@]}" cp "$path" "$path.castel-bak"
    say_i "backup kept: $path.castel-bak"
  fi
  local dir
  dir="$(dirname "$path")"
  if [ ! -d "$dir" ]; then
    "${SUDO[@]}" mkdir -p "$dir"
    say_i "created folder: $dir"
  fi
  "${SUDO[@]}" tee "$path" >/dev/null
}

docker_available=0
command -v docker >/dev/null 2>&1 && docker_available=1

detect_container_names() {
  [ "$docker_available" = 1 ] || return
  docker ps --format '{{.Names}}' 2>/dev/null | grep -i castel | head -5 || true
}

detect_project_name() {
  [ "$docker_available" = 1 ] || return
  docker ps --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null |
    grep -v '^$' | sort -u | head -1 || true
}

detect_repo_dir() {
  [ "$docker_available" = 1 ] || return
  docker ps --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null |
    grep -v '^$' | sort -u | head -1 || true
}

detect_compose_file() {
  [ -n "$REPO_DIR" ] || return
  local f
  for f in docker-compose.yml compose.yml docker-compose.yaml compose.yaml; do
    if [ -f "$REPO_DIR/$f" ]; then printf '%s\n' "$REPO_DIR/$f"; return; fi
  done
}

env_get() { # env_get <key> -> value (empty when missing/leer)
  local file="${ENV_FILE:-}"
  [ -n "$file" ] && [ -f "$file" ] || return
  grep -m1 "^$1=" "$file" 2>/dev/null | cut -d= -f2- || true
}

env_set() { # env_set <key> <value> - an existing non-empty value is kept
  local key="$1" value="$2" file="$ENV_FILE" current
  if [ ! -f "$file" ]; then
    warn "no .env at $file - set $key there manually"
    return
  fi
  current="$(env_get "$key")"
  if [ -n "$current" ]; then
    say_i "$key already in $file (kept, masked ${current:0:4}***)"
    return
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say_i "[dry-run] would write $key into $file"
    return
  fi
  if grep -q "^$key=" "$file"; then
    "${SUDO[@]}" sed -i "s|^$key=.*|$key=$value|" "$file"
    say_i "$key written into $file (empty assignment replaced)"
  else
    printf '%s=%s\n' "$key" "$value" | "${SUDO[@]}" tee -a "$file" >/dev/null
    say_i "$key written into $file"
  fi
}

# ---------- Questionnaire ----------

say 'castel Update-Service installer'
say '================================'
say 'Answers with [] are the default. Leer values derive what the script can'
say 'detect. Nothing gets deleted; changed files keep a .castel-bak copy.'
say

say 'Where does the stack (castel-api) run?'
say '  1 = on this machine (Debian host, Docker here) - bare host setup'
say '  2 = on this machine inside Docker containers (you give the name)'
say '  3 = on another machine (SSH) - only files get prepared here'
ask_choice WHERE 'Where' 1 1 2 3
case "$WHERE" in
  3)
    say '  Understood: the runner must run on the OTHER machine. This run prints'
    say '  the commands; run them there (or run this script there).'
    ;;
esac

if [ "$WHERE" = 2 ]; then
  detected="$(detect_container_names | head -1)"
  ask CONTAINER_NAME 'Name of the api container (e.g. castel-api-1)' "${detected:-castel-api}"
  if [ "$docker_available" = 1 ] && [ "$DRY_RUN" = 0 ]; then
    if ! docker ps --format '{{.Name}}' 2>/dev/null | grep -Fxq "$CONTAINER_NAME"; then
      warn "no running container '$CONTAINER_NAME' found here - check the name"
    fi
  fi
fi

if [ "$WHERE" != 3 ]; then
  ask PROJECT_NAME 'Compose project name' "${PROJECT_NAME:-$(detect_project_name)}"
  ask REPO_DIR 'Project folder (the one that holds docker-compose.yml)' "${REPO_DIR:-$(detect_repo_dir)}"
fi
[ -z "${COMPOSE_FILE:-}" ] && COMPOSE_FILE="$(detect_compose_file)"
[ -z "${ENV_FILE:-}" ] && ENV_FILE="${REPO_DIR:+$REPO_DIR/.env}"
[ -z "${ENV_FILE:-}" ] && ENV_FILE=".env"

ask PWA_PORT 'Published PWA port (nginx reaches the api through it)' "${PWA_PORT:-$(env_get PWA_PORT)}"
if [ "$VARIANT" != timer ]; then
  ask WEBHOOK_PORT 'Port for the webhook receiver' "${WEBHOOK_PORT:-9000}"
fi

if [ -z "$TOKEN" ]; then
  existing="$(env_get UPDATE_WEBHOOK_TOKEN)"
  if [ -n "$existing" ]; then
    TOKEN="$existing"
    say_i 'UPDATE_WEBHOOK_TOKEN already in the .env - it gets reused'
  else
    TOKEN="$(openssl rand -hex 32 2>/dev/null | head -c 64 || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    say_i 'Token generated for this run (it goes into the .env, never printed back)'
  fi
fi

ask_choice VARIANT 'Update-Service variant' "$VARIANT" timer webhook container
say "Variant: $VARIANT (timer = systemd-Timer, webhook = host receiver, container = receiver in a container)"
if [ "$PATCH_COMPOSE" = 0 ]; then
  if confirm 'Patch docker-compose.yml when something is missing?' n; then
    PATCH_COMPOSE=1
  fi
fi

# ---------- Runner installation ----------

enable_service() { # enable_service <unit> - guards missing systemd + other machine
  if [ "$WHERE" = 3 ]; then
    say_i 'on the other machine: sudo systemctl enable --now '"$1"
    return
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "no systemctl found - enable by hand: systemctl enable --now $1"
    return
  fi
  run 'systemd reload' "${SUDO[@]}" systemctl daemon-reload
  run "enable $1" "${SUDO[@]}" systemctl enable --now "$1"
}

install_timer() {
  local dir="${REPO_DIR:-/srv/castel}"
  say 'Variant A - systemd-Timer on the host:'
  printf '%s\n' "[Unit]
Description=Castel update runner
[Service]
Type=oneshot
WorkingDirectory=$dir
ExecStart=$dir/scripts/update.sh --if-requested" | write_file /etc/systemd/system/castel-update.service
  printf '%s\n' "[Unit]
Description=Castel update runner - pending update once a minute
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target" | write_file /etc/systemd/system/castel-update.timer
  enable_service castel-update.timer
}

download_webhook_binary() {
  if [ -x /usr/local/bin/webhook ]; then
    say_i 'webhook binary already at /usr/local/bin/webhook (kept)'
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    warn 'no curl found - download adnanh/webhook to /usr/local/bin/webhook manually'
    warn '  https://github.com/adnanh/webhook/releases/latest/download/webhook-linux-amd64'
    return
  fi
  run 'download webhook binary' "${SUDO[@]}" curl -fsSL -o /usr/local/bin/webhook \
    "https://github.com/adnanh/webhook/releases/latest/download/webhook-linux-amd64" ||
    warn 'download failed - place the webhook binary at /usr/local/bin/webhook manually'
  run 'chmod +x' "${SUDO[@]}" chmod +x /usr/local/bin/webhook || true
}

install_webhook_host() {
  local dir="${REPO_DIR:-/srv/castel}"
  say 'Variant B - adnanh/webhook receiver on the host:'
  download_webhook_binary
  printf '%s\n' "- id: castel-update
  execute-command: $dir/scripts/update-hook.sh
  command-working-directory: $dir
  http-methods:
    - POST
  trigger-rule:
    match:
      type: value
      value: \"$TOKEN\"
      parameter:
        source: header
        name: X-Deploy-Token
  response-message: '{\"started\":true}'
  success-http-response-code: 200" | write_file /etc/castel/hooks.yaml
  printf '%s\n' "[Unit]
Description=Castel update webhook receiver
[Service]
ExecStart=/usr/local/bin/webhook -hooks /etc/castel/hooks.yaml -port $WEBHOOK_PORT -verbose
Restart=always
[Install]
WantedBy=multi-user.target" | write_file /etc/systemd/system/castel-update-webhook.service
  enable_service castel-update-webhook
}

install_container_webhook() {
  local dir="${REPO_DIR:-/srv/castel}"
  say 'Variant C - webhook receiver inside a container:'
  say '  Inside the container git is usually missing - scripts/update.sh skips'
  say '  the git step then (images only). The docker CLI and the socket are'
  say '  mounted from the host, so docker compose works inside as well.'
  download_webhook_binary
  printf '%s\n' "- id: castel-update
  execute-command: /work/scripts/update-hook.sh
  command-working-directory: /work
  http-methods:
    - POST
  trigger-rule:
    match:
      type: value
      value: \"$TOKEN\"
      parameter:
        source: header
        name: X-Deploy-Token
  response-message: '{\"started\":true}'
  success-http-response-code: 200" | write_file /etc/castel/hooks.yaml
  if [ "$WHERE" = 3 ]; then
    say_i 'docker run must be executed on the other machine (same command here).'
  fi
  if [ ! -x /usr/local/bin/webhook ]; then
    warn 'webhook binary not in place - variant C cannot start the receiver here'
    warn 'once the binary stands, run the docker run command printed below:'
    say_i "docker run -d --name castel-update-webhook --restart always -p ${WEBHOOK_PORT}:${WEBHOOK_PORT} --add-host host.docker.internal:host-gateway -v /usr/local/bin/webhook:/usr/local/bin/webhook:ro -v /etc/castel/hooks.yaml:/etc/castel/hooks.yaml:ro -v ${dir}:/work -v /var/run/docker.sock:/var/run/docker.sock -v /usr/bin/docker:/usr/bin/docker:ro --env CASTEL_REPO_DIR=/work webhook -hooks /etc/castel/hooks.yaml -port ${WEBHOOK_PORT} -verbose"
    return
  fi
  run 'docker run receiver' "${SUDO[@]}" docker run -d --name castel-update-webhook --restart always \
    -p "$WEBHOOK_PORT:$WEBHOOK_PORT" \
    --add-host host.docker.internal:host-gateway \
    -v /usr/local/bin/webhook:/usr/local/bin/webhook:ro \
    -v /etc/castel/hooks.yaml:/etc/castel/hooks.yaml:ro \
    -v "$dir":/work \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$(command -v docker 2>/dev/null || echo /usr/bin/docker)":/usr/bin/docker:ro \
    --env CASTEL_REPO_DIR=/work \
    --env CASTEL_PROJECT_NAME="${PROJECT_NAME:-}" \
    webhook -hooks /etc/castel/hooks.yaml -port "$WEBHOOK_PORT" -verbose ||
    warn 'docker failed or is missing - run the same command where the stack lives'
}

if [ "$SKIP_RUNNER" = 1 ]; then
  say_i '[skip-runner] the runner installation gets skipped (.env + compose only)'
else
  case "$VARIANT" in
    timer) install_timer ;;
    webhook) install_webhook_host ;;
    container) install_container_webhook ;;
  esac
fi

# ---------- .env ----------

if [ -f "${ENV_FILE:-}" ]; then
  env_set UPDATE_WEBHOOK_TOKEN "$TOKEN"
  case "$VARIANT" in
    timer) say_i 'UPDATE_WEBHOOK_URL stays leer - the server derives it from PWA_PORT' ;;
    webhook | container)
      env_set UPDATE_WEBHOOK_URL "http://host.docker.internal:${WEBHOOK_PORT}/hooks/castel-update"
      ;;
  esac
else
  warn "no .env at ${ENV_FILE:-?} - set UPDATE_WEBHOOK_TOKEN (and UPDATE_WEBHOOK_URL for variant webhook/container) manually"
fi

# ---------- Compose patch (only missing pieces) ----------

patch_compose() {
  [ "$PATCH_COMPOSE" = 1 ] || return
  if [ -z "$COMPOSE_FILE" ] || [ ! -f "$COMPOSE_FILE" ]; then
    warn 'no compose file found - extra_hosts/PWA port must be checked by hand'
    return
  fi
  local f="$COMPOSE_FILE" line
  if grep -q 'host.docker.internal:host-gateway' "$f"; then
    say_i 'extra_hosts already present (kept)'
  else
    line="$(grep -nE '^  (api|[a-z0-9_-]*api[a-z0-9_-]*):' "$f" | head -1 | cut -d: -f1)"
    if [ -z "$line" ]; then
      warn 'no api service found - paste extra_hosts by hand'
    elif [ "$DRY_RUN" = 1 ]; then
      say_i "[dry-run] would insert extra_hosts below line $line"
    else
      cp "$f" "$f.castel-bak"
      awk -v at="$line" '{
        print
        if (NR == at) {
          print "    extra_hosts:"
          print "      - \"host.docker.internal:host-gateway\""
        }
      }' "$f" >"$f.new" && mv "$f.new" "$f"
      say_i 'extra_hosts inserted into the api service (backup kept)'
    fi
  fi
  if grep -Eq '^[[:space:]]*-[[:space:]]*"\$\{PWA_PORT' "$f"; then
    say_i 'PWA port already published (kept)'
  else
    port_line="$(grep -nE '^[[:space:]]*#[[:space:]]*-[[:space:]]*"\$\{PWA_PORT' "$f" | head -1 | cut -d: -f1)"
    if [ -z "$port_line" ]; then
      warn "no PWA port line found - is the stack reachable at 127.0.0.1:$PWA_PORT?"
    else
      hdr=""
      n=$((port_line - 1))
      while [ "$n" -ge 1 ] && [ "$n" -ge $((port_line - 8)) ]; do
        cur="$(awk -v want="$n" 'NR == want' "$f")"
        if printf '%s' "$cur" | grep -qE '^  [a-z0-9_-]+:'; then break; fi
        if printf '%s' "$cur" | grep -qE '^[[:space:]]*#[[:space:]]*ports:'; then
          hdr="$n"
          break
        fi
        n=$((n - 1))
      done
      if [ "$DRY_RUN" = 1 ]; then
        say_i "[dry-run] would publish the PWA port (line $port_line${hdr:+ and header line $hdr})"
      else
        cp "$f" "$f.castel-bak"
        if [ -n "$hdr" ]; then
          sed -i "${hdr}s/^\([[:space:]]*\)#[[:space:]]*/\1/" "$f"
        fi
        sed -i "${port_line}s/^\([[:space:]]*\)#[[:space:]]*/\1  /" "$f"
        say_i 'PWA port published (commented lines uncommented, backup kept)'
      fi
    fi
  fi
  if [ "$DRY_RUN" = 0 ] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    if docker compose -f "$f" config >/dev/null 2>&1; then
      say_i 'compose file still parses (docker compose config)'
    else
      warn 'compose file does not parse after the patch - check it!'
    fi
  fi
}

patch_compose

# ---------- Verify ----------

if [ "$WHERE" != 3 ] && confirm 'Verify now (stack must be reachable)?' y; then
  url="http://127.0.0.1:${PWA_PORT}/api/admin/update/webhook"
  if [ "$DRY_RUN" = 1 ]; then
    say_i "[dry-run] would POST $url with X-Deploy-Token from the .env"
  elif ! command -v curl >/dev/null 2>&1; then
    warn "no curl found - verify the inbound endpunkt $url by hand"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url" \
      -H "X-Deploy-Token: $(env_get UPDATE_WEBHOOK_TOKEN)" \
      -H 'Content-Type: application/json' --data-raw '{}' || echo 000)"
    case "$code" in
      200) say_i '200 - request marked in the DB, the runner picks it up' ;;
      401) warn '401 - Token mismatch: the api has not read the new .env yet (docker compose up -d api)' ;;
      500) warn '500 - UPDATE_WEBHOOK_TOKEN leer in the .env' ;;
      000) warn "not reachable - normal during a stack restart; check 127.0.0.1:$PWA_PORT" ;;
      *) say_i "HTTP $code - check the response body manually" ;;
    esac
  fi
fi

# ---------- Summary ----------

say
say 'Summary - the update chain now works like this:'
say '  PWA Button "Jetzt aktualisieren" -> inbound endpunkt (this machine)'
case "$VARIANT" in
  timer) say '  systemd-Timer (each minute) -> scripts/update.sh --if-requested' ;;
  webhook) say "  webhook receiver on port $WEBHOOK_PORT -> scripts/update-hook.sh" ;;
  container) say "  receiver container on port $WEBHOOK_PORT -> scripts/update-hook.sh" ;;
esac
say '  -> new images pulled, stack restarted, old images pruned.'
say
say 'Next steps:'
say '  1. docker compose up -d api  (the api reads the new .env values)'
say '  2. open the PWA under Einstellungen → Entwicklung → Update and click'
say '     „Auf Updates prüfen“.'
say
say 'Settings used:'
say_i "variant=$VARIANT repo=${REPO_DIR:-?} project=${PROJECT_NAME:-?} pwa-port=$PWA_PORT webhook-port=$WEBHOOK_PORT"
say 'Token: written into the .env, never shown back here.'
