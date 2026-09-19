#!/usr/bin/env bash
# Yuki — up.sh : démarre le gateway et attend /health/live.
#
# Commodité, PLUS une nécessité : `docker compose up -d` suffit désormais
# (le compose TIRE l'image publiée et la persistance passe par des volumes
# nommés, sans préparation de l'hôte). Ce script ajoute seulement la copie de
# `.env` et l'attente du healthcheck.
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

echo "[up] docker compose up -d (tire l'image publiée si nécessaire)"
docker compose up -d

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
