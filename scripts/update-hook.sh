#!/usr/bin/env bash
#
# Webhook wrapper for a host-side update receiver (e.g. adnanh/webhook).
#
# The API waits at most 8 seconds for the webhook reply, but scripts/update.sh
# pulls images and recreates containers for minutes. This wrapper therefore
# acknowledges immediately and runs the real update detached in the background.
#
# It is safe to call without a pending request: scripts/update.sh exits right
# away when `server.updateState` is not `requested`.
#
# ENVIRONMENT
#   CASTEL_REPO_DIR    absolute path of the Castel checkout (default:
#                      parent directory of this script)
#   CASTEL_UPDATE_LOG  log file for the detached run
#                      (default: /tmp/castel-update.log)

set -Eeuo pipefail

REPO_DIR="${CASTEL_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="${CASTEL_UPDATE_LOG:-/tmp/castel-update.log}"

cd "$REPO_DIR"

# Detach so the receiver can answer before the update finishes. `nohup` keeps
# the process alive when the webhook service is restarted or recreated.
nohup ./scripts/update.sh --if-requested >>"$LOG_FILE" 2>&1 </dev/null &

printf '{"started":true}\n'
