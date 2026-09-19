# Runbook

## 1. Démarrer

```bash
cp .env.example .env      # 1re fois — 5 variables de CÂBLAGE, aucun secret
docker compose up -d      # tire l'image publiée (ghcr) et démarre
curl -s http://127.0.0.1:8083/health | head
```

**C'est tout.** Aucune création de dossier, aucun `chown`, aucun script requis.
Le compose de base **tire** l'image publiée sur ghcr
(`ghcr.io/grokuku/yuki:latest`) et la persistance passe par **4 volumes
nommés** : `yuki-pi`, `yuki-workspace`, `yuki-models`, `yuki-state`.

### Premier démarrage : saisir les clés depuis la page `/config`

Le `.env` ne contient **plus aucune clé**. Ouvrez
`http://127.0.0.1:8083/config` : tant qu'aucune clé n'est saisie,
`/health/ready` répond **503** (« la conversation est indisponible »). Saisissez
la **clé LLM légère** (et la lourde si vous voulez la délégation) puis
**Enregistrer** : la bascule se fait **à chaud**, `/health/ready` passe à
**200** sans redémarrage. Le bouton **Tester la connexion** vérifie l'endpoint
avant d'enregistrer.

> La page `/config` fonctionne **même en mode dégradé** (sans clé, sans PiHost,
> et même si la porte GPU refuse) : c'est le point d'entrée du paramétrage.

Pour un volume nommé monté sur un chemin **qui existe déjà dans l'image**,
Docker initialise le volume avec le **contenu et le propriétaire** du
répertoire de l'image (créé en `YUKI_UID:YUKI_GID` par le Dockerfile) : le
conteneur non-root écrit donc dedans **sans préparation de l'hôte**.

> Si le paquet ghcr est **privé**, connectez-vous d'abord :
> `docker login ghcr.io -u <utilisateur>` (PAT avec `read:packages`).

`./scripts/up.sh` reste une **commodité** (copie `.env`, `docker compose up -d`,
attente de `/health/live`, timeout 90 s) — mais il n'est **plus nécessaire**.
`./scripts/doctor.sh` vérifie Docker/Compose/driver.

### Volumes : sauvegarder, inspecter, inspecter `models.json` et `config.json`

```bash
# Sauvegarder un volume (archive tar dans le répertoire courant)
docker run --rm -v yuki-state:/data -v "$PWD":/backup alpine:3.20 \
  tar czf /backup/yuki-state.tgz -C /data .

# Restaurer un volume (par-dessus le contenu existant)
docker run --rm -v yuki-state:/data -v "$PWD":/backup alpine:3.20 \
  tar xzf /backup/yuki-state.tgz -C /data

# Lister / inspecter / supprimer
docker volume ls | grep yuki
docker volume inspect yuki-state
docker volume rm yuki-state

# Inspecter les fichiers de configuration
#   /data/pi/agent/models.json    : GÉNÉRÉ au démarrage (fournisseurs/modèles)
#   /data/state/config.json       : store du paramétrage de la page /config (0600)
docker compose exec gateway sh -c 'cat /data/pi/agent/models.json'
docker compose exec gateway sh -c 'cat /data/state/config.json'
```

> **`models.json` est GÉNÉRÉ** (Lot 11) depuis la configuration effective : il
> est réécrit à **chaque** démarrage. Ne l'éditez plus à la main — passez par la
> page **`/config`** (ou l'API). Les **clés** n'y figurent jamais (seulement des
> références `$YUKI_LLM_*_API_KEY`). Le store `config.json` (paramétrage, clés
> incluses) est le **seul** état de configuration, isolé en `0600` sur le volume
> `state`.

> `settings.json` **conserve** son seed copie-si-absent (jamais écrasé) : il vit
> sur le volume **`yuki-pi`** (`/data/pi/agent/`).

### Migration depuis `./.local` (tests précédents)

Les anciens bind mounts `./.local/{pi,workspace,models,state}` ne sont plus
utilisés. Deux options :

- **Repartir de zéro** (recommandé) : `docker compose up -d` crée des volumes
  neufs ; le gateway régénère `models.json` et re-seede `settings.json`.
- **Recopier les données existantes** dans les volumes nommés :

```bash
for pair in pi:yuki-pi workspace:yuki-workspace models:yuki-models state:yuki-state; do
  src="./.local/${pair%%:*}"; vol="${pair#*:}"
  [ -d "$src" ] || continue
  docker run --rm -v "${vol}:/data" -v "$PWD/$src:/src:ro" alpine:3.20 \
    sh -c 'cp -a /src/. /data/ && chown -R 1000:1000 /data'
done
docker compose up -d
```

## 2. Observer

```bash
./scripts/logs.sh          # suivi des logs (100 dernières lignes)
./scripts/logs.sh 500      # 500 dernières lignes
curl -s http://127.0.0.1:8083/health/ready
curl -s http://127.0.0.1:8083/version
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

Depuis le Lot 11, le GPU se règle dans la page **`/config`** (groupe « GPU ») :

- **Forcer un profil** : `gpu.profile` = `confort` / `compact` / `repli` /
  `texte-seul` (ou ∅ = résolution automatique). En `strict`, un profil non
  satisfait fait **échouer** le démarrage.
- **Dégrader au lieu de refuser** : `gpu.compatMode` = `auto-degrade`.
- **Driver minimal** : `gpu.minDriver` (défaut 580).

Ces champs sont marqués **redémarrage** : ils sont enregistrés immédiatement mais
prennent effet au **prochain redémarrage** (`docker compose restart`).

- **Épingler une carte** : dans `compose.override.yml` (copie de
  `compose.override.example.yml`), remplacer `count: all` par
  `device_ids: ["0"]`.
- **Simuler un GPU** : `YUKI_GPU_FIXTURE=tests/fixtures/gpu/<fixture>.txt`
  (câblage).
- **Changer la commande** : `YUKI_GPU_CMD=/chemin/vers/nvidia-smi` (câblage).

> ⚠️ Forcer `gpu.profile`/`gpu.compatMode`/`gpu.minDriver` par
> l'**environnement** (compose, `.env`) **verrouille** le champ : la page
> l'affiche désactivé avec « Verrouillé par l'environnement » et l'API refuse le
> `PUT` (`locked_by_env`). La valeur du store est alors ignorée.

Après une modification par l'environnement : `docker compose up -d` (ou
`./scripts/up.sh`).

## 5. Réinitialiser l'état

```bash
./scripts/reset-state.sh          # demande confirmation
./scripts/reset-state.sh --yes    # sans prompt
```

Efface les volumes `yuki-state` et `yuki-workspace`. **Ne touche pas** aux
volumes `yuki-models` ni `yuki-pi` (agent Pi, sessions).

## 6. Dépannage

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `gateway.startup refused` | profil requis non satisfait en `strict` | lire les `CAPACITÉS MANQUANTES`, ajuster `gpu.profile` ou passer en `auto-degrade` dans `/config` |
| `nvidia-smi indisponible` dans le rapport | pas de GPU / driver / toolkit | `./scripts/doctor.sh`, vérifier `NVIDIA_VISIBLE_DEVICES` |
| `driver.floor` faux (service) | driver < 580 | **n'affecte pas le profil** ; exigence `asr`/`tts` (lots 6/7) — mettre à jour le driver hôte avant ces lots |
| `BF16 : non` | CC < 8.0 (ex. Quadro RTX 4000) | forcer `compact` (ou `repli`) |
| `/health/ready` = 503 | porte non passée | le serveur ne devrait pas être démarré ; vérifier les logs |
| Conteneur `Exit 1` immédiat | refus strict | `./scripts/logs.sh` puis corriger le profil |
| `permission denied` sur un montage | uid/gid du conteneur ≠ propriétaire du volume (`YUKI_UID`/`YUKI_GID` modifiés sans reconstruire l'image) | remettre `1000:1000` (défaut) dans `.env`, ou reconstruire l'image avec les mêmes valeurs (`compose.build.example.yml`) |
| Port déjà utilisé | autre service sur 8080 | `YUKI_GATEWAY_PORT=9090` dans `.env` |
| `LLM_UNAVAILABLE` dans l'UI | clé légère absente | ouvrir `/config`, saisir la **clé LLM légère**, Enregistrer (bascule **à chaud**) |
| `delegate` → `heavy_unavailable` | clé lourde absente | ouvrir `/config`, saisir la **clé LLM lourde** |
| `delegate` → `queue_full` | file lourde pleine (10) | attendre la fin des jobs ou ajuster `delegation.maxQueue` dans `/config` (redémarrage) |
| Champ grisé « Verrouillé par l'environnement » | variable d'env définie | retirer la variable du compose/`.env` puis redémarrer, ou faire `PUT` après suppression de la variable |
| `locked_by_env` au `PUT` | idem | idem |
| Modification « redémarrage » non appliquée | champ non à chaud | `docker compose restart` |
| `models.json` inattendu | il est **généré** à chaque démarrage | ne pas l'éditer : passer par `/config` |

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
xdg-open http://127.0.0.1:8083/           # ou ouvrir l'URL dans un navigateur

# Endpoints
curl -s http://127.0.0.1:8083/health | jq .subsystems
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/health/ready
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
- Buffer de rejeu **par session** : `transport.replayBuffer` (trames, défaut
  `1000`) et `transport.replayBytes` (octets, défaut `5 000 000`) — page
  `/config`, effet au redémarrage.
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

### Changer de fournisseur / de modèle (page `/config`)

Depuis le Lot 11, **plus aucun fichier à éditer**. Ouvrez `/config` et réglez,
pour chaque rôle, `baseUrl`, `api`, `model`, `thinking` (bouton **Tester la
connexion** disponible). Ces champs sont marqués **redémarrage** : enregistrés
immédiatement, ils prennent effet au **prochain redémarrage** (`docker compose
restart`), car ils nécessitent de **régénérer `models.json`** et de recréer le
runtime de modèles.

> `models.json` (`/data/pi/agent/models.json`) est **GÉNÉRÉ** au démarrage depuis
> la configuration effective. Il n'est plus seedé par copie-si-absent et ne doit
> plus être édité. Au **premier** démarrage après mise à jour, si le store est
> vide, un `models.json` existant sur le volume est **importé au mieux**
> (`baseUrl`/`api`/modèle par provider) — aucune configuration manuelle n'est
> perdue. Détails : [`docs/lot11.md`](lot11.md#modelsjson-devient-généré-le-point-structurant).

### Clés (jamais en clair)

Les clés se saisissent dans **`/config`** (champ `type=password`, vide même si
une clé existe) et sont stockées dans `/data/state/config.json` (`0600`). Un
**`PUT`** peut aussi les poser par l'API :

```bash
curl -s -X PUT -H 'content-type: application/json' -H 'X-Yuki-Config: 1' \
  --data '{"llm.light.apiKey":"<clé légère>"}' \
  http://127.0.0.1:8083/api/config
```

Les clés sont **à chaud** : dès l'enregistrement, elles sont poussées dans
`process.env` (référencées par `models.json` via `$YUKI_LLM_<ROLE>_API_KEY`), la
disponibilité (`/health/ready`) bascule **sans redémarrage** et **sans réseau**
(présence de clé). L'API ne renvoie **jamais** la valeur : uniquement
`configured` + un masque (`••••c0de`) ; l'action possible est **remplacer** ou
**effacer** (`null`). Aucun appel réseau au démarrage (`PI_OFFLINE=1` respecté).

### Politique « clé manquante »

| `llm.missingKeyMode` (`/config`) | Clé légère absente | Clé lourde absente |
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
  (`delegation.maxConcurrent`, `delegation.maxQueue`). File pleine →
  `{status:"rejected", reason:"queue_full"}` immédiat.
- À la fin réelle, le lourd rend un **rapport** que le léger **résume** en 1–3
  phrases (aucune bulle utilisateur synthétique dans l'UI).

### Jobs persistés

Journal **append-only JSONL** : `/data/state/jobs.jsonl` (volume `state`),
rejoué au démarrage. Inspecter :

```bash
./scripts/logs.sh | grep -E 'pi\.phase|job\.'
docker compose exec gateway sh -c 'wc -l < /data/state/jobs.jsonl'   # nombre d'événements
```

`/health` expose `subsystems.llm` et `subsystems.jobs` :

```bash
curl -s http://127.0.0.1:8083/health | jq '.subsystems.llm, .subsystems.jobs'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/health/ready  # 503 si clé légère absente
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
