#!/usr/bin/env bash
# castel-Update: git pull, redeploy, alte Images entfernen.
#
# Lauf auf dem Host (nicht im Container), wo das docker-compose.yml liegt.
# Erwartet: git, docker, docker compose im PATH sowie ein .env-File.
#
#   ./scripts/update.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -f .env ]; then
  echo "FEHLER: .env nicht gefunden in $REPO_DIR" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "FEHLER: git nicht im PATH" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "FEHLER: docker nicht im PATH" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "FEHLER: docker compose nicht im PATH" >&2
  exit 1
fi

echo "==> git pull"
git pull --ff-only

echo "==> docker compose pull"
IMAGE_TAG="${IMAGE_TAG:-latest}" docker compose pull

echo "==> docker compose up -d"
IMAGE_TAG="${IMAGE_TAG:-latest}" docker compose up -d

echo "==> docker image prune -f"
docker image prune -f

echo "==> Fertig."
