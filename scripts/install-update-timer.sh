#!/usr/bin/env bash
#
# Installs the systemd unit + timer for the castel update runner.
#
# The timer calls scripts/update.sh --if-requested every 15 seconds. The runner
# only acts when the PWA requested an update (flag in the database), otherwise
# it exits immediately.
#
# Usage (on the host, from the compose checkout):
#   sudo ./scripts/install-update-timer.sh
#   sudo ./scripts/install-update-timer.sh --uninstall
#
# Options:
#   --user <name>   run the service as this user (default: owner of the checkout)
#   --uninstall     remove the unit + timer again
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
UNIT_NAME="castel-update"
SYSTEMD_DIR="/etc/systemd/system"
SERVICE_UNIT="${SYSTEMD_DIR}/${UNIT_NAME}.service"
TIMER_UNIT="${SYSTEMD_DIR}/${UNIT_NAME}.timer"
RUN_USER=""
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      shift
      [ "$#" -gt 0 ] || { echo "FEHLER: --user braucht einen Benutzernamen" >&2; exit 2; }
      RUN_USER="$1"
      ;;
    --uninstall) UNINSTALL=1 ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "FEHLER: unbekanntes Argument '$1'" >&2
      exit 2
      ;;
  esac
  shift
done

# ---------- Uninstall ----------

if [ "$UNINSTALL" -eq 1 ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "${UNIT_NAME}.timer" 2>/dev/null || true
    systemctl stop "${UNIT_NAME}.service" 2>/dev/null || true
    rm -f "$SERVICE_UNIT" "$TIMER_UNIT"
    systemctl daemon-reload
    echo "Timer entfernt."
  else
    echo "systemd nicht verfügbar - bitte den Cron-Eintrag manuell entfernen:"
    echo "  crontab -e   (Zeile mit ${SCRIPT_DIR}/update.sh entfernen)"
  fi
  exit 0
fi

# ---------- Preflight ----------

if [ ! -f "${SCRIPT_DIR}/update.sh" ]; then
  echo "FEHLER: ${SCRIPT_DIR}/update.sh nicht gefunden." >&2
  exit 1
fi

if [ ! -f "${SCRIPT_DIR}/update.sh" ] || [ ! -x "${SCRIPT_DIR}/update.sh" ]; then
  chmod +x "${SCRIPT_DIR}/update.sh"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd ist auf diesem Host nicht verfügbar."
  echo
  echo "Nutze stattdessen einen Cron-Eintrag (einmalig):"
  echo
  echo "  * * * * * ${SCRIPT_DIR}/update.sh --if-requested >> /var/log/castel-update.log 2>&1"
  echo
  echo "Mit 'crontab -e' einfuegen. Der Cron laeuft nur einmal pro Minute."
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "FEHLER: bitte mit sudo ausfuehren (die Unit landet in ${SYSTEMD_DIR})." >&2
  exit 1
fi

# ---------- User detection ----------

if [ -z "$RUN_USER" ]; then
  RUN_USER="$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo root)"
fi
if ! id "$RUN_USER" >/dev/null 2>&1; then
  echo "FEHLER: Benutzer '$RUN_USER' existiert nicht." >&2
  exit 1
fi

# ---------- Write units ----------

mkdir -p "$SYSTEMD_DIR"

sed \
  -e "s#^ExecStart=.*#ExecStart=${SCRIPT_DIR}/update.sh --if-requested#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=${REPO_DIR}#" \
  -e "s#^User=.*#User=${RUN_USER}#" \
  "${SCRIPT_DIR}/${UNIT_NAME}.service" >"$SERVICE_UNIT"

cp "${SCRIPT_DIR}/${UNIT_NAME}.timer" "$TIMER_UNIT"

chmod 644 "$SERVICE_UNIT" "$TIMER_UNIT"

# ---------- Enable ----------

systemctl daemon-reload
systemctl enable --now "${UNIT_NAME}.timer"

echo "Update-Timer installiert."
echo "  Unit:      ${SERVICE_UNIT}"
echo "  Checkout:  ${REPO_DIR}"
echo "  Benutzer:  ${RUN_USER}"
echo
echo "Status:"
systemctl --no-pager status "${UNIT_NAME}.timer" | sed -n '1,6p' || true
echo
echo "Protokoll:  journalctl -u ${UNIT_NAME}.service -n 50 -f"
echo "Manuell:    ${SCRIPT_DIR}/update.sh"
