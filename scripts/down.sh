#!/usr/bin/env bash
# Yuki — down.sh : arrête et retire les conteneurs (sans toucher aux volumes).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

docker compose down "$@"
echo "[down] conteneurs arrêtés."
