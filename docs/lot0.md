# Lot 0 — Socle & porte de compatibilité

## Objectif

Poser l'infrastructure minimale et **une porte de compatibilité** : détecter le
GPU, résoudre un profil, refuser explicitement (ou dégrader) au démarrage, et
exposer l'état via un gateway HTTP sans dépendance runtime.

## Décisions validées

1. **Suppression de `test.txt`** (dépôt repart de zéro).
2. Service compose unique `gateway`, conteneur `yuki-gateway` (plus tard
   `asr`, `tts`, `exec`).
3. `src/` organisé **par domaine** ; **package unique** (pas de monorepo).
4. **Bind mounts** pilotés par `.env` (pas de volumes nommés).
5. Mode de compatibilité par défaut = **`strict`** (refus explicite et bruyant).
6. **Aucun ASR/TTS** déclaré dans le compose (digests non résolus, aucun
   modèle monté).
7. **npm** (cohérent avec le `npm-shrinkwrap.json` du SDK Pi).
8. **`read_only: true`** + `tmpfs: /tmp`, conteneur **non-root**.
9. Seuils : `confort` ≥ 12 000 MiB + BF16 ; `compact` ≥ 8 000 MiB sans BF16 ;
   `repli` ≥ 6 000 MiB ; `texte-seul` sans GPU. Entrées `to-confirm` quand
   elles dépendent d'un lot futur.
10. **`node:http` natif**, zéro dépendance runtime.
11. **Critères de résolution de profil = compute capability + VRAM TOTALE + BF16**,
    rien d'autre. La **VRAM libre** est une mesure instantanée : elle produit un
    **avertissement** (note dans `GpuReport` + WARN) mais n'entre jamais dans le
    classement des profils (sinon une carte 12 Go serait rétrogradée à tort si
    un autre processus occupait la mémoire au démarrage).
12. Le **plancher de driver** (≥ 580, CUDA 13.x) n'est plus un critère de profil :
    c'est une **exigence de service** (`asr`/`tts`, `status: "to-confirm"`) du
    manifeste. Au Lot 0 aucun conteneur n'utilise CUDA, donc il ne bloque rien ;
    `gateway` n'exige ni GPU ni driver.

## Portée

**Dans le Lot 0**

- Détection GPU (`nvidia-smi` → `-q` → table nom→CC), BF16 (CC ≥ 8.0), version
  CUDA best effort.
- Rapport `GpuReport` unique (console / `/health` / CLI).
- Profils `confort`, `compact`, `repli`, `texte-seul` + manifeste de capacités.
- Porte `strict` / `auto-degrade` avec override `YUKI_PROFILE`.
- Gateway `node:http` : `/health/live`, `/health/ready`, `/health`, `/version`,
  arrêt gracieux SIGTERM.
- Logger JSON-lines avec redaction des secrets.
- Dockerfile multi-étage épinglé par digest, conteneur non-root et read-only.
- Scripts hôte, fixtures et tests.

**Hors Lot 0 (ne rien implémenter)**

LLM, WebSocket, sessions, sidecar d'exécution, MCP/skills, ASR, TTS, retour
proactif, durcissement complet, n8n. Voir `architecture.md`.

## Modèle de la porte

| Situation | `strict` | `auto-degrade` |
| --- | --- | --- |
| Pas d'override, GPU suffisant | plus haut profil compatible, `ok` | idem, downgrade WARN si < plus haut |
| Pas d'override, sans GPU | `texte-seul`, `degraded` | idem |
| Override `YUKI_PROFILE` satisfait | `override-accepted` | `override-accepted` |
| Override non satisfait | **refus** : `override-refused`, sortie ≠ 0, serveur non démarré | `downgraded` vers le plus haut compatible, `degraded` |
| Profil inconnu | refus | refus |

`texte-seul` est **toujours** accepté.

## Critères d'acceptation

| # | Critère | Vérifié par |
| --- | --- | --- |
| 1 | `npm run typecheck` + `npm test` verts | CI locale / `docs/runbook.md` |
| 2 | `npm run build` produit `dist/` | idem |
| 3 | `npm run gpu:report` fonctionne sans GPU (pas de crash) | CLI |
| 4 | 4070→`confort`, 3060→`confort`, Quadro 8 Go→`compact`, sans GPU→`texte-seul` | `tests/gpu/profiles.test.ts` |
| 5 | Override `confort` refusé en `strict` sur Quadro (liste `gpu.bf16` + VRAM) | `tests/gpu/gate.test.ts` |
| 6 | Même cas en `auto-degrade` → `degraded` + `compact` + `downgraded` | `tests/gpu/gate.test.ts` |
| 7 | `/health/live` / `/health/ready` = 200, `/health` complet, `/version` | `tests/integration/health.test.ts` |
| 8 | Aucun `latest`, image Node épinglée par digest | `docker-compose.yml`, `infra/gateway/Dockerfile` |
| 9 | Aucun chemin absolu dans compose/`infra`/`src` | revue + `grep` |
| 10 | Non-root, rootfs read-only, `/models` en `ro`, 4 points de montage | `docker-compose.yml` |

## Endpoints

| Route | Statut | Contenu |
| --- | --- | --- |
| `GET /health/live` | 200 tant que le process vit | `{ status: "ok" }` |
| `GET /health/ready` | 200 si la porte est passée, sinon 503 | `{ status, profile, missingCapabilities? }` |
| `GET /health` | 200 | `{ status, version, uptime, gpu, profile, volumes }` |
| `GET /version` | 200 | `{ name, version, node, locked }` |

## Variables d'environnement

Catalogue complet et valeurs factices : `.env.example`. Les variables sont
validées strictement au chargement (`src/config/env.ts`).
