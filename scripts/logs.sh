#!/usr/bin/env bash
# Yuki — logs.sh : suit les logs du gateway.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAIL="${1:-100}"
docker compose logs -f --tail="$TAIL" gateway
