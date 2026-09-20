# Architecture

## Vue d'ensemble (Lot 0)

```
                 ┌──────────────────────────────────────────────┐
   .env ───────► │ src/config/env.ts   (validation stricte)      │
                 │ src/config/paths.ts (4 volumes nommés)        │
                 └───────────────┬──────────────────────────────┘
                                 │
   nvidia-smi ──► src/gpu/detect.ts ──► DetectionResult
   ou fixture          │ (query → -q → table nom→CC)
                                 │
   config/gpu-profiles.json ─────┤
   config/compat-manifest.json ──┤
                                 ▼
                        src/gpu/gate.ts  ──► GateResult { passed, report }
                                 │
             passé ──────────────┴────────────── refus (strict)
             │                                         │
             ▼                                         ▼
   src/gateway/server.ts                    rapport console + code ≠ 0
   (node:http)                              (aucun port ouvert)
   /health /health/live /health/ready /version
```

Le rapport `GpuReport` est la **structure unique** partagée par la console, la
CLI `gpu:report` et `/health`.

## Vue d'ensemble (Lot 1 — noyau texte)

Un tour de conversation **TEXTE** de bout en bout, instrumenté, sans voix ni
multi-LLM :

```
 navigateur                 gateway (node:http)                       SDK Pi embarqué
 ┌─────────┐   WS /ws    ┌───────────────────────────┐            ┌──────────────────┐
 │ public/ │◄───────────►│ ws/protocol  (contrat)    │            │ src/pi/sdk-host  │
 │ ui/     │  seq/ts/sid │ ws/server    (upgrade, vie)│  events    │ SessionManager   │
 │ app.js  │             │ ws/session-stream (buffer)│◄───────────│ AgentSession     │
 └─────────┘             │        │                  │            └──────────────────┘
                         │        └─► PiHost (facade)│  aucun type du SDK ne fuit
                         │ routes/static (UI)        │
                         │ routes/health (subsystems)│
                         └───────────────────────────┘
```

- **`src/pi/`** est la **façade** : types publics JSON (`types.ts`), contrat
  (`host.ts`), implémentation confinée (`sdk-host.ts`), normalisation des
  événements (`events.ts`) et des erreurs (`errors.ts`), configuration des
  chemins et garde-fous rootfs (`config.ts`), instrumentation par étage
  (`instrumentation.ts`).
- **`src/gateway/ws/`** porte le **transport temps réel** : contrat
  (`protocol.ts`), serveur WS + hook `upgrade` (`server.ts`), flux par session
  à buffer annulaire borné / `seq` monotone / rejeu / `snapshot`
  (`session-stream.ts`), abstraction `Transport` (`transport.ts`).
- **`public/ui/`** est une UI vanilla (aucune chaîne de build front).

## Vue d'ensemble (Lot 2 — multi-LLM)

```
                       ┌────────────────────────────────────────────┐
  UI ──WS──► gateway   │  PiHost (léger : gemma4:31b, thinking off)  │
                       │   outils: read/ls/grep/find                │
                       │           + delegate/job_status/cancel_job │
                       └───────┬───────────────────────▲────────────┘
                               │ delegate (inline ≤1500 ms)│ report
                               ▼                           │
                  ┌────────────────────────┐   ┌───────────┴──────────┐
                  │  DelegationService      │   │  job_report → léger  │
                  │  JobQueue (3+10)        │──►│  (résumé 1–3 phrases)│
                  │  JobStore (jobs.jsonl)  │   └──────────────────────┘
                  └───────────┬────────────┘
                              │ run (session éphémère)
                              ▼
                  ┌────────────────────────┐
                  │ Worker lourd (SDK)     │  deepseek-v4.1-flash, thinking high
                  │ read/ls/grep/find seul │  1 tâche = 1 session = 0 fuite
                  └────────────────────────┘
```

Deux providers DISTINCTS, nommés **par rôle** (`llm-light` / `llm-heavy`), avec
deux clés : le léger ne fait jamais la queue derrière le lourd. Le nommage est
neutre (changer de fournisseur ne touche pas au code).

### Domaines de `src/`

| Domaine | Rôle |
| --- | --- |
| `config/` | câblage env, chemins/montages, **store de configuration** (page web), runtime de précédence (défauts < store < env) |
| `gpu/` | détection, profils, porte, rapport, CLI |
| `gateway/` | app HTTP, serveur, routes (dont `/health` enrichi et l'UI statique) |
| `gateway/ws/` | transport temps réel : protocole, serveur WS, flux par session, abstraction `Transport` |
| `pi/` | façade `PiHost` : types publics, host, `sdk-host` (seul import du SDK en racine), événements, erreurs, config, instrumentation |
| `pi/sdk/` | **seul** sous-domaine autorisé à importer le SDK et `typebox` : runtime de modèles, fabrique de sessions, worker lourd, outils `delegate` |
| `llm/` | providers, modèles, politique d'outils, disponibilité, prompts (données pures) |
| `jobs/` | `JobStore` append-only JSONL, file bornée, types |
| `delegation/` | ports (`HeavyWorker`, `ModelAvailability`, `JobReporter`), service de délégation, report |
| `observability/` | logger JSON-lines + redaction |
| `types/` | types partagés GPU / profils |

## Carte des 11 lots

| Lot | Sujet | État |
| --- | --- | --- |
| **0** | **Infra + porte GPU** | **implémenté** |
| **1** | **Noyau texte : façade `PiHost`, WS + rejeu `seq`, UI, instrumentation** | **implémenté** |
| 2 | Multi-LLM : 2 clés, providers neutres `llm-light`/`llm-heavy`, allowlist par modèle, `delegate` à deadline, JobStore | **implémenté** |
| 3 | Sessions | à venir |
| 4 | Sidecar d'exécution | à venir |
| 5 | Pont MCP + skills | à venir |
| 6 | ASR / PTT | à venir |
| 7 | TTS / barge-in (spec : [`docs/lot7.md`](lot7.md)) | à venir |
| 8 | Retour proactif | à venir |
| 9 | Durcissement | à venir |
| 10 | Documentation n8n | à venir |
| **11** | **Paramétrage par l'interface web (clés LLM à chaud, `models.json` généré)** | **implémenté** |

**Chemin critique : 0 → 1 → 2 → 6 → 7.**

## Vue d'ensemble (Lot 11 — paramétrage par l'interface web)

Le paramétrage est **découplé** du fonctionnement applicatif : la page `/config`
et l'API de configuration sont servies par `node:http` **indépendamment** de la
porte GPU, du `PiHost` et des clés LLM.

```
 navigateur                 gateway (node:http)                     domaine src/config
 ┌────────────┐  GET/PUT   ┌────────────────────────┐            ┌──────────────────┐
 │ /config    │◄──────────►│ routes/config (API)    │──get/update│ ConfigRuntime    │
 │ config.js  │ POST test  │ (en-tête X-Yuki-Config)│            │  store + env     │
 └────────────┘            └───────────┬────────────┘            │  + défauts       │
                                       │ clés → process.env      └────────┬─────────┘
                                       ▼                                  │
                          ┌────────────────────────┐   généré au démarrage │
                          │ src/index (composition) │◄─────────────────────┘
                          │  buildModelsConfigFrom  │
                          └───────────┬────────────┘
                                      ▼ écrit atomiquement
                          /data/pi/agent/models.json  ──► SDK Pi (ModelRuntime)
```

- **Précédence** : `défauts (code) < store (page web) < environnement`. L'env ne
  participe que s'il est défini ET non vide ; sinon il **verrouille** le champ
  (`origin: "env"`), visible dans la page et refusé au `PUT` (`locked_by_env`).
- **`models.json` est GÉNÉRÉ** (`buildModelsConfigFrom`) : plus de seed
  copie-si-absent. Aucune clé en clair — uniquement `$YUKI_LLM_*_API_KEY`.
- **À chaud** : les clés LLM (pont vers `process.env`, `/health/ready` bascule
  immédiatement). **Redémarrage** : fournisseur/modèle/thinking, prompts,
  timeouts, GPU, transport.
- **Store** : `/data/state/config.json`, sparse, `0600`, écriture atomique,
  repli sans écrasement (le démarrage n'échoue jamais à cause du store).

Détails complets : [`docs/lot11.md`](lot11.md).

### Références établies pour la suite (contexte)

- **TTS** : Breeze TTS 2 via audio.cpp v0.8.0
  (`ghcr.io/0xshug0/audio.cpp:full-cuda13`) ; code « occupé » = **503
  server_busy** (et non 409).
- **ASR** : whisper.cpp v1.9.4 (pas de cuDNN, pas de Python).
- **Cibles GPU** : RTX 4070 12 Go (Ada, CC 8.9), RTX 3060 12 Go (Ampere,
  CC 8.6), **Quadro RTX 4000 8 Go Turing CC 7.5 = le plancher, sans BF16**.
- **LLM** : distants, compatibles OpenAI (fournisseur actuel : ollamacloud ;
  providers neutres `llm-light`/`llm-heavy`).
- Hôte : CUDA 13.4, driver 615.71.09. Aucune image CUDA au Lot 0.

## Sécurité (Lots 0-1)
- Conteneur **non-root** (uid/gid `YUKI_UID`/`YUKI_GID`, défaut 1000).
- Rootfs **read-only**, seul `/tmp` en `tmpfs`. L'état du SDK Pi (`settings.json`,
  `auth.json`, `models.json`, `sessions/`) et `HOME` sont **redirigés** vers le
  volume `yuki-pi` (`/data/pi`) ; le `cwd` reste fixe (`/workspace`).
- `/models` monté **en lecture seule** ; `/data/pi`, `/workspace`,
  `/data/state` en lecture-écriture.
- Logs JSON-lines avec **redaction** des clés/valeurs sensibles.
- **Aucun type du SDK Pi ne franchit `src/pi/sdk-host.ts`** (test de frontière
  automatisé sur `src/**`). Lot 2 : le confinement s'étend à `src/pi/sdk/**`, avec
  3 invariants (allowlist d'imports SDK ; aucun import SDK/`typebox` dans
  `llm/jobs/delegation` ; rien hors `src/pi/**` n'importe depuis `src/pi/sdk/**`).
- Dépendances runtime **figées exactement** (`@earendil-works/pi-coding-agent@0.85.1`,
  `ws@8.21.3`, `typebox@1.3.7`), sans caret.
- **Aucune clé LLM en clair** : `models.json` **généré** ne contient que des
  références `$YUKI_LLM_*_API_KEY` ; les clés vivent dans le **store**
  `/data/state/config.json` (`0600`, volume `state`) et/ou l'environnement ;
  redaction des logs ; l'API ne renvoie jamais la valeur (masque seul).
- **Aucun import SDK/`typebox` dans `src/config/**`** (Lot 11) : le domaine de
  configuration reste testable sans SDK (invariant ajouté au test de frontière).
- **Précautions de l'API de configuration** (Lot 11) : en-tête personnalisé
  `X-Yuki-Config` + contrôle `Origin`/`Host` sur les écritures, journal d'audit
  `config.changed` sans valeur de secret. Le durcissement complet
  (authentification, chiffrement au repos, TLS) est prévu au **Lot 9** — voir
  `docs/lot11.md` (« Sécurisation — préparée, PAS implémentée »).
- **Aucune authentification** au Lot 1 (réseau de confiance) : champ `auth`
  réservé ; durcissement prévu au Lot 9.
