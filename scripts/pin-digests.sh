#!/usr/bin/env bash
# Yuki — pin-digests.sh : RÉSOUT le digest du tag de l'image de base Node sur
# le MIROIR PUBLIC `mirror.gcr.io` et affiche toutes les valeurs à recopier
# (Dockerfile, scripts/node-base-ref.sh, workflow de repli, docs).
#
# Pourquoi ce script existe : un tag Node peut être REPUBLIÉ (c'est arrivé : un
# digest figé a été périmé une première fois). On ne recopie donc JAMAIS un
# digest « de mémoire » : on l'interroge, on le VÉRIFIE (sha256 des octets
# bruts du manifeste + en-tête `Docker-Content-Digest`), puis on compare aux
# valeurs du dépôt pour signaler une dérive.
#
# Registres :
#   * `mirror.gcr.io` = miroir PUBLIC de Docker Hub, SANS compte ⇒ pas de quota
#     par IP comme ECR Public (qui a fini par renvoyer `429 toomanyrequests`)
#     ni comme Docker Hub (100 pulls / 6 h / IP). C'est la source PRIMAIRE ;
#   * `ghcr.io/<propriétaire>/yuki-node-base:<tag-avec-digest>` = copie de
#     REPLI, réalisée par le workflow `mirror-node-base.yml` (manuel).
#
# Nécessite un accès réseau au registre. N'ÉCRIT RIEN : propose.
#
# Usage :
#   ./scripts/pin-digests.sh
#   ./scripts/pin-digests.sh node 24.21.0-bookworm-slim
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY_HOST="${YUKI_NODE_REGISTRY_HOST:-mirror.gcr.io}"
REGISTRY_PATH="library"
IMAGE="${1:-node}"
TAG="${2:-24.21.0-bookworm-slim}"
DOCKERFILE="infra/gateway/Dockerfile"
REF_SOURCE="scripts/node-base-ref.sh"
WORKFLOW=".github/workflows/mirror-node-base.yml"
DOC="docs/versions.md"

ACCEPT="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"

log() { printf '[pin-digests] %s\n' "$*" >&2; }
die() { printf '[pin-digests] ERREUR : %s\n' "$*" >&2; exit 1; }

REF="${REGISTRY_HOST}/${REGISTRY_PATH}/${IMAGE}:${TAG}"
echo "[pin-digests] résolution de ${REF}"

DIGEST=""
ANNOUNCED=""

# --- Voie 1 : `docker manifest inspect` (si un démon/CLI Docker est présent) --
if command -v docker >/dev/null 2>&1 && docker manifest inspect "${REF}" >/dev/null 2>&1; then
  DIGEST="$(docker manifest inspect --verbose "${REF}" 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { const j=JSON.parse(d); const v=Array.isArray(j)?j[0]:j; console.log(v.Descriptor?.digest ?? v.digest ?? ''); }
      catch { console.log(''); }
    });")"
  [ -n "${DIGEST}" ] && log "digest obtenu via « docker manifest inspect »."
fi

# --- Voie 2 : API de distribution v2 (repli sans Docker) ---------------------
if [ -z "${DIGEST}" ]; then
  command -v curl >/dev/null 2>&1 || die "curl (ou docker) requis pour interroger ${REGISTRY_HOST}."

  URL="https://${REGISTRY_HOST}/v2/${REGISTRY_PATH}/${IMAGE}/manifests/${TAG}"
  BODY="$(mktemp)"; HEADERS="$(mktemp)"
  trap 'rm -f "${BODY}" "${HEADERS}"' EXIT

  CODE="$(curl -sS --max-time 30 -o "${BODY}" -D "${HEADERS}" -w '%{http_code}' \
    -H "Accept: ${ACCEPT}" "${URL}" || true)"
  [ -n "${CODE:-}" ] || CODE="000"

  # Certains registres exigent un jeton même pour lire (Docker Hub, GHCR).
  # `mirror.gcr.io` sert anonymement, mais on garde le chemin générique.
  if [ "${CODE}" = "401" ] || [ "${CODE}" = "403" ]; then
    REALM="$(tr -d '\r' < "${HEADERS}" | sed -n 's/.*[Bb]earer[^,]*realm="\([^"]*\)".*/\1/p' | head -1)"
    SERVICE="$(tr -d '\r' < "${HEADERS}" | sed -n 's/.*[Bb]earer.*service="\([^"]*\)".*/\1/p' | head -1)"
    [ -n "${REALM}" ] || die "challenge d'authentification illisible (${CODE}) pour ${REF}."
    TOKEN_URL="${REALM}?scope=repository:${REGISTRY_PATH}/${IMAGE}:pull"
    [ -n "${SERVICE}" ] && TOKEN_URL="${TOKEN_URL}&service=${SERVICE}"
    TOKEN="$(curl -fsSL --max-time 30 "${TOKEN_URL}" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.token||j.access_token||'')}catch{process.stdout.write('')}})")"
    [ -n "${TOKEN}" ] || die "jeton refusé pour ${REF} (${CODE})."
    CODE="$(curl -sS --max-time 30 -o "${BODY}" -D "${HEADERS}" -w '%{http_code}' \
      -H "Authorization: Bearer ${TOKEN}" -H "Accept: ${ACCEPT}" "${URL}" || true)"
  fi

  case "${CODE}" in
    200) ;;
    000) die "${REF} : registre INJOIGNABLE (réseau/DNS)." ;;
    404) die "${REF} : tag ABSENT de ${REGISTRY_HOST}." ;;
    *)   die "${REF} : réponse inattendue du registre (HTTP ${CODE})." ;;
  esac

  # Digest = sha256 des OCTETS BRUTS du manifeste (définition même du digest
  # OCI). On le COMPARE à l'en-tête annoncé par le registre : deux méthodes
  # indépendantes, donc une divergence ne passe pas inaperçue.
  if command -v sha256sum >/dev/null 2>&1; then
    HEX="$(sha256sum "${BODY}" | awk '{print $1}')"
  else
    HEX="$(shasum -a 256 "${BODY}" | awk '{print $1}')"
  fi
  DIGEST="sha256:${HEX}"
  ANNOUNCED="$(tr -d '\r' < "${HEADERS}" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -1)"
  if [ -n "${ANNOUNCED}" ] && [ "${ANNOUNCED}" != "${DIGEST}" ]; then
    die "digest calculé (${DIGEST}) ≠ digest annoncé par ${REGISTRY_HOST} (${ANNOUNCED}). Manifeste réécrit en vol ? Ne pas épingler."
  fi
  [ -n "${ANNOUNCED}" ] && log "digest calculé ET confirmé par l'en-tête Docker-Content-Digest."
fi

if [ -z "${DIGEST:-}" ]; then
  die "échec de résolution du digest."
fi

FALLBACK_TAG="${TAG}-${DIGEST/:/-}"
GHCR_OWNER="$(sed -n 's/^GHCR_OWNER="\${YUKI_GHCR_OWNER:-\(.*\)}"$/\1/p' "${REF_SOURCE}" 2>/dev/null | head -1)"
GHCR_OWNER="${GHCR_OWNER:-grokuku}"

cat <<EOF

Digest résolu (index multi-arch) : ${DIGEST}

À reporter (les QUATRE emplacements doivent rester identiques) :

  1) ${DOCKERFILE}
     ARG NODE_BASE=${REF}@${DIGEST}

  2) ${REF_SOURCE}
     NODE_DIGEST="${DIGEST}"

  3) ${WORKFLOW} (valeurs par défaut des entrées)
     source_image: "${REF}@${DIGEST}"
     target_tag:   "${FALLBACK_TAG}"

  4) ${DOC}
     tableau « Image de base » + § « Réalimentation du miroir (repli GHCR) »

Référence de REPLI (GHCR, produite par le workflow « Miroir image de base (GHCR) ») :

  ghcr.io/${GHCR_OWNER}/yuki-node-base:${FALLBACK_TAG}

EOF

# --- Contrôle de dérive : tout digest figé du dépôt doit correspondre --------
echo "Contrôle de cohérence des valeurs déjà écrites :"
STALE=0
for f in "${DOCKERFILE}" "${REF_SOURCE}" "${WORKFLOW}" "${DOC}"; do
  [ -f "${f}" ] || { echo "  ? ${f} introuvable"; continue; }
  if grep -q "${DIGEST}" "${f}"; then
    echo "  OK  ${f}"
  elif grep -q 'sha256:[0-9a-f]\{64\}' "${f}"; then
    echo "  ⚠️  ${f} contient un AUTRE digest (périmé ?) :"
    grep -o 'sha256:[0-9a-f]\{64\}' "${f}" | sort -u | sed 's/^/        /'
    STALE=1
  else
    echo "  –  ${f} (aucun digest)"
  fi
done

if [ "${STALE}" -ne 0 ]; then
  echo
  echo "⚠️  Au moins un fichier porte un digest différent de celui du tag ${TAG}."
  echo "    Un tag Node REPUBLIÉ rend un digest périmé : reporter les valeurs ci-dessus."
fi

echo
echo "Rappel : le build n'utilise PAS ce script — il lit la valeur par défaut de"
echo "l'ARG du Dockerfile (ou \`--build-arg NODE_BASE=…\`). Ce script ne modifie rien."
