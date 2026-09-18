# syntax=docker/dockerfile:1

# =============================================================================
# Yuki gateway — image runtime (Lots 0-1)
#
# Base épinglée par digest (index multi-arch officiel `node:24.21.0-bookworm-slim`).
# Aucun tag flottant. Node 26 (Current) est explicitement interdit.
# =============================================================================

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS base

# IMPORTANT : `NODE_ENV=production` n'est PAS déclaré ici, sinon il serait hérité
# par les étages `deps` et `builder` : `npm ci` appliquerait alors `omit=dev` et
# n'installerait pas les devDependencies (ni `tsc`, ni `tsx`), cassant le build.
# Il est donc déclaré uniquement dans l'étage `runtime` (voir plus bas).
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# -----------------------------------------------------------------------------
# deps — couche de dépendances (cache amont, invalidée uniquement par le lockfile)
# -----------------------------------------------------------------------------
FROM base AS deps

COPY package.json package-lock.json ./
# `--include=dev` explicite : `tsc` (build) et `tsx` (dev) sont requis dans cet étage.
RUN npm ci --include=dev

# -----------------------------------------------------------------------------
# builder — compilation TypeScript (tsc)
# -----------------------------------------------------------------------------
FROM base AS builder

# Réutilise la couche de dépendances (cache amont).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# -----------------------------------------------------------------------------
# runtime — image finale : dépendances runtime figées, utilisateur non-root
# -----------------------------------------------------------------------------
FROM base AS runtime

ARG YUKI_UID=1000
ARG YUKI_GID=1000

# L'image `node` fournit déjà un utilisateur `node` (uid/gid 1000) : on le
# remplace par `yuki` afin que le nom et l'identité non-root coïncident.
RUN set -eux; \
    if getent passwd node >/dev/null 2>&1; then userdel -r node || true; fi; \
    if getent group node >/dev/null 2>&1; then groupdel node || true; fi; \
    groupadd --gid "${YUKI_GID}" yuki; \
    useradd --uid "${YUKI_UID}" --gid "${YUKI_GID}" \
      --home-dir /app --shell /usr/sbin/nologin yuki; \
    mkdir -p /data/pi /data/state /workspace /models

# Dépendances de production uniquement (SDK Pi + `ws`, versions figées sans
# caret). `NODE_ENV=production` est confiné à cet étage et n'affecte donc pas
# `deps`/`builder`.
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Artefacts compilés + manifestes de configuration + UI statique.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config
COPY public ./public

USER yuki

EXPOSE 8080

ENTRYPOINT ["node", "dist/index.js"]
