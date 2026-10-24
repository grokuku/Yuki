# Versions verrouillées

Audit daté du **16/09/2026** (registre de base revu le **24/10/2026**). Toute
mise à jour de ce tableau est un changement explicite, jamais une dérive de tag.

## Image de base

| Élément | Version | Note |
| --- | --- | --- |
| Image gateway | `mirror.gcr.io/library/node:24.21.0-bookworm-slim` | **épinglée par digest `@sha256:…`** (miroir **public** de Docker Hub) |
| Digest (index multi-arch) | `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` | **résolu** le 24/10/2026 via `scripts/pin-digests.sh` (sha256 du manifeste + en-tête `Docker-Content-Digest` concordants) |
| Repli (GHCR) | `ghcr.io/<propriétaire>/yuki-node-base:24.21.0-bookworm-slim-sha256-d6aa754f…f87b20` | copie réalisée par le workflow **manuel** « Miroir image de base (GHCR) » — voir § *Réalimentation* |
| Node runtime | 24.21.0 (LTS) | `node:latest` = Node 26 Current → **interdit** |

> **Pourquoi ce registre (et pas Docker Hub ni ECR Public).** Docker Hub
> rationne les pulls anonymes (100 / 6 h / IP) — les runners CI à IP partagées
> tombaient en `429`. ECR Public avait été choisi comme contournement ; son
> quota **sans compte** est **partagé par plage d'adresse IP**, donc les runners
> ont fini par recevoir `429 toomanyrequests: Data limit exceeded` **eux
> aussi** (deux pannes en une semaine). `mirror.gcr.io` est un **miroir public**
> de Docker Hub : mêmes octets (vérifié : manifeste identique à
> `registry-1.docker.io`, sha256 concordant), avec un quota tenable pour la CI.
>
> ⚠️ **Ne jamais recopier un digest « de mémoire »** : Node **republie** ses
> tags, ce qui a déjà périmé un digest figé. Le digest se **résout**
> (`scripts/pin-digests.sh`, qui signale toute dérive entre les quatre
> emplacements à maintenir : Dockerfile, `scripts/node-base-ref.sh`,
> `.github/workflows/mirror-node-base.yml`, ce fichier).

### Où la source est définie

| Fichier | Rôle |
| --- | --- |
| `infra/gateway/Dockerfile` | `ARG NODE_BASE=…` **avant le premier `FROM`**, puis `FROM ${NODE_BASE}` — **seule** chose qui change de registre |
| `scripts/node-base-ref.sh` | sonde les registres et imprime la référence à utiliser (`resolve` / `primary` / `fallback` / `probe <réf>`) ; `YUKI_NODE_PRIMARY_REF` / `YUKI_NODE_FALLBACK_REF` permettent de forcer une référence en dépannage |
| `scripts/ci-smoke.sh` | passe `--build-arg NODE_BASE=…` et **réessaie sur GHCR** si le build échoue avec le miroir |
| `.github/workflows/release.yml` | même bascule (deux étapes de build, la seconde conditionnée à l'échec de la première) |
| `.github/workflows/mirror-node-base.yml` | **réalimente** la copie de repli dans GHCR (manuel) |

> **Pourquoi un `ARG` et pas « deux `FROM` » ?** Docker/BuildKit n'a **aucune**
> syntaxe de repli entre deux `FROM` : un second `FROM` serait **toujours** tiré,
> donc un registre mort ferait échouer le build quoi qu'il arrive. Le choix se
> fait donc **à l'appel du build** (`--build-arg`), et la CI le fait pour nous.

### Réalimentation du miroir (repli GHCR)

Le repli n'existe que s'il a **déjà** été rempli. À faire une fois, puis à
refaire à chaque changement de digest.

1. **Onglet Actions → « Miroir image de base (GHCR) » → Run workflow.**
   Laisser les valeurs par défaut (source = `mirror.gcr.io/…@sha256:d6aa754f…`,
   tag = `24.21.0-bookworm-slim-sha256-d6aa754f…`).
2. Le job **`preflight`** échoue **exprès et tout de suite** si la source est
   injoignable (quota, image retirée) ou si le tag ne contient pas le digest
   source — rien n'est publié dans ce cas.
3. Le job **`mirror`** fait `docker pull` → `docker tag` → `docker push`, puis
   **re-tire** la copie depuis GHCR et vérifie qu'elle a la **même identité**
   (digest de configuration) que la source. Échec = code non nul + `::error::`.
4. Vérifier ensuite côté local que la bascule fonctionne réellement :

   ```bash
   ./scripts/node-base-ref.sh resolve      # doit imprimer le miroir
   ./scripts/node-base-ref.sh fallback     # doit imprimer la référence GHCR
   ./scripts/node-base-ref.sh probe "$(./scripts/node-base-ref.sh fallback)"
   ```

**Si le repli GHCR est vide** (404 / « accès refusé ») au moment où le miroir
est en quota : le build ne peut pas démarrer. Deux issues, dans cet ordre :

- relancer le workflow de réalimentation **dès que la source répond** (le quota
  se réinitialise ; le workflow refusera tant que la source est bloquée) ;
- en dernier recours, construire depuis une copie locale déjà présente sur le
  runner/hôte : `docker build --build-arg NODE_BASE=<réf locale> …`.

Ce qui n'est **pas** garanti : si le paquet `yuki-node-base` est **privé**, le
runner CI anonyme ne pourra pas le tirer — le garder **public** (la copie ne
contient que l'image Node officielle, aucun secret).

### Autres images tirées (même classe de risque)

| Image | Où | Registre |
| --- | --- | --- |
| `ghcr.io/0xshug0/audio.cpp:full-cuda13` | `docker-compose.yml`, `deploy/server/docker-compose.yml` (moteur TTS) | GHCR **tiers** — hors de notre contrôle |
| `ghcr.io/<dépôt>/yuki:…` | images publiées par ce dépôt | GHCR (nous) |
| Frontend Dockerfile (`# syntax=…`) | — | **supprimé** : il faisait tirer `docker/dockerfile:1` depuis Docker Hub (donc quota) avant même de lire le Dockerfile, sans repli possible |

> Les images du TTS et de l'application sont tirées **au déploiement**, pas par
> le build : une panne de registre y est visible à `docker compose up`, pas en CI.
> Seule l'image de **base** conditionne la construction.

## Outillage de développement (devDependencies)

| Paquet | Version verrouillée | Rôle |
| --- | --- | --- |
| `typescript` | **5.9.3** | compilation `tsc` (PAS 7.x) |
| `vitest` | **5.0.1** | runner de tests |
| `tsx` | **4.23.13** | exécution TS en dev (dev uniquement) |
| `@types/node` | **24.13.5** | types Node majeure 24.x |
| `@types/ws` | **8.18.1** | types TS du serveur WebSocket (dev uniquement, aligné sur la série `ws` 8.x) |

⚠️ `@types/node@latest` vaut 22.20.3 : ne jamais l'utiliser. La majeure 24.x
est épinglée explicitement.

## Runtime

Le « zéro dépendance runtime » du Lot 0 **tombe au Lot 1** : le noyau texte
embarque le SDK Pi et un serveur WebSocket. Toutes les versions sont **figées
sans caret** (voir ci-dessous).

| Élément | Version | Rôle |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | **`0.85.1` exact** | SDK Pi embarqué (sessions, streaming, événements) |
| `ws` | **8.21.3** | serveur WebSocket (Node fournit un *client* natif mais aucun serveur) |
| `typebox` | **`1.3.7` exact** | schémas JSON des outils custom (`defineTool().parameters`) — **aligné sur le `npm-shrinkwrap.json` du SDK**, ajouté au Lot 2 |
| Node (image) | 24.21.0 | — |
| Gestionnaire de paquets | npm | cohérent avec le SDK Pi |
| HTTP | `node:http` natif | aucune dépendance ajoutée pour le gateway HTTP |

## Hôte de référence

| Élément | Valeur |
| --- | --- |
| CUDA | 13.4 |
| Driver NVIDIA | 615.71.09 |
| Driver minimal accepté | 580 (majeure) |
| Image CUDA | aucune au Lot 0 |

## SDK Pi et transport

| Élément | Valeur |
| --- | --- |
| `@earendil-works/pi-coding-agent` | **`0.85.1` EXACT, sans caret** — installé au **Lot 1**. Le paquet publie un `npm-shrinkwrap.json` : un caret ferait dériver l'arbre. ⚠️ La **0.85.0 était cassée**. Exige `engines >= 22.19.0`. |
| `ws` | **8.21.3** exact, sans caret. Pur JS (pas de compilation native → compatible rootfs `read_only`). |
| `typebox` | **`1.3.7` exact**, sans caret. Ajouté au **Lot 2** en dépendance runtime : `defineTool().parameters` est typé `TSchema` (TypeBox) et le paquet n'était pas installé à la racine. Version **alignée** sur celle du shrinkwrap du SDK. |
| `@types/ws` | **8.18.1** exact (devDependency). |
| Chargement TypeScript du SDK | jiti — **non utilisé** par Yuki (code compilé par `tsc`) |

## Modèles LLM (Lot 2)

Nommage **neutre par rôle** (`llm-light` / `llm-heavy`) : changer de fournisseur
ne touche pas au code (voir [`docs/lot2.md`](lot2.md)).

| Rôle | Provider | Modèle | Thinking | Clé |
| --- | --- | --- | --- | --- |
| Léger | `llm-light` | `gemma4:31b` | désactivé (`reasoning: false`) | `YUKI_LLM_LIGHT_API_KEY` |
| Lourd | `llm-heavy` | `deepseek-v4.1-flash` | `high` (`thinkingLevelMap.off = "none"`) | `YUKI_LLM_HEAVY_API_KEY` |

`baseUrl` par défaut (valeurs actuelles) : `https://ollama.com/v1`
(`api: openai-completions`). Deux providers distincts pour que le léger ne soit
jamais affamé par le lourd.
