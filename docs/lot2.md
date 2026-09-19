# Lot 2 — Multi-LLM

> Implémentation du **Lot 2 : multi-LLM**. Ce document résume les décisions
> valides, l'architecture et les contrats. Il complète
> [`docs/architecture.md`](architecture.md) et [`docs/runbook.md`](runbook.md).

## Décisions

- **Deux LLM via un fournisseur compatible OpenAI** (valeurs actuelles :
  ollamacloud, `https://ollama.com/v1`).
  - **Léger = `gemma4:31b`** : mène la conversation, **seul à parler**, thinking
    **désactivé** (`reasoning: false`, aucun paramètre de raisonnement envoyé).
  - **Lourd = `deepseek-v4.1-flash`** : exécute les tâches complexes en
    **arrière-plan**, thinking **activé** (`high` par défaut). Sur l'endpoint
    OpenAI, `think:false` est ignoré : c'est `reasoning_effort: "none"` qui coupe
    le thinking → `thinkingLevelMap` du lourd
    `{ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }`.
    Le léger **n'a pas** de `thinkingLevelMap`.
- **Nommage NEUTRE, par RÔLE** : les providers s'appellent **`llm-light`** et
  **`llm-heavy`** (jamais un nom de fournisseur). On peut **changer de
  fournisseur sans toucher au code**.
- **Deux providers distincts avec deux clés** : `llm-light` (clé
  `YUKI_LLM_LIGHT_API_KEY`, 1 flux concurrent) et `llm-heavy` (clé
  `YUKI_LLM_HEAVY_API_KEY`, 3 requêtes concurrentes). Objectif : **le léger ne
  fait jamais la queue derrière le lourd**. Aucun secret en clair : `models.json`
  référence les clés par `$YUKI_LLM_LIGHT_API_KEY` / `$YUKI_LLM_HEAVY_API_KEY`.
- **Deadline par défaut de `delegate` = 1500 ms** (bornes 200–60 000, clamp).
- **3 jobs lourds simultanés** + file de **10**.
- Prompt du lourd : `config/pi/system-prompt-heavy.md` (fichier séparé).
- Politique **`degrade`** par défaut en cas de clé manquante.
- Un **Stop** du léger pendant un inline **ne tue pas** le job.

## Changer de fournisseur (nommage neutre)

> **⚠️ Mis à jour au Lot 11.** Le changement de fournisseur ne passe **plus** par
> l'édition d'un fichier dans un volume : `models.json` est désormais **GÉNÉRÉ**
> au démarrage depuis la configuration effective, et `baseUrl`/`api`/modèle/
> thinking se règlent dans la page **`/config`** (effet au **redémarrage**).
> Voir [`docs/lot11.md`](lot11.md). Ce qui suit décrit le nommage neutre et la
> limite SDK d'interpolation, qui restent valides.

Variables neutres, un bloc **par rôle** (deux `BASE_URL` **distinctes** : le
léger et le lourd peuvent être chez deux fournisseurs différents). Depuis le
Lot 11, elles sont **surtout** des surcharges d'environnement qui **verrouillent**
le champ ; en déploiement normal, préférez `/config` :

```
YUKI_LLM_LIGHT_API=openai-completions
YUKI_LLM_LIGHT_BASE_URL=https://ollama.com/v1
YUKI_LLM_LIGHT_API_KEY=
YUKI_LLM_LIGHT_MODEL=gemma4:31b
YUKI_LLM_LIGHT_THINKING=off

YUKI_LLM_HEAVY_API=openai-completions
YUKI_LLM_HEAVY_BASE_URL=https://ollama.com/v1
YUKI_LLM_HEAVY_API_KEY=
YUKI_LLM_HEAVY_MODEL=deepseek-v4.1-flash
YUKI_LLM_HEAVY_THINKING=high
```

> **Limite SDK (vérifiée dans `docs/models.md` du paquet
> `@earendil-works/pi-coding-agent` et dans son `dist/core/resolve-config-value.*`) :
> seuls `apiKey` et `headers` acceptent l'interpolation `$VAR` / `${VAR}` /
> `!command`. `baseUrl`, `api` et l'identifiant de modèle N'ACCEPTENT PAS
> l'interpolation dans `models.json`.** Ces champs sont écrits **littéralement**
> par le générateur (`buildModelsConfigFrom`) dans `models.json` :
>
> - **`/config` est LE moyen de changer de fournisseur** (groupe « LLM léger » /
>   « LLM lourd »). Le fichier `models.json` est **GÉNÉRÉ** à chaque démarrage
>   (écriture atomique) : l'éditer à la main est inutile.
> - La **clé** reste **hors du volume** : store `0600` (`/data/state/config.json`)
>   et/ou variable d'environnement, référencée par `models.json` via
>   `$YUKI_LLM_<ROLE>_API_KEY` (pont `process.env`, appliqué **à chaud**).
> - `YUKI_LLM_<ROLE>_{API,BASE_URL,MODEL,THINKING}` restent lues comme **surcharges
>   d'environnement** (elles verrouillent le champ correspondant).
> - L'**import unique** au premier démarrage récupère `baseUrl`/`api`/modèle d'un
>   `models.json` existant si le store est vide (voir `docs/lot11.md`).

## Domaines (`src/`)

| Domaine | Rôle | Dépendances interdites |
| --- | --- | --- |
| `llm/` | providers, modèles, politique d'outils, disponibilité, prompts | ni SDK Pi, ni `typebox` |
| `jobs/` | types, `JobStore` (journal JSONL), file bornée | ni SDK Pi, ni `typebox` |
| `delegation/` | ports (`HeavyWorker`, `ModelAvailability`, `JobReporter`), service, report | ni SDK Pi, ni `typebox` |
| `pi/sdk/` | **seul** endroit (avec `sdk-host.ts`) autorisé à importer le SDK et `typebox` | — |

**Inversion de dépendance** : `delegation/ports.ts` déclare les interfaces ;
`pi/sdk/*` les implémente ; la racine `src/index.ts` câble le tout.

## Politique d'outils (garantie structurelle)

| Rôle | Outils exposés |
| --- | --- |
| **Léger** | builtins `read`, `ls`, `grep`, `find` + custom `delegate`, `job_status`, `cancel_job` |
| **Lourd** | builtins `read`, `ls`, `grep`, `find` uniquement |

**Aucun** `bash`/`powershell`/`edit`/`write` (le sidecar isolé n'existe qu'au
Lot 4) et **pas de `delegate` pour le lourd** (pas de redélégation). La table vit
dans `src/llm/tool-policy.ts` (données pures, extensible par ajout d'entrées).

## Contrat de l'outil `delegate`

`delegate(task: string (1–4000), context?: string (≤8000), deadline_ms?: integer)`
— `deadline_ms` est la **durée max d'attente inline** (pas un timeout de job),
défaut **1500**, bornée **200–60 000** avec **clamp** (valeur non numérique →
défaut). Le job est créé et démarré **immédiatement** en arrière-plan ; l'outil
attend borné par la deadline ; fini avant → **INLINE**, sinon →
`{ status:"pending", job_id }` immédiat. Le job **n'est jamais annulé** du fait
de la deadline.

Schémas de retour : `completed` (`result`, `duration_ms`, `usage_input`,
`usage_output`, `truncated`) · `pending` (`job_id`, `deadline_ms`, `note`) ·
`failed` (`error`, `partial`) · timeout (`error:"timeout"`, `partial`) ·
`cancelled` · `rejected` (`reason:"queue_full"`) · `unavailable`
(`reason:"heavy_unavailable"`). Le texte inline peut être tronqué
(`truncated:true`, ex. 32 ko) ; le complet reste dans le `JobStore`.

## Worker lourd

Session **éphémère en mémoire** par job (`SessionManager.inMemory()`) : une tâche
= une session = un prompt = une réponse finale, donc **aucune fuite de contexte**
entre jobs. `ModelRuntime` **partagé** (même `models.json`). Prompt système dédié
via `systemPromptOverride` + `agentsFilesOverride` vidé, `cwd=/workspace`,
`agentDir=/data/pi/agent`. Thinking `high`. Capture du **texte final** (deltas
`content` uniquement, `thinking` **ignoré**) et de l'`usage`. **Timeouts** :
inactivité `YUKI_HEAVY_IDLE_TIMEOUT_MS` (120 s) et global
`YUKI_HEAVY_TOTAL_TIMEOUT_MS` (20 min) → `abort()` + job `failed` avec
`partial`. Travail partiel persisté à chaque `turn_end`. `cancel_job` →
`abort()` + `dispose()`.

## `JobStore`

Journal **append-only JSONL** (`JobEvent { seq, ts, eventId, jobId, kind, patch }`,
`kind ∈ {created, queued, started, progress, completed, failed, cancelled, interrupted, notified}`)
+ **projection en mémoire** reconstruite en rejouant le journal. `JobRecord`
versionné (`schemaVersion: 1`). Transitions : `queued→running→completed|failed|cancelled|interrupted`,
`completed|failed→notified`. Rejeu **idempotent** (ignore un `eventId` déjà
appliqué, « dernier `seq` gagnant », `notified` monotone). Toute transition
illégale est rejetée. Le schéma accueillera le Lot 8 **sans refonte** (les
mécanismes de réconciliation/garde-fou/file de reports **ne sont pas implémentés**
au Lot 2).

## Report (périmètre Lot 2)

À la fin réelle d'un job (`completed`/`failed`), on construit un prompt de report
borné (en-tête `[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]`, `job_id`, statut, tâche,
résultat brut ou `partial`) avec la consigne au léger de **résumer en 1–3
phrases**, puis on **réveille le léger** via
`host.send(lightSessionId, reportPrompt, { origin: "job_report", jobId })`. Le
léger **parle** (deltas `content` normaux). L'UI **n'affiche pas** de bulle
utilisateur synthétique (le transcript du prompt de report est exclu, et
`origin` le signale). Si le léger streamait déjà, le report passe par la file
FIFO existante. **Voix, garde-fou de silence et priorisation = Lot 8.**

## Instrumentation & santé

Nouveaux étages (`phase`, chaîne ouverte) : `delegate_received`,
`delegate_inline_wait`, `delegate_returned_inline`, `delegate_returned_pending`,
`job_enqueued`, `job_started`, `job_first_token`, `job_finished`,
`report_requested`, `report_emitted` (+ `job_interrupted` réservé). Le champ
`PhaseEvent.jobId` corrèle les étages au job.

`/health` expose `subsystems.llm = { light, heavy }` (`provider`, `model`,
`status`, `keyPresent`) et `subsystems.jobs = { running, queued, completed,
failed, interrupted, maxConcurrent }`. `/health/ready` renvoie **503 si
`llm.light.status === "unavailable"`**. Aucune clé dans les logs.

## Politique « clé manquante » (`YUKI_LLM_MISSING_KEY_MODE`, défaut `degrade`)

- **Clé lourde absente** → démarrage normal, **délégation désactivée
  structurellement** (outils `delegate`/`job_status`/`cancel_job` non exposés),
  `heavy.status="unavailable"`, conversation 100 % fonctionnelle.
- **Clé légère absente** → démarrage pour diagnostic, `light.status="unavailable"`,
  `/health/ready` → **503**, `send` renvoie `LLM_UNAVAILABLE`.
- Mode `refuse` → sortie non-zéro **avant** d'ouvrir le port.

La vérification de disponibilité ne fait **aucun appel réseau** (basée sur la
présence de la clé d'authentification configurée) — compatible `PI_OFFLINE=1`.

## Dépendance ajoutée

`typebox` **1.3.7** exact (aligné sur le `npm-shrinkwrap.json` du SDK), en
dépendance runtime. Aucune autre dépendance : tout passe par le SDK.
