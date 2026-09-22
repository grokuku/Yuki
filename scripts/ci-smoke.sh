#!/usr/bin/env bash
# =============================================================================
# Yuki — ci-smoke.sh
#
# Valide, DANS UN RUNNER SANS GPU ni NVIDIA Container Toolkit :
#   1. `docker compose config` : le YAML Compose est réellement valide ;
#   2. le build LOCAL de l'image `gateway` (Dockerfile multi-étage) ;
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
# La surcharge `.github/ci/compose.ci.yml` ajoute le build local (le compose de
# base TIRE l'image publiée), retire la réservation GPU (absente sur le runner)
# et injecte la fixture. Aucun secret n'est requis.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PHASE="${1:-all}"

log() { printf '\n\033[1m[ci-smoke] %s\033[0m\n' "$*"; }
die() { printf '\033[31m[ci-smoke] ÉCHEC : %s\033[0m\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "outil requis introuvable : $1"; }

# Les contrôles d'assertions N'ARRÊTENT PAS le script au premier échec : chacun
# incrémente `FAILURES`, et `finish_assertions` échoue une seule fois à la fin.
# But : rapporter TOUS les problèmes en un seul run (les causes sont souvent
# liées — ex. volume nommé non inscriptible -> /health/ready ET montages).
FAILURES=0
fail() { printf '\033[31m[ci-smoke] assertion échouée : %s\033[0m\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
finish_assertions() { [ "$FAILURES" -eq 0 ] || die "$FAILURES assertion(s) échouée(s) — voir ci-dessus"; }

# `.env` (gitignoré) pilote l'identité du conteneur (`user:`). On le crée depuis
# `.env.example` s'il est absent, puis on le CHARGE pour connaître le uid/gid
# attendu du conteneur (assertion non-root ci-dessous).
if [ ! -f .env ]; then
  log "Création de .env depuis .env.example (valeurs factices, aucun secret)"
  cp .env.example .env
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

PORT="${YUKI_GATEWAY_PORT:-8080}"
UID_TARGET="${YUKI_UID:-1000}"

# Contexte de build ABSOLU (voir `.github/ci/compose.ci.yml`) : lève toute
# ambiguïté de résolution des chemins relatifs entre plusieurs `-f`.
export YUKI_CI_BUILD_CONTEXT="$ROOT"

# Chemin HÔTE (absolu) de la fixture nvidia-smi montée dans le conteneur.
export YUKI_CI_GPU_FIXTURE="${YUKI_CI_GPU_FIXTURE:-$ROOT/tests/fixtures/gpu/rtx4070-12g.txt}"

COMPOSE=(docker compose -f docker-compose.yml -f .github/ci/compose.ci.yml)

assert_jq() { # <json> <filtre jq> <message>
  printf '%s' "$1" | jq -e "$2" >/dev/null 2>&1 || fail "$3 (jq: $2)"
}

prepare() {
  need docker
  need curl
  need jq
  docker compose version >/dev/null 2>&1 || die "docker compose (v2) requis"
  if [ -z "${YUKI_CI_GPU_FIXTURE:-}" ] || [ ! -f "$YUKI_CI_GPU_FIXTURE" ]; then
    die "fixture nvidia-smi introuvable : ${YUKI_CI_GPU_FIXTURE:-<vide>}"
  fi
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

  log "Build LOCAL de l'image gateway (Dockerfile multi-étage)"
  "${COMPOSE[@]}" build

  log "Démarrage du conteneur + attente du healthcheck Compose"
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180

  log "Attente applicative de /health/live"
  local deadline=$(( $(date +%s) + 90 ))
  until curl -fsS "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || die "/health/live indisponible après 90 s"
    sleep 2
  done

  # À partir d'ici les contrôles sont NON bloquants : ils alimentent `FAILURES`
  # et `finish_assertions` échoue une seule fois à la fin. Le build/up et
  # l'attente de /health/live, eux, restent bloquants (sans conteneur, rien à
  # tester) : ce sont des préalables, pas des assertions.
  FAILURES=0

  log "Assertions /health (porte GPU simulée depuis la fixture)"
  local health
  health="$(curl -fsS "http://127.0.0.1:${PORT}/health")"
  assert_jq "$health" '.status == "ok"' "le rapport GPU doit être en mode 'ok'"
  assert_jq "$health" '.gpu.source == "simulated"' "la source GPU doit être 'simulated' (fixture)"
  assert_jq "$health" '.profile == "confort"' "le profil résolu doit être 'confort'"
  assert_jq "$health" '.gpu.resolution == "auto-highest-compatible"' "résolution attendue 'auto-highest-compatible'"
  assert_jq "$health" '.gpu.gpus | length == 1' "un GPU simulé attendu"
  assert_jq "$health" '.gpu.gpus[0].name | test("RTX 4070")' "nom du GPU simulé attendu : RTX 4070"
  assert_jq "$health" '.gpu.gpus[0].computeCapability == 8.9' "compute capability attendue : 8.9"

  # --- Premier démarrage SANS aucune clé (Lot 11) --------------------------
  log "Assertions Lot 11 — démarrage sans clé : /health/ready=503 et config 200"
  local ready_code
  ready_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready")"
  [ "$ready_code" = "503" ] || fail "/health/ready a renvoyé $ready_code (attendu 503 sans clé légère)"

  local config_code config_before
  config_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/config")"
  [ "$config_code" = "200" ] || fail "GET /api/config a renvoyé $config_code (attendu 200 en mode dégradé)"
  config_before="$(curl -fsS "http://127.0.0.1:${PORT}/api/config")"
  assert_jq "$config_before" '.status.lightKey == false' "lightKey doit être false sans clé"
  assert_jq "$config_before" '.status.heavyKey == false' "heavyKey doit être false sans clé"
  assert_jq "$config_before" '.fields["llm.light.apiKey"].configured == false' "clé légère non configurée attendue"

  log "Assertions Lot 11 — PUT des clés FICTIVES via l'API puis bascule à chaud"
  local light_key="fake-light-key-000000000000" heavy_key="fake-heavy-key-111111111111"
  local put_code
  # `Origin` = `Host` : reproduit un envoi depuis le navigateur (accès par IP/hôte).
  put_code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H 'content-type: application/json' -H 'X-Yuki-Config: 1' \
    -H "Origin: http://127.0.0.1:${PORT}" \
    --data "$(printf '{"llm.light.apiKey":"%s","llm.heavy.apiKey":"%s"}' "$light_key" "$heavy_key")" \
    "http://127.0.0.1:${PORT}/api/config")"
  [ "$put_code" = "200" ] || fail "PUT /api/config a renvoyé $put_code (attendu 200)"

  # Une origine étrangère doit rester refusée (403), même avec l'en-tête exigé.
  local bad_origin_code
  bad_origin_code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
    -H 'content-type: application/json' -H 'X-Yuki-Config: 1' -H 'Origin: http://evil.example' \
    --data '{}' "http://127.0.0.1:${PORT}/api/config")"
  [ "$bad_origin_code" = "403" ] || fail "PUT origine étrangère a renvoyé $bad_origin_code (attendu 403)"

  local config_after
  config_after="$(curl -fsS "http://127.0.0.1:${PORT}/api/config")"
  assert_jq "$config_after" '.status.lightKey == true' "lightKey doit passer à true après PUT"
  assert_jq "$config_after" '.status.heavyKey == true' "heavyKey doit passer à true après PUT"
  assert_jq "$config_after" '.fields["llm.light.apiKey"].configured == true' "clé légère configurée attendue"
  # Aucune valeur en clair dans le corps brut de la réponse.
  case "$config_after" in
    *"$light_key"*|*"$heavy_key"*) fail "GET /api/config expose une clé en clair" ;;
  esac

  log "Assertions Lot 11 — /health/ready passe à 200 (présence de clé, aucun réseau)"
  ready_code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready")"
  [ "$ready_code" = "200" ] || fail "/health/ready a renvoyé $ready_code (attendu 200 après saisie des clés)"

  log "Assertion Lot 11 — page /config servie avec des en-têtes sûrs"
  local config_headers
  config_headers="$(curl -s -D - -o /dev/null "http://127.0.0.1:${PORT}/config")"
  printf '%s' "$config_headers" | grep -qi 'content-type: text/html' \
    || fail "/config ne sert pas de HTML"
  printf '%s' "$config_headers" | grep -qi 'x-content-type-options: nosniff' \
    || fail "/config sans en-tête nosniff"
  printf '%s' "$config_headers" | grep -qi "content-security-policy" \
    || fail "/config sans content-security-policy"

  log "Assertions volumes (tous montés ; rw inscriptibles ; ro non sondé)"
  assert_jq "$health" '[.volumes[] | select(.exists == false)] | length == 0' "tous les volumes doivent exister"
  assert_jq "$health" '(.volumes[] | select(.id=="pi")     | .writable) == true' "volume pi inscriptible attendu"
  assert_jq "$health" '(.volumes[] | select(.id=="state")  | .writable) == true' "volume state inscriptible attendu"
  # Lot 9 (M1) : le gateway monte `/models` en `rw` (écriture des futurs
  # téléchargements) ; le moteur `tts`, lui, le monte en `ro`.
  assert_jq "$health" '(.volumes[] | select(.id=="models") | .writable) == true' "volume models inscriptible attendu (M1)"

  log "Assertion conteneur non-root"
  local uid name
  uid="$("${COMPOSE[@]}" exec -T gateway id -u)"
  name="$("${COMPOSE[@]}" exec -T gateway id -un)"
  [ "$uid" = "$UID_TARGET" ] || fail "uid conteneur attendu $UID_TARGET, obtenu '$uid'"
  [ "$name" = "yuki" ] || fail "utilisateur conteneur attendu 'yuki', obtenu '$name'"

  log "Assertion rootfs read-only (écriture hors volume refusée)"
  if "${COMPOSE[@]}" exec -T gateway sh -c 'touch /app/ci-probe' >/dev/null 2>&1; then
    fail "le rootfs est inscriptible alors qu'il doit être read-only"
  fi

  log "Assertion état du SDK écrit dans le volume pi (hors rootfs)"
  "${COMPOSE[@]}" exec -T gateway sh -c 'touch /data/state/ci-write-probe' \
    || fail "écriture dans /data/state impossible (volume non inscriptible ?)"
  "${COMPOSE[@]}" exec -T gateway sh -c 'test -f /data/pi/agent/settings.json' \
    || fail "seed settings.json absent du volume pi"
  "${COMPOSE[@]}" exec -T gateway sh -c 'test -f /data/pi/agent/models.json' \
    || fail "models.json généré absent du volume pi"
  "${COMPOSE[@]}" exec -T gateway sh -c 'test -f /data/state/config.json' \
    || fail "store de configuration absent du volume state"
  "${COMPOSE[@]}" exec -T gateway sh -c 'test -d /data/pi/agent/sessions' \
    || fail "répertoire de sessions absent du volume pi"

  finish_assertions

  log "SUCCÈS — image construite, conteneur non-root/read-only validé, /health OK, config web OK"
}

case "$PHASE" in
  config) check_config ;;
  smoke)  run_smoke ;;
  all)    check_config; run_smoke ;;
  *)      die "phase inconnue : $PHASE (attendu : config | smoke | all)" ;;
esac
