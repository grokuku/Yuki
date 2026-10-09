#!/usr/bin/env bash
# Yuki — pin-digests.sh : résout le digest du tag d'image sur le MIROIR AWS ECR
# Public et affiche la ligne `FROM ...@sha256:...` à écrire dans
# infra/gateway/Dockerfile.
#
# Le registre de base est `public.ecr.aws/docker/library` (miroir public des
# images officielles Docker). Il est utilisé pour éviter le rate limit
# « non authentifié » de Docker Hub (100 pulls / 6 h / IP), atteint de façon
# récurrente sur les runners GitHub à IP partagées.
#
# ⚠️ ECR Public n'émet PAS l'en-tête `Docker-Content-Digest` : le digest est
# calculé à partir des OCTETS BRUTS du manifeste (sha256), ce qui est la
# définition même du digest OCI. Les octets servis par ECR Public sont
# identiques à ceux de Docker Hub (vérifié : le sha256 redonne l'empreinte
# annoncée par Docker Hub).
#
# Nécessite un accès réseau au registre ECR Public. N'écrit rien : propose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGISTRY_HOST="public.ecr.aws"
REGISTRY_PATH="docker/library"
IMAGE="${1:-node}"
TAG="${2:-24.21.0-bookworm-slim}"
DOCKERFILE="infra/gateway/Dockerfile"

REF="${REGISTRY_HOST}/${REGISTRY_PATH}/${IMAGE}:${TAG}"

echo "[pin-digests] résolution de ${REF}"

DIGEST=""

# Voie privilégiée : `docker manifest inspect` (si Docker est disponible).
if command -v docker >/dev/null 2>&1 && docker manifest inspect "${REF}" >/dev/null 2>&1; then
  DIGEST="$(docker manifest inspect --verbose "${REF}" 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { const j=JSON.parse(d); const v=Array.isArray(j)?j[0]:j; console.log(v.Descriptor?.digest ?? v.digest ?? ''); }
      catch { console.log(''); }
    });")"
fi

# Repli HTTP : jeton éphémère + manifeste, digest = sha256 des octets bruts.
if [ -z "${DIGEST}" ]; then
  TOKEN="$(curl -fsSL "https://${REGISTRY_HOST}/token/?service=${REGISTRY_HOST}&scope=repository:${REGISTRY_PATH}/${IMAGE}:pull" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token));")"

  MANIFEST="$(mktemp)"
  trap 'rm -f "${MANIFEST}"' EXIT

  curl -fsSL -o "${MANIFEST}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json" \
    "https://${REGISTRY_HOST}/v2/${REGISTRY_PATH}/${IMAGE}/manifests/${TAG}"

  # sha256sum (coreutils) ou shasum (perl) selon la plateforme.
  if command -v sha256sum >/dev/null 2>&1; then
    HEX="$(sha256sum "${MANIFEST}" | awk '{print $1}')"
  else
    HEX="$(shasum -a 256 "${MANIFEST}" | awk '{print $1}')"
  fi
  DIGEST="sha256:${HEX}"
fi

if [ -z "${DIGEST:-}" ]; then
  echo "[pin-digests] échec de résolution du digest." >&2
  exit 1
fi

echo
echo "Digest résolu : ${DIGEST}"
echo
echo "Ligne FROM à utiliser :"
echo
echo "  FROM ${REF}@${DIGEST} AS base"
echo
echo "Dockerfile ciblé : ${DOCKERFILE}"
echo "Étage AS base actuel :"
grep -n "^FROM .* AS base" "$DOCKERFILE" || true
