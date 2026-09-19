#!/usr/bin/env bash
# Yuki — doctor.sh : vérifie les prérequis hôte du Lot 0.
# Indépendant du runtime Node (aucune dépendance npm).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_DOCKER="29.8.1"
MIN_COMPOSE="5.5.1"
MIN_DRIVER="${YUKI_MIN_DRIVER:-580}"

failures=0
warnings=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; warnings=$((warnings + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; failures=$((failures + 1)); }

# version_ge A B -> vrai si A >= B (tri sémantique)
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

echo "Yuki — doctor (prérequis hôte)"
echo

# --- Docker Engine -----------------------------------------------------------
echo "Docker Engine"
if command -v docker >/dev/null 2>&1; then
  docker_version_raw="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
  if [ -z "$docker_version_raw" ]; then
    bad "docker présent mais le démon est injoignable (docker info)."
  elif version_ge "$docker_version_raw" "$MIN_DOCKER"; then
    ok "Docker Engine ${docker_version_raw} (>= ${MIN_DOCKER})"
  else
    bad "Docker Engine ${docker_version_raw} < ${MIN_DOCKER} requis."
  fi
else
  bad "commande 'docker' introuvable."
fi

# --- Docker Compose ----------------------------------------------------------
echo
echo "Docker Compose"
if docker compose version >/dev/null 2>&1; then
  compose_version_raw="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  if version_ge "$compose_version_raw" "$MIN_COMPOSE"; then
    ok "Compose v${compose_version_raw} (>= v${MIN_COMPOSE})"
  else
    bad "Compose v${compose_version_raw} < v${MIN_COMPOSE} requis."
  fi
else
  bad "plugin 'docker compose' indisponible."
fi

# --- NVIDIA Container Toolkit -------------------------------------------------
echo
echo "NVIDIA Container Toolkit"
if command -v nvidia-ctk >/dev/null 2>&1; then
  ok "nvidia-ctk présent ($(nvidia-ctk --version 2>/dev/null | head -n1))"
elif docker info 2>/dev/null | grep -qi 'nvidia'; then
  ok "runtime NVIDIA visible dans 'docker info'"
else
  warn "toolkit NVIDIA non détecté (requis pour le passthrough GPU)."
fi

# --- nvidia-smi & driver -----------------------------------------------------
echo
echo "GPU / driver"
if command -v nvidia-smi >/dev/null 2>&1; then
  driver_raw="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1 | tr -d '[:space:]')"
  if [ -z "$driver_raw" ]; then
    warn "nvidia-smi présent mais aucun GPU interrogé (rapport en mode no-gpu)."
  else
    driver_major="${driver_raw%%.*}"
    if [ "$driver_major" -ge "$MIN_DRIVER" ] 2>/dev/null; then
      ok "driver NVIDIA ${driver_raw} (majeure ${driver_major} >= ${MIN_DRIVER})"
    else
      # Le driver ne conditionne plus le profil : c'est une exigence des
      # services vocaux (asr/tts, lots 6/7). Au Lot 0 il ne bloque rien.
      warn "driver NVIDIA ${driver_raw} < ${MIN_DRIVER} (exigence de service asr/tts, sans effet sur le profil)"
    fi
    cuda_raw="$(nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: \([0-9.]*\).*/\1/p' | head -n1)"
    [ -n "$cuda_raw" ] && ok "CUDA supporté par le driver : ${cuda_raw}"
  fi
else
  warn "nvidia-smi introuvable : le gateway démarrera en profil 'texte-seul'."
fi

# --- Volumes nommés ----------------------------------------------------------
echo
echo "Volumes nommés (persistance)"
# La persistance passe par des volumes Docker (yuki-pi, yuki-workspace,
# yuki-models, yuki-state). Docker initialise chaque volume avec le propriétaire
# du répertoire correspondant DANS l'image : aucune préparation de dossier hôte
# ni `chown` n'est requis. Un simple `docker compose up -d` suffit.
ok "persistance par volumes Docker — aucune préparation de l'hôte requise"

# --- Bilan -------------------------------------------------------------------
echo
if [ "$failures" -gt 0 ]; then
  printf '\033[31m%d prérequis bloquant(s), %d avertissement(s).\033[0m\n' "$failures" "$warnings"
  exit 1
fi
printf '\033[32mTous les prérequis bloquants sont satisfaits\033[0m (%d avertissement(s)).\n' "$warnings"
