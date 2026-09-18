# Runbook

## 1. Démarrer

```bash
cp .env.example .env      # 1re fois
./scripts/doctor.sh       # prérequis hôte
./scripts/up.sh           # build + up + attente de /health/live
curl -s http://127.0.0.1:8080/health | head
```

`up.sh` crée les dossiers hôtes (`.local/…` par défaut), tente un `chown`
vers `YUKI_UID:YUKI_GID`, lance `docker compose up -d --build`, puis attend
`/health/live` (timeout 90 s).

> ⚠️ **Ne lancez pas `docker compose up` seul sur une machine vierge.** Sans
> préparation préalable, Docker crée les racines de bind mount (`.local/…`) en
> `root:root` ; le conteneur non-root (uid `YUKI_UID`) ne peut alors pas créer
> `/data/pi/agent`, et `/health/ready` répond **503**. Passez par
> `./scripts/up.sh` (ou créez les dossiers et donnez-leur le propriétaire
> `YUKI_UID:YUKI_GID`). Le gateway journalise alors `pi.start.failed` —
> « le volume est-il monté inscriptible ? » — message volontairement explicite.

## 2. Observer

```bash
./scripts/logs.sh          # suivi des logs (100 dernières lignes)
./scripts/logs.sh 500      # 500 dernières lignes
curl -s http://127.0.0.1:8080/health/ready
curl -s http://127.0.0.1:8080/version
```

Les logs sont du **JSON-lines** sur stdout : une ligne = un objet
`{ ts, level, msg, … }`. Les secrets sont masqués (`[REDACTED]`).

## 3. Rapport GPU sans serveur

```bash
npm run gpu:report            # rendu console
npm run gpu:report -- --json  # rapport brut
```

Utiliser une fixture (dev/tests) :

```bash
YUKI_GPU_FIXTURE=tests/fixtures/gpu/quadro-rtx4000-8g.txt npm run gpu:report
```

## 4. Changer de profil / de GPU

- **Forcer un profil** : `YUKI_PROFILE=compact` dans `.env` (ou
  `confort` / `repli` / `texte-seul`). En `strict`, un profil non satisfait
  fait **échouer** le démarrage.
- **Dégrader au lieu de refuser** : `YUKI_COMPAT_MODE=auto-degrade`.
- **Épingler une carte** : dans `compose.override.yml` (copie de
  `compose.override.example.yml`), remplacer `count: all` par
  `device_ids: ["0"]`.
- **Simuler un GPU** : `YUKI_GPU_FIXTURE=tests/fixtures/gpu/<fixture>.txt`.
- **Changer la commande** : `YUKI_GPU_CMD=/chemin/vers/nvidia-smi`.

Après modification : `./scripts/up.sh`.

## 5. Réinitialiser l'état

```bash
./scripts/reset-state.sh          # demande confirmation
./scripts/reset-state.sh --yes    # sans prompt
```

Efface `/data/state` et `/workspace` (hôtes). **Ne touche pas** aux modèles ni
à l'agent Pi.

## 6. Dépannage

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `gateway.startup refused` | profil requis non satisfait en `strict` | lire les `CAPACITÉS MANQUANTES`, ajuster `YUKI_PROFILE` ou passer en `auto-degrade` |
| `nvidia-smi indisponible` dans le rapport | pas de GPU / driver / toolkit | `./scripts/doctor.sh`, vérifier `NVIDIA_VISIBLE_DEVICES` |
| `driver.floor` faux (service) | driver < 580 | **n'affecte pas le profil** ; exigence `asr`/`tts` (lots 6/7) — mettre à jour le driver hôte avant ces lots |
| `BF16 : non` | CC < 8.0 (ex. Quadro RTX 4000) | forcer `compact` (ou `repli`) |
| `/health/ready` = 503 | porte non passée | le serveur ne devrait pas être démarré ; vérifier les logs |
| Conteneur `Exit 1` immédiat | refus strict | `./scripts/logs.sh` puis corriger le profil |
| `permission denied` sur un montage | uid/gid du conteneur ≠ propriétaire hôte | `YUKI_UID`/`YUKI_GID` dans `.env`, relancer `up.sh` |
| Port déjà utilisé | autre service sur 8080 | `YUKI_GATEWAY_PORT=9090` dans `.env` |
| `LLM_UNAVAILABLE` dans l'UI | clé légère absente | renseigner `YUKI_LLM_LIGHT_API_KEY` puis redémarrer |
| `delegate` → `heavy_unavailable` | clé lourde absente | outil normalement absent ; renseigner `YUKI_LLM_HEAVY_API_KEY` |
| `delegate` → `queue_full` | file lourde pleine (10) | attendre la fin des jobs ou ajuster `YUKI_HEAVY_MAX_QUEUE` |

## 7. Développement

```bash
npm run typecheck
npm test
npm run build
npm run dev        # tsx watch src/index.ts
```

## 8. Mise à jour du digest de l'image

```bash
./scripts/pin-digests.sh                       # node 24.21.0-bookworm-slim
./scripts/pin-digests.sh node 24.21.0-bookworm-slim
```

Le script **propose** la ligne `FROM …@sha256:…` ; il n'écrit rien.

## 9. Noyau texte (Lot 1)

Un tour de conversation TEXTE va de l'UI web au SDK Pi embarqué et revient en
streaming. Pas de voix, pas de multi-LLM.

```bash
# UI minimale (vanilla, servie par le gateway)
xdg-open http://127.0.0.1:8080/           # ou ouvrir l'URL dans un navigateur

# Endpoints
curl -s http://127.0.0.1:8080/health | jq .subsystems
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health/ready
```

- **`/health`** expose un bloc `subsystems` : `pi` (`status`, `cwd`, `agentDir`,
  `sessionsDir`, `model?`, `sessionsCount`, `activeRuns`) et `transport`
  (`ws.clients`, `ws.replayBufferSize`, `sse: false`).
- **`/health/ready`** renvoie **200** seulement si la porte GPU **ET** le
  `PiHost` sont prêts ; sinon **503** (avec `pi.status` pour le diagnostic).

### UI

- Entrée = envoyer, **Maj+Entrée** = retour à la ligne.
- **Stop** interrompt le run en vol (trame `abort`) et **vide la file**.
- La réponse est **streamée token par token** (`delta channel:"content"`).
- Les deltas `thinking` **transitent** mais ne sont **jamais** affichés comme
  réponse ni écrits dans le transcript (au plus un indicateur « réflexion… »).
- La **reconnexion** est automatique (backoff borné) et renvoie le dernier `seq`
  appliqué : le serveur rejoue `seq > fromSeq`, ou renvoie un `snapshot` si la
  fenêtre est dépassée.

### Transport WebSocket

- Un seul point d'entrée : `GET /ws` (hook `upgrade`). **Aucune authentification**
  au Lot 1 ; champ `auth` réservé (durcissement au Lot 9).
- Chaque trame serveur → client porte `{ seq, ts, sessionId }`. `seq` est
  **monotone par session**, à partir de 1.
- Buffer de rejeu **par session** : `YUKI_WS_REPLAY_BUFFER` (trames, défaut
  `1000`) et `YUKI_WS_REPLAY_BYTES` (octets, défaut `5 000 000`).
- Les trames **binaires** sont réservées à l'audio (lots 6/7) : elles sont
  **ignorées proprement** (log `ws.binary.ignored`, pas de crash).

### Instrumentation

Chaque tour journalise des lignes JSON-lines corrélées par `session_id`/`run_id` :

```bash
./scripts/logs.sh | grep -E 'pi\.phase|pi\.run_summary'
# pi.phase      : send_received (t0), prompt_accepted, run_started,
#                 first_token (= TTFT), turn_end, run_finished, abort, error
# pi.run_summary: ttft_ms, total_ms, usage_in, usage_out
```

### Test d'intégration SDK réel (opt-in)

Par défaut, `tests/integration/real-sdk.test.ts` est **ignoré** (aucun SDK, aucun
réseau, aucun coût). Pour l'exécuter :

```bash
npm run test:real          # YUKI_TEST_REAL_PI=1 vitest run tests/integration/real-sdk.test.ts
```

### Erreurs

Toute exception du SDK est traduite en `PiHostError { code }`
(`PI_NOT_READY`, `PI_PROMPT_REJECTED`, `PI_ABORTED`, `PI_TIMEOUT`,
`PI_SESSION_ERROR`, `PI_RESOURCE_ERROR`, `PI_UNKNOWN`). **Aucun message brut du
SDK ne franchit la façade.** Un abort qui rejette devient
`run_finished(reason:"abort")`.

## 10. Multi-LLM (Lot 2)

Deux LLM distants via un fournisseur compatible OpenAI (valeurs actuelles :
ollamacloud) : un **léger** (`gemma4:31b`) qui mène la conversation et un
**lourd** (`deepseek-v4.1-flash`) qui exécute les tâches complexes en
arrière-plan. Le léger peut déléguer via l'outil `delegate`. Le nommage est
**neutre par rôle** (`llm-light` / `llm-heavy`).

### Changer de fournisseur

`config/pi/models.json` (seedé sur le volume) est **le seul fichier à éditer**
pour changer de fournisseur (`baseUrl`, `api`, identifiant de modèle) : le SDK
n'interpole pas `$VAR` pour ces champs (seuls `apiKey`/`headers` le sont). Voir
[`docs/lot2.md`](lot2.md#changer-de-fournisseur-nommage-neutre).

### Clés (jamais en clair)

Les clés arrivent par variables d'environnement (`.env`, gitignoré) et sont
référencées dans `config/pi/models.json` par `$YUKI_LLM_LIGHT_API_KEY` /
`$YUKI_LLM_HEAVY_API_KEY` :

```bash
# .env — ne jamais commit
YUKI_LLM_LIGHT_API_KEY=<clé dédiée au léger>
YUKI_LLM_HEAVY_API_KEY=<clé dédiée au lourd>
```

Aucun appel réseau n'est fait au démarrage : la disponibilité se déduit de la
**présence** de la clé (`PI_OFFLINE=1` respecté).

### Politique « clé manquante »

| `YUKI_LLM_MISSING_KEY_MODE` | Clé légère absente | Clé lourde absente |
| --- | --- | --- |
| `degrade` (défaut) | démarre en diagnostic, `/health/ready` → 503, `send` → `LLM_UNAVAILABLE` | démarre normalement, **délégation désactivée** |
| `refuse` | sortie non-zéro avant l'ouverture du port | idem |

### `delegate`

- `delegate(task, context?, deadline_ms?)` : le job démarre **immédiatement** en
  arrière-plan ; l'outil attend au plus `deadline_ms` (défaut **1500 ms**, bornes
  **200–60000**, clamp). Fini à temps → résultat **inline** ; sinon → `job_id`
  (`pending`). Le job **survit** toujours à la deadline.
- `job_status(job_id)` / `cancel_job(job_id)` pour suivre/interrompre.
- Concurrence : **3 jobs simultanés** + file de **10**
  (`YUKI_HEAVY_MAX_CONCURRENT`, `YUKI_HEAVY_MAX_QUEUE`). File pleine →
  `{status:"rejected", reason:"queue_full"}` immédiat.
- À la fin réelle, le lourd rend un **rapport** que le léger **résume** en 1–3
  phrases (aucune bulle utilisateur synthétique dans l'UI).

### Jobs persistés

Journal **append-only JSONL** : `/data/state/jobs.jsonl` (volume `state`),
rejoué au démarrage. Inspecter :

```bash
./scripts/logs.sh | grep -E 'pi\.phase|job\.'
grep -c '' .local/state/jobs.jsonl        # nombre d'événements
```

`/health` expose `subsystems.llm` et `subsystems.jobs` :

```bash
curl -s http://127.0.0.1:8080/health | jq '.subsystems.llm, .subsystems.jobs'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health/ready  # 503 si clé légère absente
```

### Instrumentation

Nouveaux étages `phase` corrélés par `jobId` : `delegate_received`,
`delegate_inline_wait`, `delegate_returned_inline|pending`, `job_enqueued`,
`job_started`, `job_first_token`, `job_finished`, `report_requested`,
`report_emitted`.

### Test d'intégration LLM réel (opt-in)

```bash
YUKI_TEST_REAL_LLM=1 npx vitest run tests/integration/real-llm.test.ts
```
