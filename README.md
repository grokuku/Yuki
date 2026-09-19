# Yuki

Socle d'infrastructure, **porte de compatibilité GPU**, **noyau texte**,
**multi-LLM** et **paramétrage par l'interface web** — Lots 0-2 & 11.

Yuki détecte le GPU disponible, résout un **profil de compatibilité**, démarre
un gateway HTTP (`node:http`) qui expose l'état de la machine, et ouvre un **tour
de conversation TEXTE** de bout en bout (UI web → gateway → SDK Pi embarqué →
streaming → UI), instrumenté. Au Lot 2, deux LLM distants compatibles OpenAI
(nommage neutre par rôle : `llm-light` / `llm-heavy`) sont branchés : un
**léger** (`gemma4:31b`) qui mène la conversation et un **lourd**
(`deepseek-v4.1-flash`) qui exécute les tâches complexes **en arrière-plan** via
l'outil `delegate`. En mode `strict`, un profil requis et non satisfait fait
**refuser le démarrage** plutôt que d'échouer silencieusement.

Au **Lot 11**, tout le paramétrage (fournisseurs, modèles, **clés LLM**,
délégation, GPU, prompts, transport) se fait depuis la page **`/config`** : le
`.env` est réduit à 5 variables de câblage et `models.json` est **généré** au
démarrage depuis la configuration effective. Plus besoin d'éditer un fichier
dans un volume ni de terminal sur le serveur.

## Démarrage rapide

```bash
cp .env.example .env          # 1. câblage local (5 variables, aucun secret)
docker compose up -d          # 2. tire l'image publiée (ghcr) et démarre
```

**Aucune création de dossier, aucun `chown`, aucun script requis** : la
persistance passe par des **volumes nommés** (`yuki-pi`, `yuki-workspace`,
`yuki-models`, `yuki-state`). *(Avec des **bind mounts**
— `compose.bind.example.yml` — chaque dossier monté en écriture doit en
revanche appartenir à l'uid/gid `1000` du conteneur : `chown -R 1000:1000`.)* Au premier démarrage **sans aucune clé**, le
gateway démarre quand même (`/health/ready` → 503) : ouvrez
`http://127.0.0.1:<port>/config` et saisissez vos deux clés LLM — la bascule se
fait **à chaud**, sans redémarrage. Pour développer :

```bash
npm install                   # dépendances de développement
npm test                      # tests (parsing, profils, porte, health, jobs, délégation)
npm run gpu:report            # rapport GPU sans démarrer le serveur
```

Une fois démarré : `http://127.0.0.1:8083/` (UI de conversation,
**pleine largeur**), `http://127.0.0.1:8083/config` (paramétrage — **clés LLM
incluses**, retour « ← Retour à la discussion », bouton **Redémarrer**),
`/api/config` (API de configuration, `GET`/`PUT` + `POST /api/config/llm/test`),
`/api/admin/restart` (redémarrage protégé, `POST`),
`/health` (état complet, dont `subsystems.llm` et `subsystems.jobs`),
`/health/live` (vivant), `/health/ready` (porte GPU **et** PiHost **et** LLM
léger prêts), `/version`, `/ws` (WebSocket).

Depuis `/config`, le bouton **Redémarrer** demande à Yuki de **relancer son
programme à l'intérieur du conteneur** : un **superviseur interne** à l'image
(`infra/gateway/supervisor.mjs`) relance `dist/index.js` quand il sort avec le
code convenu **75** (`EX_TEMPFAIL`). **Le conteneur reste en place** — aucune
politique de redémarrage Docker n'est requise pour ce bouton, et Yuki n'accède
jamais au socket Docker. Une politique de redémarrage (`restart: unless-stopped`
dans les composes du projet) reste utile pour les **vrais crashs** (superviseur
qui abandonne, sortie du conteneur) — pas pour le bouton.

Prérequis hôte : `./scripts/doctor.sh` vérifie Docker Engine, Compose, le
NVIDIA Container Toolkit, `nvidia-smi` et le driver. `./scripts/up.sh` reste une
commodité (copie `.env` + attente de `/health/live`).

## Documentation

| Document | Contenu |
| --- | --- |
| [`docs/lot0.md`](docs/lot0.md) | Spécification validée du Lot 0 et critères d'acceptation |
| [`docs/lot1.md`](docs/lot1.md) | Spécification validée du Lot 1 (noyau texte) et critères d'acceptation |
| [`docs/lot2.md`](docs/lot2.md) | Spécification validée du Lot 2 (multi-LLM, `delegate`, JobStore) |
| [`docs/lot11.md`](docs/lot11.md) | Spécification validée du Lot 11 (paramétrage web, clés LLM à chaud, `models.json` généré) |
| [`docs/architecture.md`](docs/architecture.md) | Vue d'ensemble et carte des 11 lots (chemin critique) |
| [`docs/versions.md`](docs/versions.md) | Versions verrouillées (audit daté) |
| [`docs/runbook.md`](docs/runbook.md) | Démarrer, observer, changer de GPU, dépanner |

## Structure

```
config/     manifests (profils GPU, capacités) + config Pi (prompts, settings ; models.json = référence par défaut GÉNÉRÉE)
infra/      Dockerfile du gateway
public/ui/  UI de conversation + page /config (vanilla, servie telle quelle, sans build)
scripts/    commodités hôte optionnelles (doctor, up, down, logs, reset, pin-digests)
src/config/ câblage env, store de configuration (page web), runtime de précédence
src/        code TypeScript organisé par domaine (gpu, gateway, pi, llm, jobs, delegation, …)
tests/      tests unitaires (parsing, profils, porte) et d'intégration
docs/       documentation
```

> **Lots 0-2.** Aucune voix, aucun MCP, aucun sidecar d'exécution n'est
> implémenté. Voir `docs/architecture.md` pour la suite.

