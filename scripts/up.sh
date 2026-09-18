#!/usr/bin/env bash
# Yuki — up.sh : démarre le gateway et attend /health/live.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "[up] .env absent : copie depuis .env.example"
  cp .env.example .env
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

PORT="${YUKI_GATEWAY_PORT:-8080}"
UID_TARGET="${YUKI_UID:-1000}"
GID_TARGET="${YUKI_GID:-1000}"

echo "[up] préparation des dossiers hôtes"
for path in \
  "${YUKI_HOST_PI_AGENT_DIR:-./.local/pi}" \
  "${YUKI_HOST_WORKSPACE_DIR:-./.local/workspace}" \
  "${YUKI_HOST_MODELS_DIR:-./.local/models}" \
  "${YUKI_HOST_STATE_DIR:-./.local/state}"; do
  mkdir -p "$path"
  if chown -R "${UID_TARGET}:${GID_TARGET}" "$path" 2>/dev/null; then
    :
  else
    echo "[up] chown ${path} ignoré (permissions insuffisantes)"
  fi
done

echo "[up] docker compose up -d"
docker compose up -d --build

echo "[up] attente de http://127.0.0.1:${PORT}/health/live"
deadline=$(( $(date +%s) + 90 ))
until node -e "fetch('http://127.0.0.1:${PORT}/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[up] échec : /health/live indisponible après 90 s" >&2
    docker compose logs --tail=50 gateway >&2 || true
    exit 1
  fi
  sleep 2
done

echo "[up] gateway prêt : http://127.0.0.1:${PORT}/health"
