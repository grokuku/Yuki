#!/usr/bin/env bash
# =============================================================================
# Yuki — ci-smoke.sh
#
# Valide, DANS UN RUNNER SANS GPU ni NVIDIA Container Toolkit :
#   1. `docker compose config` : le YAML Compose est réellement valide ;
#   2. le build de l'image `gateway` (Dockerfile multi-étage) ;
#   3. le démarrage du conteneur avec une FIXTURE `nvidia-smi` injectée, puis
#      l'appel à `/health` et `/health/ready` ;
#   4. le conteneur non-root, le rootfs read-only et l'écriture de l'état du
#      SDK dans le volume (hors rootfs).
#
# Usage :
#   ./scripts/ci-smoke.sh config   # valide le Compose (avec surcharge CI)
#   ./scripts/ci-smoke.sh smoke    # build + run + assertions
#   ./scripts/ci-smoke.sh          # les deux (défaut)
#
# La surcharge `.github/ci/compose.ci.yml` retire la réservation GPU (absente
# sur le runner) et injecte la fixture. Aucun secret n'est requis.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PHASE="${1:-all}"
PORT="${YUKI_GATEWAY_PORT:-8080}"
UID_TARGET="${YUKI_UID:-1000}"
GID_TARGET="${YUKI_GID:-1000}"

# Chemin HÔTE (absolu) de la fixture nvidia-smi montée dans le conteneur.
export YUKI_CI_GPU_FIXTURE="${YUKI_CI_GPU_FIXTURE:-$ROOT/tests/fixtures/gpu/rtx4070-12g.txt}"

COMPOSE=(docker compose -f docker-compose.yml -f .github/ci/compose.ci.yml)

log() { printf '\n\033[1m[ci-smoke] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[ci-smoke] ÉCHEC : %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "outil requis introuvable : $1"; }

assert_jq() { # <json> <filtre jq> <message>
  printf '%s' "$1" | jq -e "$2" >/dev/null 2>&1 || die "$3 (jq: $2)"
}

prepare() {
  need docker
  need curl
  need jq
  docker compose version >/dev/null 2>&1 || die "docker compose (v2) requis"
  if [ -z "${YUKI_CI_GPU_FIXTURE:-}" ] || [ ! -f "$YUKI_CI_GPU_FIXTURE" ]; then
    die "fixture nvidia-smi introuvable : ${YUKI_CI_GPU_FIXTURE:-<vide>}"
  fi
  if [ ! -f .env ]; then
    log "Création de .env depuis .env.example (valeurs factices, aucun secret)"
    cp .env.example .env
  fi
  log "Préparation des dossiers hôtes des bind mounts"
  for path in \
    "${YUKI_HOST_PI_AGENT_DIR:-./.local/pi}" \
    "${YUKI_HOST_WORKSPACE_DIR:-./.local/workspace}" \
    "${YUKI_HOST_MODELS_DIR:-./.local/models}" \
    "${YUKI_HOST_STATE_DIR:-./.local/state}"; do
    mkdir -p "$path"
    chown -R "${UID_TARGET}:${GID_TARGET}" "$path" 2>/dev/null || true
  done
}

check_config() {
  prepare
  log "docker compose config — validation réelle du YAML Compose"
  # On ne journalise PAS le rendu complet : il contient le `.env` (valeurs
  # factices en CI, mais potentiellement réelles en local). Le rendu n'est lu
  # que par le garde-fou ci-dessous.
  local rendered
  rendered="$("${COMPOSE[@]}" config)"
  # Garde-fou : si la surcharge CI n'a pas retiré la réservation GPU, on échoue
  # ICI (message clair) plutôt qu'à la création du conteneur.
  if printf '%s' "$rendered" | grep -q 'driver: nvidia'; then
    die "la surcharge CI n'a pas neutralisé la réservation GPU (driver: nvidia)"
  fi
  log "Compose valide — réservation GPU neutralisée pour le runner sans GPU"
}

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '\033[31m[ci-smoke] Journaux du conteneur (après échec) :\033[0m\n' >&2
    "${COMPOSE[@]}" logs --tail=100 gateway >&2 || true
  fi
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}

run_smoke() {
  prepare
  trap cleanup EXIT

  log "Build de l'image gateway (Dockerfile multi-étage)"
  "${COMPOSE[@]}" build

  log "Démarrage du conteneur + attente du healthcheck Compose"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180

  log "Attente applicative de /health/live"
  local deadline=$(( $(date +%s) + 90 ))
  until curl -fsS "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "/health/live indisponible après 90 s"
    sleep 2
  done

  log "Assertions /health (porte GPU simulée depuis la fixture)"
  local health
  health="$(curl -fsS "http://127.0.0.1:${PORT}/health")"
  assert_jq "$health" '.status == "ok"' "le rapport GPU doit être en mode 'ok'"
  assert_jq "$health" '.gpu.source == "simulated"' "la source GPU doit être 'simulated' (fixture)"
  assert_jq "$health" '.profile == "confort"' "le profil résolu doit être 'confort'"
  assert_jq "$health" '.gpu.resolution == "override-accepted"' "résolution attendue 'override-accepted'"
  assert_jq "$health" '.gpu.gpus | length == 1' "un GPU simulé attendu"
  assert_jq "$health" '.gpu.gpus[0].name | test("RTX 4070")' "nom du GPU simulé attendu : RTX 4070"
  assert_jq "$health" '.gpu.gpus[0].computeCapability == 8.9' "compute capability attendue : 8.9"

  log "Assertions /health/ready (PiHost prêt & clé LLM légère présente)"
  local ready_code
  ready_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready")"
  [ "$ready_code" = "200" ] || die "/health/ready a renvoyé $ready_code (attendu 200)"

  log "Assertions volumes (tous montés ; rw inscriptibles ; ro non sondé)"
  assert_jq "$health" '[.volumes[] | select(.exists == false)] | length == 0' "tous les volumes doivent exister"
  assert_jq "$health" '(.volumes[] | select(.id=="pi")     | .writable) == true' "volume pi inscriptible attendu"
  assert_jq "$health" '(.volumes[] | select(.id=="state")  | .writable) == true' "volume state inscriptible attendu"
  assert_jq "$health" '(.volumes[] | select(.id=="models") | .writable) == null' "volume models en lecture seule attendu"

  log "Assertion conteneur non-root"
  [ "$("${COMPOSE[@]}" exec -T gateway id -u)" = "$UID_TARGET" ] || die "uid attendu $UID_TARGET"
  [ "$("${COMPOSE[@]}" exec -T gateway id -un)" = "yuki" ] || die "utilisateur attendu 'yuki'"

  log "Assertion rootfs read-only (écriture hors volume refusée)"
  if "${COMPOSE[@]}" exec -T gateway sh -c 'touch /app/ci-probe' >/dev/null 2>&1; then
    die "le rootfs est inscriptible alors qu'il doit être read-only"
  fi

  log "Assertion état du SDK écrit dans le volume (hors rootfs)"
  "${COMPOSE[@]}" exec -T gateway sh -c 'touch /data/state/ci-write-probe' \
    || die "écriture dans /data/state impossible (volume non inscriptible ?)"
  [ -f .local/pi/agent/settings.json ] || die "seed settings.json absent du volume pi"
  [ -f .local/pi/agent/models.json ]   || die "seed models.json absent du volume pi"
  [ -d .local/pi/agent/sessions ]      || die "répertoire de sessions absent du volume pi"

  log "SUCCÈS — image construite, conteneur non-root/read-only validé, /health OK"
}

case "$PHASE" in
  config) check_config ;;
  smoke)  run_smoke ;;
  all)    check_config; run_smoke ;;
  *)      die "phase inconnue : $PHASE (attendu : config | smoke | all)" ;;
esac
