#!/usr/bin/env bash
# Yuki — reset-state.sh : efface l'état persistant local (destructif).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

STATE_DIR="${YUKI_HOST_STATE_DIR:-./.local/state}"
WORKSPACE_DIR="${YUKI_HOST_WORKSPACE_DIR:-./.local/workspace}"

echo "Cette opération efface :"
echo "  - état    : ${STATE_DIR}"
echo "  - workspace: ${WORKSPACE_DIR}"
echo "Les modèles (${YUKI_HOST_MODELS_DIR:-./.local/models}) et l'agent Pi (${YUKI_HOST_PI_AGENT_DIR:-./.local/pi}) ne sont PAS touchés."
echo

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Confirmer la remise à zéro ? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "[reset-state] annulé."; exit 0 ;;
  esac
fi

echo "[reset-state] arrêt du gateway"
docker compose down >/dev/null 2>&1 || true

for path in "$STATE_DIR" "$WORKSPACE_DIR"; do
  if [ -e "$path" ]; then
    rm -rf "${path:?}"/* 2>/dev/null || true
    rm -rf "${path:?}"/.[!.]* 2>/dev/null || true
    echo "[reset-state] ${path} vidé"
  else
    echo "[reset-state] ${path} absent (rien à faire)"
  fi
done

echo "[reset-state] terminé."
