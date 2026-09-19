#!/usr/bin/env bash
# Yuki — reset-state.sh : efface l'état persistant local (destructif).
#
# La persistance passe par des VOLUMES NOMMÉS Docker : on supprime les volumes
# `yuki-state` et `yuki-workspace` (recréés vides et correctement propriétaires
# au prochain `up`, à partir de l'image). Les volumes `yuki-models` et `yuki-pi`
# (agent Pi, sessions) ne sont PAS touchés.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_VOLUME="yuki-state"
WORKSPACE_VOLUME="yuki-workspace"

echo "Cette opération efface :"
echo "  - état     : volume ${STATE_VOLUME}"
echo "  - workspace: volume ${WORKSPACE_VOLUME}"
echo "Les volumes yuki-models et yuki-pi ne sont PAS touchés."
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

for vol in "$STATE_VOLUME" "$WORKSPACE_VOLUME"; do
  if docker volume inspect "$vol" >/dev/null 2>&1; then
    docker volume rm "$vol" >/dev/null && echo "[reset-state] volume ${vol} supprimé"
  else
    echo "[reset-state] volume ${vol} absent (rien à faire)"
  fi
done

echo "[reset-state] terminé. Relancez 'docker compose up -d'."
