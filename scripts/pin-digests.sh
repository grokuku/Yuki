#!/usr/bin/env bash
# Yuki — pin-digests.sh : résout le digest du tag d'image et affiche la ligne
# `FROM ...@sha256:...` à écrire dans infra/gateway/Dockerfile.
#
# Nécessite un accès réseau au registre Docker Hub. N'écrit rien : propose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${1:-node}"
TAG="${2:-24.21.0-bookworm-slim}"
DOCKERFILE="infra/gateway/Dockerfile"

echo "[pin-digests] résolution de ${IMAGE}:${TAG}"

if command -v docker >/dev/null 2>&1 && docker manifest inspect "${IMAGE}:${TAG}" >/dev/null 2>&1; then
  DIGEST="$(docker manifest inspect --verbose "${IMAGE}:${TAG}" 2>/dev/null | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try { const j=JSON.parse(d); const v=Array.isArray(j)?j[0]:j; console.log(v.Descriptor?.digest ?? v.digest ?? ''); }
      catch { console.log(''); }
    });")"
fi

if [ -z "${DIGEST:-}" ]; then
  TOKEN="$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${IMAGE}:pull" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token));")"
  DIGEST="$(curl -fsSL -D - -o /dev/null \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json" \
    "https://registry-1.docker.io/v2/library/${IMAGE}/manifests/${TAG}" \
    | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:"{print $2}')"
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
echo "  FROM ${IMAGE}:${TAG}@${DIGEST} AS base"
echo
echo "Dockerfile ciblé : ${DOCKERFILE}"
echo "Étage AS base actuel :"
grep -n "^FROM .* AS base" "$DOCKERFILE" || true
