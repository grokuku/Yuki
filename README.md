# Yuki

Socle d'infrastructure, **porte de compatibilité GPU**, **noyau texte** et
**multi-LLM** — Lots 0-2.

Yuki détecte le GPU disponible, résout un **profil de compatibilité**, démarre
un gateway HTTP (`node:http`) qui expose l'état de la machine, et ouvre un **tour
de conversation TEXTE** de bout en bout (UI web → gateway → SDK Pi embarqué →
streaming → UI), instrumenté. Au Lot 2, deux LLM distants compatibles OpenAI
(nommage neutre par rôle : `llm-light` / `llm-heavy`) sont branchés : un
**léger** (`gemma4:31b`) qui mène la conversation et un **lourd**
(`deepseek-v4.1-flash`) qui exécute les tâches complexes **en arrière-plan** via
l'outil `delegate`. En mode `strict`, un profil requis et non satisfait fait
**refuser le démarrage** plutôt que d'échouer silencieusement.

## Démarrage rapide

```bash
cp .env.example .env          # 1. config locale (valeurs factices — y coller les clés LLM)
docker compose up -d          # 2. tire l'image publiée (ghcr) et démarre
```

**Aucune création de dossier, aucun `chown`, aucun script requis** : la
persistance passe par des **volumes nommés** (`yuki-pi`, `yuki-workspace`,
`yuki-models`, `yuki-state`). Pour développer :

```bash
npm install                   # dépendances de développement
npm test                      # tests (parsing, profils, porte, health, jobs, délégation)
npm run gpu:report            # rapport GPU sans démarrer le serveur
```

Une fois démarré : `http://127.0.0.1:8080/` (UI de conversation),
`/health` (état complet, dont `subsystems.llm` et `subsystems.jobs`),
`/health/live` (vivant), `/health/ready` (porte GPU **et** PiHost **et** LLM
léger prêts), `/version`, `/ws` (WebSocket).

Prérequis hôte : `./scripts/doctor.sh` vérifie Docker Engine, Compose, le
NVIDIA Container Toolkit, `nvidia-smi` et le driver. `./scripts/up.sh` reste une
commodité (copie `.env` + attente de `/health/live`).

## Documentation

| Document | Contenu |
| --- | --- |
| [`docs/lot0.md`](docs/lot0.md) | Spécification validée du Lot 0 et critères d'acceptation |
| [`docs/lot1.md`](docs/lot1.md) | Spécification validée du Lot 1 (noyau texte) et critères d'acceptation |
| [`docs/lot2.md`](docs/lot2.md) | Spécification validée du Lot 2 (multi-LLM, `delegate`, JobStore) |
| [`docs/architecture.md`](docs/architecture.md) | Vue d'ensemble et carte des 11 lots (chemin critique) |
| [`docs/versions.md`](docs/versions.md) | Versions verrouillées (audit daté) |
| [`docs/runbook.md`](docs/runbook.md) | Démarrer, observer, changer de GPU, dépanner |

## Structure

```
config/     manifests (profils GPU, capacités) + config Pi (prompts, settings, models.json)
infra/      Dockerfile du gateway
public/ui/  UI de conversation (vanilla, servie telle quelle, sans build)
scripts/    commodités hôte optionnelles (doctor, up, down, logs, reset, pin-digests)
src/        code TypeScript organisé par domaine (gpu, gateway, pi, llm, jobs, delegation, …)
tests/      tests unitaires (parsing, profils, porte) et d'intégration
docs/       documentation
```

> **Lots 0-2.** Aucune voix, aucun MCP, aucun sidecar d'exécution n'est
> implémenté. Voir `docs/architecture.md` pour la suite.

