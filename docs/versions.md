# Versions verrouillées

Audit daté du **16/09/2026**. Toute mise à jour de ce tableau est un
changement explicite, jamais une dérive de tag.

## Image de base

| Élément | Version | Note |
| --- | --- | --- |
| Image gateway | `node:24.21.0-bookworm-slim` | **épinglée par digest `@sha256:…`** |
| Digest (index multi-arch) | `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553` | résolu le 17/09/2026 via l'API Docker Hub |
| Node runtime | 24.21.0 (LTS) | `node:latest` = Node 26 Current → **interdit** |

> Le digest ci-dessus est l'index multi-arch officiel de
> `library/node:24.21.0-bookworm-slim`. Régénérer avec `scripts/pin-digests.sh`.

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
