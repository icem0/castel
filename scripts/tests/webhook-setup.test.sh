#!/usr/bin/env bash
#
# Test for scripts/webhook-setup.sh (the interactive update-service installer).
#
# The installer is exercised against a fixture compose file/.env in a temp dir,
# so the questionnaire can run without prompts (--no-prompt) and nothing
# outside the fixture gets touched:
#
#   - syntax check + --help
#   - dry-run: nothing changes, the planned actions get printed
#   - real run with --skip-runner: compose gets patched (extra_hosts + PWA
#     port), .env gets the token, no systemd files get written
#   - idempotence: a second run keeps the existing token and does not insert
#     extra_hosts a second time
#   - bad option / bad variant -> exit 2
#
#   ./scripts/tests/webhook-setup.test.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/scripts/webhook-setup.sh"

PASS=0
FAIL=0
WORK_DIR=""

cleanup() { [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf '  ok   - %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  printf '  FAIL - %s\n' "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
}
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then ok "$label"; else
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
    *"$needle"*) fail "$label" "nicht soll enthalten: '$needle'" ;;
    *) ok "$label" ;;
  esac
}

fixture() { # fixture <dir> - compose with commented PWA port + leer token
  cat >"$WORK_DIR/docker-compose.yml" <<'EOF'
services:
  api:
    image: ghcr.io/icem0/castel-api:latest
    expose:
      - "3000"
  pwa:
    image: ghcr.io/icem0/castel-pwa:latest
    # ports:
    #   - "${PWA_PORT:-4280}:3000"
EOF
  printf 'PWA_PORT=4280\nUPDATE_WEBHOOK_TOKEN=\n' >"$WORK_DIR/.env"
}

OUT=""
RC=0
run_setup() {
  OUT=""
  RC=0
  set +e
  OUT="$("$SETUP_SCRIPT" --no-prompt --skip-runner --repo-dir "$WORK_DIR" \
    --pwa-port 4280 --webhook-port 9000 --token tok-123 "$@")"
  RC=$?
  set -e
}

# 1) Syntax and help
if bash -n "$SETUP_SCRIPT" 2>/dev/null; then ok 'setup script parses'; else
  fail 'setup script parses' "$(bash -n "$SETUP_SCRIPT" 2>&1)"
fi
HELP="$("$SETUP_SCRIPT" --help)"
check_contains 'help mentions skip-runner' '--skip-runner' "$HELP"
check_contains 'help mentions variants' 'timer|webhook|container' "$HELP"
check_contains 'help mentions patch-compose' '--patch-compose' "$HELP"

# 2) Dry-run: printed plan, fixture untouched
WORK_DIR="$(mktemp -d)"
fixture
run_setup --dry-run --patch-compose
check_contains 'dry-run prints compose insert' 'would insert extra_hosts' "$OUT"
check_contains 'dry-run prints port publish' 'would publish the PWA port' "$OUT"
check_contains 'dry-run prints token write' 'would write UPDATE_WEBHOOK_TOKEN' "$OUT"
check_not_contains 'dry-run wrote no extra_hosts' 'host.docker.internal:host-gateway' "$(cat "$WORK_DIR/docker-compose.yml")"
check_not_contains 'dry-run kept empty token' 'UPDATE_WEBHOOK_TOKEN=tok-123' "$(cat "$WORK_DIR/.env")"

# 3) Real run: compose patched, token written, no systemd files
WORK_DIR="$(mktemp -d)"
fixture
run_setup --patch-compose
check 'real run exit clean' 0 "$RC"
check_contains 'extra_hosts inserted' 'host.docker.internal:host-gateway' "$(cat "$WORK_DIR/docker-compose.yml")"
if grep -Eq '^[[:space:]]*ports:' "$WORK_DIR/docker-compose.yml"; then
  ok 'PWA port published'
else
  fail 'PWA port published' "no ports: line in $(cat "$WORK_DIR/docker-compose.yml")"
fi
check_not_contains 'port block still commented' ' #   - "${PWA_PORT' "$(cat "$WORK_DIR/docker-compose.yml")"
check_contains 'token written' 'UPDATE_WEBHOOK_TOKEN=tok-123' "$(cat "$WORK_DIR/.env")"
if [ ! -f /etc/systemd/system/castel-update.timer ]; then
  ok 'no systemd unit touched'
else
  fail 'no systemd unit touched' 'castel-update.timer exists in /etc/systemd/system'
fi

# 4) Idempotence: second run keeps token, inserts only one extra_hosts
COMPOSE="$(cat "$WORK_DIR/docker-compose.yml")"
ENVFILE="$(cat "$WORK_DIR/.env")"
check 'extra_hosts exactly once' 1 "$(printf '%s' "$COMPOSE" | grep -c 'host.docker.internal:host-gateway')"
check 'token kept once' 1 "$(printf '%s' "$ENVFILE" | grep -c '^UPDATE_WEBHOOK_TOKEN=')"

# 5) Bad input -> exit 2
set +e
BAD="$("$SETUP_SCRIPT" --no-prompt --variant laser --repo-dir /nonexistent 2>&1)"
BADRC=$?
set -e
check 'bad variant exits 2' 2 "$BADRC"
check_contains 'bad variant message' 'unknown variant' "$BAD"
set +e
BAD="$("$SETUP_SCRIPT" --nope 2>&1)"
BADRC=$?
set -e
check 'bad option exits 2' 2 "$BADRC"
check_contains 'bad option message' 'unknown option' "$BAD"

printf '\n%d ok, %d FAIL\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
