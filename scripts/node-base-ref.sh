#!/usr/bin/env bash
# Yuki — node-base-ref.sh : choisit la RÉFÉRENCE de l'image de base Node à
# construire (miroir public `mirror.gcr.io` en premier, copie GHCR en repli).
#
# Pourquoi ce script existe :
#   * Docker/BuildKit n'a AUCUNE syntaxe de repli entre deux `FROM` (un second
#     `FROM` serait toujours tiré) ⇒ le basculement se fait à l'APPEL du build,
#     via `--build-arg NODE_BASE=…` (valeur par défaut du Dockerfile = miroir) ;
#   * un build qui attend 30 s un registre mort puis échoue sans nommer la
#     cause est inutilisable la nuit ⇒ on SONDE d'abord, on nomme la source
#     retenue, et on échoue BRUYAMMENT si aucune ne répond.
#
# Usage :
#   scripts/node-base-ref.sh            # « resolve » : sonde puis imprime la réf
#   scripts/node-base-ref.sh primary    # imprime la réf du miroir (défaut Dockerfile)
#   scripts/node-base-ref.sh fallback   # imprime la réf de repli (GHCR)
#   scripts/node-base-ref.sh probe <réf># 0 = manifeste servi, 1 = injoignable
#
# Sortie : UNE seule ligne sur stdout (référence complète) ; tous les
# diagnostics vont sur stderr (donc `REF="$(scripts/node-base-ref.sh)"` est sûr).
# Code de sortie non nul + message explicite si aucune source ne répond.
#
# Sondage SANS Docker (curl + API de distribution v2) : fonctionne même quand
# le démon Docker est indisponible, et n'ajoute aucun pull.
set -euo pipefail

# -----------------------------------------------------------------------------
# Références figées
#
# Le digest est celui de l'INDEX multi-arch de `node:24.21.0-bookworm-slim`
# (identique sur Docker Hub et sur le miroir : octets du manifeste comparés).
# ⚠️ Ne JAMAIS le recopier d'un fichier à l'autre : il est résolu par
# `scripts/pin-digests.sh`, qui imprime aussi le tag GHCR correspondant.
# -----------------------------------------------------------------------------
NODE_TAG="24.21.0-bookworm-slim"
NODE_DIGEST="sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"

PRIMARY_HOST="mirror.gcr.io"
PRIMARY_REPO="library/node"

# Le propriétaire GHCR est dérivé du dépôt en CI
# (`YUKI_GHCR_OWNER=${{ github.repository_owner }}`) ; la valeur par défaut
# correspond au dépôt de référence.
GHCR_OWNER="${YUKI_GHCR_OWNER:-grokuku}"
FALLBACK_HOST="ghcr.io"
FALLBACK_REPO="${GHCR_OWNER}/yuki-node-base"

# Le tag de repli CONTIENT le digest source : il ne peut pas « bouger » comme
# `24.21.0-bookworm-slim` (Node republie ses tags), et il rend la copie
# auto-documentée (`docker images` suffit à savoir ce qu'elle contient).
FALLBACK_TAG="${NODE_TAG}-${NODE_DIGEST/:/-}"

# Échappatoire documentée (dépannage, test de bascule) : les deux variables
# ci-dessous forcent une référence. Sans elles, les valeurs calculées ci-dessus
# s'appliquent — c'est le cas normal.
PRIMARY_REF="${YUKI_NODE_PRIMARY_REF:-${PRIMARY_HOST}/${PRIMARY_REPO}:${NODE_TAG}@${NODE_DIGEST}}"
FALLBACK_REF="${YUKI_NODE_FALLBACK_REF:-${FALLBACK_HOST}/${FALLBACK_REPO}:${FALLBACK_TAG}}"

ACCEPT="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

log() { printf '[node-base] %s\n' "$*" >&2; }
die() { printf '[node-base] ERREUR : %s\n' "$*" >&2; exit 1; }

# Découpe une référence `host/repo[:tag][@digest]`.
split_ref() { # <réf> → REF_HOST REF_REPO REF_OBJECT
  local ref="$1"
  REF_HOST="${ref%%/*}"
  local rest="${ref#*/}"
  if [ "$REF_HOST" = "$ref" ] || [ -z "${rest:-}" ]; then
    die "référence d'image mal formée (hôte manquant) : ${ref}"
  fi
  # Le dépôt est TOUJOURS ce qui précède `@` ou `:`, que la référence porte un
  # tag, un digest, ou les deux (`repo:tag@sha256:…`).
  local pathpart="${rest%%@*}"
  REF_REPO="${pathpart%%:*}"
  if [ "$pathpart" != "$rest" ]; then
    REF_OBJECT="${rest#*@}"            # @sha256:… (prime sur le tag)
  else
    REF_OBJECT="${pathpart##*:}"       # :tag
  fi
  # Dépôt nu (ex. « ghcr.io/owner/img ») : aucun objet ⇒ refus explicite.
  [ -n "${REF_OBJECT:-}" ] && [ "$REF_OBJECT" != "$pathpart" ] \
    || die "référence d'image sans tag ni digest : ${ref}"
}

# Récupère un jeton ANONYME à partir de l'en-tête `WWW-Authenticate`.
fetch_token() { # <réf> <fichier-en-têtes> → stdout = jeton
  local ref="$1" headers="$2" realm service
  realm="$(tr -d '\r' < "$headers" | sed -n 's/.*[Bb]earer[^,]*realm="\([^"]*\)".*/\1/p' | head -1)"
  service="$(tr -d '\r' < "$headers" | sed -n 's/.*[Bb]earer.*service="\([^"]*\)".*/\1/p' | head -1)"
  if [ -z "${realm:-}" ]; then
    die "challenge d'authentification illisible pour ${ref} (pas de « realm »)."
  fi
  split_ref "$ref"
  local url="${realm}?scope=repository:${REF_REPO}:pull"
  [ -n "${service:-}" ] && url="${url}&service=${service}"
  # Extraction sans dépendance à `node` (ce script tourne AVANT toute mise en
  # place de Node en CI) : le jeton est du base64url, sans guillemet ni échappe.
  ( curl -fsSL --max-time 20 "$url" 2>/dev/null || true ) \
    | tr -d '\n' \
    | sed -n 's/.*"\(token\|access_token\)":"\([^"]*\)".*/\2/p' \
    | head -1
}

# Sonde un manifeste : 0 = servi par le registre, 1 = injoignable / absent.
probe_ref() { # <réf>
  local ref="$1" code body headers token=""
  command -v curl >/dev/null 2>&1 || die "curl requis pour sonder ${ref}."
  body="$(mktemp)"; headers="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${body}' '${headers}'" RETURN

  split_ref "$ref"
  local url="https://${REF_HOST}/v2/${REF_REPO}/manifests/${REF_OBJECT}"

  code="$(curl -sS --max-time 20 -o "$body" -D "$headers" -w '%{http_code}' \
    -H "Accept: ${ACCEPT}" "$url" 2>/dev/null || true)"
  # curl n'écrit pas toujours le code en cas d'échec réseau : sentinelle.
  [ -n "${code:-}" ] || code="000"

  if [ "$code" = "401" ] || [ "$code" = "403" ]; then
    token="$(fetch_token "$ref" "$headers" || true)"
    if [ -z "$token" ]; then
      log "${ref} : accès refusé (HTTP ${code}) — paquet absent de ce registre, ou privé."
      return 1
    fi
    code="$(curl -sS --max-time 20 -o "$body" -D "$headers" -w '%{http_code}' \
      -H "Authorization: Bearer ${token}" -H "Accept: ${ACCEPT}" "$url" 2>/dev/null || true)"
    [ -n "${code:-}" ] || code="000"
  fi

  case "$code" in
    200)
      # Contrôle de cohérence quand la référence porte un DIGEST (un miroir qui
      # servirait autre chose que ce qui est demandé serait un piège silencieux).
      # Pour une référence par TAG, l'en-tête annonce forcément un digest : ce
      # n'est pas une incohérence.
      local announced
      announced="$(tr -d '\r' < "$headers" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | head -1)"
      if [ -n "${announced:-}" ] && [ "${REF_OBJECT#sha256:}" != "$REF_OBJECT" ] \
        && [ "$announced" != "$REF_OBJECT" ]; then
        log "⚠️ ${ref} : le registre annonce ${announced} (attendu ${REF_OBJECT})."
      fi
      return 0
      ;;
    000) log "${ref} : registre INJOIGNABLE (réseau/DNS/timeout)." ;;
    404) log "${ref} : ABSENT de ce registre (HTTP 404)." ;;
    *)   log "${ref} : réponse inattendue du registre (HTTP ${code})." ;;
  esac
  return 1
}

cmd="${1:-resolve}"

case "$cmd" in
  primary)
    printf '%s\n' "$PRIMARY_REF"
    ;;
  fallback)
    printf '%s\n' "$FALLBACK_REF"
    ;;
  probe)
    [ $# -ge 2 ] || die "usage : $0 probe <référence>"
    if probe_ref "$2"; then
      log "$2 : manifeste servi."
      exit 0
    fi
    exit 1
    ;;
  resolve)
    for ref in "$PRIMARY_REF" "$FALLBACK_REF"; do
      if probe_ref "$ref"; then
        if [ "$ref" = "$FALLBACK_REF" ]; then
          log "⚠️ REPLI : le miroir public ne répond pas — construction depuis GHCR."
          log "   Réalimenter le miroir : voir docs/versions.md § « Réalimentation du miroir »."
        else
          log "Source : miroir public (${PRIMARY_HOST})."
        fi
        printf '%s\n' "$ref"
        exit 0
      fi
    done
    die "aucune source d'image de base ne répond :
  - ${PRIMARY_REF}
  - ${FALLBACK_REF}
Vérifier le réseau, puis réalimenter GHCR (workflow « Miroir image de base (GHCR) »)
ou attendre la fin du quota du registre. Rien n'a été construit."
    ;;
  *)
    die "commande inconnue « ${cmd} » (attendu : resolve | primary | fallback | probe <réf>)"
    ;;
esac
