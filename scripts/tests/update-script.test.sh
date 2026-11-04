#!/usr/bin/env bash
#
# Test for scripts/update.sh.
#
# The script is exercised against a fake `docker` and a fake `git` on the PATH,
# so the detection logic (repo dir, project name), the preflight checks, the
# request mode and the state writeback can be verified without touching a
# real stack.
#
#   ./scripts/tests/update-script.test.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UPDATE_SCRIPT="${REPO_ROOT}/scripts/update.sh"
ORIG_PATH="$PATH"

PASS=0
FAIL=0
WORK_DIR=""
RUN_OUT=""
RUN_RC=0

cleanup() {
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
}
trap cleanup EXIT

ok() {
  PASS=$((PASS + 1))
  printf '  ok   - %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL - %s\n' "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$label"
  else
    fail "$label" "erwartet: '$expected' / bekommen: '$actual'"
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) ok "$label" ;;
    *) fail "$label" "gesucht: '$needle' in: $(printf '%s' "$haystack" | head -c 400)" ;;
  esac
}

check_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*) fail "$label" "unerwartet enthalten: '$needle'" ;;
    *) ok "$label" ;;
  esac
}

# Creates an isolated fake environment:
#   $WORK_DIR/bin/docker   - fake docker CLI (labels, psql emulation)
#   $WORK_DIR/bin/git     - fake git CLI
#   $WORK_DIR/checkout    - fake compose checkout
setup_env() {
  WORK_DIR="$(mktemp -d -t castel-update-test.XXXXXX)"
  mkdir -p "$WORK_DIR/bin" "$WORK_DIR/checkout/.git"

  cat >"$WORK_DIR/checkout/docker-compose.yml" <<'YML'
services:
  api:
    image: castel-api
  db:
    image: castel-db
YML
  printf 'IMAGE_TAG=latest\n' >"$WORK_DIR/checkout/.env"
  printf '{\n  "name": "castel",\n  "version": "1.2.3"\n}\n' >"$WORK_DIR/checkout/package.json"
  printf 'ref: refs/heads/main\n' >"$WORK_DIR/checkout/.git/HEAD"

  cat >"$WORK_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
# Fake docker CLI. The compose labels are faked via FAKE_DOCKER_* variables.
format=""
service=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--format" ] && format="$arg"
  case "$arg" in
    label=com.docker.compose.service=*) service="${arg#label=com.docker.compose.service=}" ;;
  esac
  prev="$arg"
done

case "$1" in
  ps)
    if [ "$2" = "info" ]; then exit "${FAKE_DOCKER_INFO_RC:-0}"; fi
    case "$format" in
      *project.working_dir*) printf '%s\n' "${FAKE_DOCKER_WORKING_DIR:-}" ;;
      *project.config_files*) printf '%s\n' "${FAKE_DOCKER_CONFIG_FILES:-}" ;;
      *com.docker.compose.project*) printf '%s\n' "${FAKE_DOCKER_PROJECT:-castel}" ;;
      *Names*)
        case "$service" in
          db) printf '%s\n' "${FAKE_DOCKER_DB_CONTAINER-castel-db-1}" ;;
          *) printf '%s\n' "${FAKE_DOCKER_API_CONTAINER-castel-api-1}" ;;
        esac
        ;;
      *) : ;;
    esac
    exit 0
    ;;
  compose)
    if [ "$2" = "version" ]; then exit 0; fi
    printf 'compose %s\n' "$*"
    exit 0
    ;;
  inspect) printf '%s\n' "${FAKE_DOCKER_HEALTH:-healthy}"; exit 0 ;;
  logs) printf 'fake container log\n'; exit 0 ;;
  exec)
    # psql emulation: SELECT reads the state file, INSERT writes it.
    sql="$(cat)"
    state_file="${FAKE_DOCKER_STATE_FILE:-}"
    if printf '%s' "$sql" | grep -qi 'select'; then
      [ -n "$state_file" ] && [ -f "$state_file" ] && cat "$state_file"
      exit 0
    fi
    value="$(printf '%s' "$sql" | sed -n "s/.*VALUES ('[^']*', NULL, '\(.*\)', NOW()).*/\1/p")"
    if [ -n "$state_file" ] && [ -n "$value" ]; then
      printf '%s' "$value" | sed "s/''/'/g" >"$state_file"
    fi
    exit 0
    ;;
  image | builder) printf 'pruned\n'; exit 0 ;;
  info) exit "${FAKE_DOCKER_INFO_RC:-0}" ;;
  *) exit 0 ;;
esac
DOCKER
  chmod +x "$WORK_DIR/bin/docker"

  cat >"$WORK_DIR/bin/git" <<'GIT'
#!/usr/bin/env bash
# Fake git CLI. Understands: -C <dir> [-c <opt>] <command>
if [ "$1" = "-C" ]; then
  shift 2
fi
while [ "$1" = "-c" ]; do
  shift 2
done
case "$1" in
  status)
    [ -n "${FAKE_GIT_DIRTY:-}" ] && printf ' M changed-file\n'
    exit 0
    ;;
  rev-parse)
    if [ "$2" = "--abbrev-ref" ]; then printf 'main\n'; else printf 'abc123\n'; fi
    exit 0
    ;;
  pull | fetch | merge) printf 'git ok\n'; exit "${FAKE_GIT_RC:-0}" ;;
esac
exit 0
GIT
  chmod +x "$WORK_DIR/bin/git"

  # PATH isolation: never inherit the bin dir of a previous setup_env.
  export PATH="$WORK_DIR/bin:$ORIG_PATH"
  export FAKE_DOCKER_WORKING_DIR="$WORK_DIR/checkout"
  export FAKE_DOCKER_CONFIG_FILES="$WORK_DIR/checkout/docker-compose.yml"
  export FAKE_DOCKER_PROJECT="castel"
  export FAKE_DOCKER_DB_CONTAINER="castel-db-1"
  export FAKE_DOCKER_API_CONTAINER="castel-api-1"
  export FAKE_DOCKER_HEALTH="healthy"
  export FAKE_DOCKER_STATE_FILE="$WORK_DIR/state.json"
  unset CASTEL_REPO_DIR CASTEL_HEALTH_TIMEOUT_SEC FAKE_GIT_DIRTY FAKE_GIT_RC 2>/dev/null || true
  unset FAKE_DOCKER_INFO_RC 2>/dev/null || true
}

run_update() {
  RUN_OUT="$(bash "$UPDATE_SCRIPT" "$@" 2>&1)"
  RUN_RC=$?
  return 0
}

echo "Test: scripts/update.sh"

# ---------- 1. The checkout is detected from the compose label ----------
echo "- Pfad- und Projektname-Ermittlung"
setup_env
run_update --skip-git --skip-purge
check_contains "Checkout wird aus dem Label ermittelt" "$WORK_DIR/checkout" "$RUN_OUT"
check_contains "Projektname wird gesetzt" "--project-name castel" "$RUN_OUT"
check_contains "Projektverzeichnis wird gesetzt" "--project-directory $WORK_DIR/checkout" "$RUN_OUT"
check_contains "Compose-Datei wird übergeben" "-f $WORK_DIR/checkout/docker-compose.yml" "$RUN_OUT"
check "Exit-Code bei erfolgreichem Lauf" "0" "$RUN_RC"

# ---------- 2. CASTEL_REPO_DIR wins over the label ----------
setup_env
export CASTEL_REPO_DIR="$WORK_DIR/checkout"
run_update --skip-git --skip-purge
check_contains "CASTEL_REPO_DIR wird verwendet" "--project-directory $WORK_DIR/checkout" "$RUN_OUT"

# ---------- 3. Preflight ----------
echo "- Preflight"
setup_env
rm -f "$WORK_DIR/checkout/.env"
run_update --skip-git --skip-purge
check "Fehlende .env bricht das Update nicht ab" "0" "$RUN_RC"
check_contains "Fehlende .env wird nur als Hinweis gemeldet" "keine .env" "$RUN_OUT"

setup_env
rm -f "$WORK_DIR/checkout/docker-compose.yml"
run_update --skip-git --skip-purge
check "Exit-Code bei fehlender compose-Datei" "11" "$RUN_RC"

setup_env
rm -f "$WORK_DIR/bin/docker"
run_update --skip-git --skip-purge
check "Exit-Code bei fehlendem docker" "10" "$RUN_RC"
check_contains "Fehlermeldung nennt docker" "docker nicht im PATH" "$RUN_OUT"

setup_env
export FAKE_DOCKER_INFO_RC=1
run_update --skip-git --skip-purge
check "Exit-Code bei totem Docker-Daemon" "10" "$RUN_RC"
check_contains "Fehlermeldung nennt den Daemon" "Docker-Daemon nicht erreichbar" "$RUN_OUT"

# ---------- 3b. Graceful degradation (Arcane-like environments) ----------
echo "- Ohne Git/.env/DB (z. B. Arcane)"
setup_env
rm -rf "$WORK_DIR/checkout/.git"
run_update --skip-purge
check "Lauf ohne Git-Checkout gelingt" "0" "$RUN_RC"
check_contains "git-Schritt wird automatisch übersprungen" "kein Git-Checkout" "$RUN_OUT"

setup_env
rm -f "$WORK_DIR/checkout/.env"
rm -rf "$WORK_DIR/checkout/.git"
run_update --skip-purge
check "Lauf ohne .env und ohne Git gelingt" "0" "$RUN_RC"

setup_env
export FAKE_DOCKER_DB_CONTAINER=""
run_update --skip-git --skip-purge
check "Lauf ohne db-Container gelingt" "0" "$RUN_RC"
check_contains "Hinweis auf fehlenden db-Container" "kein db-Container" "$RUN_OUT"

# ---------- 4. Dirty worktree ----------
echo "- Git"
setup_env
export FAKE_GIT_DIRTY=1
run_update --skip-purge
check "Exit-Code bei dirty Worktree" "12" "$RUN_RC"
check_contains "Fehlermeldung nennt lokale Änderungen" "lokale Änderungen" "$RUN_OUT"

setup_env
export FAKE_GIT_DIRTY=1
run_update --skip-purge --allow-dirty
check "dirty Worktree mit --allow-dirty läuft durch" "0" "$RUN_RC"

setup_env
export FAKE_GIT_RC=1
run_update --skip-purge
check "Exit-Code bei git-Fehler" "1" "$RUN_RC"

setup_env
run_update --skip-purge --skip-git
check_contains "git pull wird bei --skip-git übersprungen" "git pull übersprungen" "$RUN_OUT"

# ---------- 5. Health check ----------
echo "- Health-Check"
setup_env
export FAKE_DOCKER_HEALTH="unhealthy"
run_update --skip-git --skip-purge
check "Exit-Code bei unhealthy api" "1" "$RUN_RC"
check_contains "Logzeile nennt unhealthy" "unhealthy" "$RUN_OUT"
check_contains "Container-Log wird ausgegeben" "fake container log" "$RUN_OUT"

# ---------- 6. Request mode ----------
echo "- Anforderungsmodus"
setup_env
printf '{"phase":"done","ok":true}' >"$FAKE_DOCKER_STATE_FILE"
run_update --if-requested --skip-git --skip-purge
check "Exit-Code ohne offene Anforderung (phase=done)" "23" "$RUN_RC"
check_contains "Meldung nennt keine offene Anforderung" "keine offene Update-Anforderung" "$RUN_OUT"

setup_env
printf '{"phase":"requested","requestedAt":"2026-01-01T00:00:00Z"}' >"$FAKE_DOCKER_STATE_FILE"
run_update --if-requested --skip-git --skip-purge
check_contains "Update läuft bei offener Anforderung" "Update gestartet" "$RUN_OUT"

setup_env
printf '{"phase":"running","startedAtEpoch":%s}' "$(date +%s)" >"$FAKE_DOCKER_STATE_FILE"
run_update --if-requested --skip-git --skip-purge
check "frischer running-Zustand blockiert einen zweiten Lauf" "22" "$RUN_RC"
check_contains "Meldung nennt laufendes Update" "läuft bereits" "$RUN_OUT"

setup_env
printf '{"phase":"running","startedAtEpoch":%s}' "$(( $(date +%s) - 7200 ))" >"$FAKE_DOCKER_STATE_FILE"
run_update --if-requested --skip-git --skip-purge
check_contains "veralteter running-Zustand wird neu gestartet" "veraltet" "$RUN_OUT"

setup_env
printf '' >"$FAKE_DOCKER_STATE_FILE"
run_update --if-requested --skip-git --skip-purge
check "Exit-Code ohne DB-Zeile (leerer State)" "21" "$RUN_RC"
check_contains "Meldung nennt fehlende Anforderung in DB" "keine Update-Anforderung in der DB" "$RUN_OUT"

setup_env
export FAKE_DOCKER_DB_CONTAINER=""
run_update --if-requested --skip-git --skip-purge
check "Exit-Code ohne db-Container" "20" "$RUN_RC"
check_contains "Meldung nennt fehlenden db-Container" "kein db-Container erreichbar" "$RUN_OUT"

# ---------- 7. State writeback ----------
echo "- Status-Rückmeldung"
setup_env
run_update --skip-git --skip-purge
check_contains "Finaler Status ist done" '"phase":"done"' "$(cat "$FAKE_DOCKER_STATE_FILE")"
check_contains "Status enthält das Protokoll" '"log":' "$(cat "$FAKE_DOCKER_STATE_FILE")"
check_contains "Status enthält die Version" '"versionBefore":"1.2.3"' "$(cat "$FAKE_DOCKER_STATE_FILE")"

setup_env
export FAKE_DOCKER_HEALTH="unhealthy"
run_update --skip-git --skip-purge
check_contains "Fehlerstatus wird gemeldet" '"phase":"failed"' "$(cat "$FAKE_DOCKER_STATE_FILE")"

# ---------- 8. Image purge ----------
echo "- Image-Purge"
setup_env
run_update --skip-git
check_contains "Image-Purge wurde ausgeführt" "image prune" "$RUN_OUT"
check_contains "Altersfilter wird angewendet" "168h" "$RUN_OUT"

setup_env
run_update --skip-git --purge-until 24h
check_contains "Altersfilter ist konfigurierbar" "24h" "$RUN_OUT"

setup_env
run_update --skip-git --skip-purge
check_contains "Purge lässt sich überspringen" "Image-Purge übersprungen" "$RUN_OUT"

# ---------- 9. Arguments ----------
echo "- Argumente"
setup_env
run_update --quatsch
check "Exit-Code bei unbekanntem Argument" "2" "$RUN_RC"
check_contains "Fehlermeldung nennt das Argument" "unbekanntes Argument" "$RUN_OUT"

echo
echo "Ergebnis: ${PASS} ok, ${FAIL} fehlgeschlagen"
[ "$FAIL" -eq 0 ]
