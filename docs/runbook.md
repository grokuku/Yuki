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

### Bind mounts : permissions requises (piège)

Si vous utilisez des **bind mounts** (`compose.bind.example.yml`) au lieu des
volumes nommés, Docker crée les dossiers manquants en `root:root`. Le
conteneur tourne en **non-root** (uid/gid `1000` par défaut) : **chaque**
dossier monté en écriture (`pi`, `workspace`, **`state`**) doit appartenir à
cet uid/gid :

```bash
mkdir -p /chemin/hote/{pi,workspace,models,state}
chown -R 1000:1000 /chemin/hote
```

Le volume **`state`** porte le store `/data/state/config.json` (paramétrage et
clés). S'il n'est **pas inscriptible**, le **premier Enregistrement** de la
page `/config` échoue (HTTP **500** `config_store_unwritable`). Le gateway
détecte désormais ce cas **au démarrage** (log `volume.unwritable`) au lieu de
le laisser apparaître seulement à la première sauvegarde.

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
#   /data/state/personality.md    : personnalité de Yuki (éditable dans /config)
#   /data/state/rules.md          : RÈGLES STRICTES, éditées par VOUS seul dans
#                                   /config (Yuki ne peut pas les modifier ;
#                                   surcharges YUKI_PERSONALITY_PATH / YUKI_RULES_PATH)
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

### 2.1 Sources : un programme extérieur réveille Yuki

Un programme (agrégateur de news, client de messagerie, monitoring, cron) peut
réveiller Yuki par `POST /api/sources/<nom>/messages`, avec **son** jeton
(`Authorization: Bearer …`). Tout est ici, vérifié contre le code :
**[`docs/lot17-sources.md`](lot17-sources.md)** — création d'une source dans
`/config` (⚠️ le jeton n'est affiché **qu'une fois**), contrat HTTP complet
(corps exact + **toutes** les réponses `202/200/400/401/404/413/415/429` et quoi
faire), exemples `curl` / `bash` (cron) / `Python` / `Node`, idempotence, limites,
sécurité du jeton, diagnostic, suppression d'un fil qui reçoit des sources.

Pour observer un envoi : les événements `sources.*` du journal ci-dessus
(`sources.message.started`, `sources.message.stored` + `raison`,
`sources.message.duplicate`, `sources.message.unauthorized`,
`sources.message.rate_limited`, `sources.inbox.full`, `sources.run.finished`,
`sources.session.vanished`, `sources.session.detached`), **et** l'entrée
correspondante dans la section **« Notifications »** de la page `/` (état
`reçu` / `traité` / `en échec` / `alerte`).

### 2.2 Horodatages : UTC partout, SAUF la planification

**Tous les horodatages sont en UTC** (réglage `/config` → Système → *Affichage —
fuseau des horodatages*, `ui.timeZone`, défaut `UTC`) : les repères des prompts
(`[horodatage] … (UTC)`), les heures du fil de canal, l'interface, le journal et
les logs. Mattermost est en UTC : les deux affichent donc la MÊME heure pour un
même message. Le fuseau est passé **explicitement** à chaque formatage
(`src/pi/timestamp.ts`, miroir navigateur `public/ui/horodatage.js`) — jamais
celui du process ni celui du navigateur. Le suffixe est toujours affiché
(`15:39 UTC`) : une heure seule est ambiguë.

**Exception : la PLANIFICATION** suit le fuseau de **chaque déclencheur**
(`src/sources/cron.ts`) — « tous les jours à 9 h » reste **9 h locales** — et un
envoi programmé garde le fuseau de l'envoi (`src/chat/envois/quand.ts`). Les
instants stockés (`prochainPassage`, `creeLe`, `envoyeLe`…) sont en ISO UTC :
seul l'AFFICHAGE a changé, aucun instant n'a été décalé.

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
prennent effet au **prochain redémarrage**. Le plus simple est le bouton
**Redémarrer** de la page `/config` (voir §4.1), qui relance le programme **dans
le conteneur** ; l'équivalent terminal reste `docker compose restart` (qui, lui,
redémarre le conteneur).

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

### 4.1 Redémarrer Yuki depuis la page `/config`

Quand un champ marqué **redémarrage** vient d'être enregistré, la page `/config`
propose un bouton **Redémarrer** (section « Redémarrer Yuki », sous le bloc
« Résultat de l'enregistrement »). Il évite d'ouvrir un gestionnaire de
conteneurs :

1. une **confirmation** rappelle que la conversation et les jobs en cours sont
   interrompus ;
2. l'application répond **200** (`POST /api/admin/restart`, protégé par le même
   en-tête `X-Yuki-Config` et le même contrôle `Origin`/`Host` que la config) ;
3. elle **ferme proprement** ses sockets WebSocket puis son serveur HTTP
   (`gateway.shutdown` / `gateway.stopped`), sans `process.exit()` brutal ;
4. l'arrêt gracieux sort alors avec le **code convenu `75`** (`EX_TEMPFAIL`) ;
   le **superviseur interne** à l'image (`infra/gateway/supervisor.mjs`, qui est
   l'`ENTRYPOINT`) reconnaît ce code et **relance le programme** — **le
   conteneur reste en place**, sans redémarrage Docker et sans accès au socket
   Docker ;
5. la page **sonde `/health/live`** jusqu'au retour du gateway, puis se
   **recharge** toute seule.

> **Redémarrage interne, pas redémarrage de conteneur.** Le superviseur ne
> relance que le code **75**. Tout autre code (crash, refus de démarrage) est
> **propagé** et le superviseur termine : une vraie panne reste visible. C'est
> cette distinction qui rend une **politique de redémarrage Docker**
> (`restart: unless-stopped`) toujours utile — pour les **vrais crashs**, où le
> conteneur doit revenir — mais **plus nécessaire pour ce bouton**.

> Yuki **n'utilise jamais le socket Docker** ni l'API Docker (invariant du
> projet) : le redémarrage est entièrement interne à l'image.

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
| log `volume.unwritable` au démarrage — `hint` « **lecture seule** » (code `EROFS`) | le montage du volume est en **lecture seule** (`:ro`, rootfs) — le `chown` n'y changerait rien | retirer `:ro` du volume concerné dans le service `gateway` du compose (variante bind), ou le passer en lecture-écriture, puis redémarrer |
| log `volume.unwritable` au démarrage — `hint` « **permissions** » (codes `EACCES`/`EPERM`) | bind mount en `root:root` alors que le conteneur est non-root (uid 1000) | `chown -R 1000:1000` du dossier hôte (voir `compose.bind.example.yml`) puis redémarrer |
| log `volume.unwritable` au démarrage — `hint` « **absent** » (code `ENOENT`) | volume non déclaré / dossier hôte manquant | déclarer le volume dans le compose (ou créer le dossier hôte du bind mount) puis redémarrer |
| log `volume.unwritable` au démarrage — **autre code** (`hint` cite le code brut) | cause non déterminable à partir du code | lire le `hint` (il cite `error` et `code`) puis inspecter montage **et** permissions |
| `PUT /api/config` = **500** `config_store_unwritable` | volume **`state`** non inscriptible — le message du serveur donne la cause **exacte** (lecture seule `EROFS`, permissions `EACCES`, dossier absent `ENOENT`…) | suivre le message : `:ro` → retirer `:ro` ; permissions → `chown -R 1000:1000` ; sinon `docker compose exec gateway ls -ln /data/state` — voir la ligne `volume.unwritable` dans les logs |
| Port déjà utilisé | autre service sur 8080 | `YUKI_GATEWAY_PORT=9090` dans `.env` |
| `LLM_UNAVAILABLE` dans l'UI | clé légère absente | ouvrir `/config`, saisir la **clé LLM légère**, Enregistrer (bascule **à chaud**) |
| `delegate` → `heavy_unavailable` | clé lourde absente | ouvrir `/config`, saisir la **clé LLM lourde** |
| `delegate` → `queue_full` | file lourde pleine (10) | attendre la fin des jobs ou ajuster `delegation.maxQueue` dans `/config` (redémarrage) |
| Champ grisé « Verrouillé par l'environnement » | variable d'env définie | retirer la variable du compose/`.env` puis redémarrer, ou faire `PUT` après suppression de la variable |
| `locked_by_env` au `PUT` | idem | idem |
| Modification « redémarrage » non appliquée | champ non à chaud | bouton **Redémarrer** dans `/config` (relance le programme dans le conteneur) ou `docker compose restart` |
| Bouton **Redémarrer** sans effet / Yuki ne revient pas | arrêt au démarrage (mauvaise config) ou superviseur en boucle | `./scripts/logs.sh` : chercher `[supervisor]` (`pas de relance (panne)`, `boucle détectée`) et corriger la cause ; un champ « redémarrage » invalide peut faire échouer le démarrage |
| log `[supervisor] boucle détectée` | le programme ressort en 75 plusieurs fois de suite (arrêt gracieux immédiat) | vérifier que `POST /api/admin/restart` n'est pas appelé en boucle ; corriger puis redémarrer le conteneur |
| `models.json` inattendu | il est **généré** à chaque démarrage | ne pas l'éditer : passer par `/config` |
| Application **non installable** (« l'installation n'est pas disponible ») et/ou message navigateur « Une erreur s'est produite lors du chargement du manifeste : `NetworkError when attempting to fetch resource.` » | le manifeste (`/manifest.webmanifest`) est **derrière le `forward_auth`** du reverse-proxy : le navigateur le réclame **SANS le cookie de session** et reçoit une **redirection** | excepter `/manifest.webmanifest` **et** `/sw.js` de l'authentification — voir **§6.1** |

### 6.1 Reverse-proxy (Caddy v2 + authentik) : excepter le manifeste et le service worker

Yuki n'implémente **aucune authentification** : l'accès est protégé **en amont**
par le reverse-proxy. Si vous mettez Yuki derrière un `forward_auth` (authentik),
vous **devez** excepter **deux chemins**. Sinon l'application n'est **pas
installable** et le navigateur affiche :

> « **Une erreur s'est produite lors du chargement du manifeste :**
> `NetworkError when attempting to fetch resource.` »

**Pourquoi (comportement prescrit par le standard, pas un bug).** Le navigateur
réclame le **manifeste web** en mode `credentials: "omit"` : la requête part
**sans le cookie de session**, même quand vous êtes connecté. Derrière
`forward_auth`, cette requête est donc vue comme **non authentifiée** et
**redirigée (302) vers le portail authentik** — une **autre origine** : le
navigateur bloque alors la redirection (CORS) et signale `NetworkError`.

Le **service worker** `/sw.js`, lui, est réclamé **avec** le cookie (mode
`credentials: "same-origin"`) : il passe aujourd'hui. On l'excepte quand même,
car un script de service worker **redirigé est refusé**, et il doit rester
joignable même session expirée.

> ⚠️ Ce n'est ni un défaut de Yuki ni un défaut de Caddy : c'est exactement ce
> que demande le standard pour le manifeste. Le seul correctif est d'**excepter
> le manifeste de l'authentification**.

**Configuration Caddy v2 (exemple — adapter l'hôte et le port) :**

```caddy
yuki.example.com {
	# (1) Manifeste PWA — PUBLIC : le navigateur le réclame SANS cookie.
	handle /manifest.webmanifest {
		reverse_proxy 127.0.0.1:8083
	}

	# (2) Service worker — PUBLIC : un script de worker redirigé est refusé.
	handle /sw.js {
		reverse_proxy 127.0.0.1:8083
	}

	# (3) Tout le reste — derrière authentik.
	handle {
		forward_auth 127.0.0.1:9000 {
			uri /outpost.goauthentik.io/auth/caddy
			copy_headers X-Authentik-Username X-Authentik-Groups X-Authentik-Email X-Authentik-Name X-Authentik-Uid
		}
		reverse_proxy 127.0.0.1:8083
	}
}
```

**Diagnostic sans outil (F12 → Réseau).** Ouvrir l'application, recharger, puis
cliquer la requête **`manifest.webmanifest`** :

| Ce qu'on observe | Signification |
| --- | --- |
| **200**, type `application/manifest+json`, **aucune** redirection | ✅ correct — l'installation doit être proposée |
| **302 / 307** vers une **autre origine** (ex. `auth.…`) | ❌ **c'est la cause** : le manifeste est protégé par `forward_auth` |
| **200** mais type `text/html` | ❌ une **page de connexion** a été servie à la place du manifeste |
| **401 / 403** | ❌ le manifeste est protégé par l'authentification |

Vérifier de la même façon **`sw.js`** (200, `text/javascript`, **aucune**
redirection). En ligne de commande (sans cookie, comme le navigateur pour le
manifeste) :

```bash
curl -si https://yuki.example.com/manifest.webmanifest | head -20   # pas de 3xx
curl -si https://yuki.example.com/sw.js                  | head -20   # pas de 3xx
```

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

Le script **résout** le digest depuis le miroir public `mirror.gcr.io` (sha256 du
manifeste **confronté** à l'en-tête `Docker-Content-Digest`), puis **propose**
les valeurs à reporter dans les quatre emplacements (Dockerfile
`ARG NODE_BASE`, `scripts/node-base-ref.sh`, workflow de repli, `docs/versions.md`)
et signale une **dérive** si l'un d'eux porte un digest périmé.

Il n'écrit rien. Le repli GHCR (`ghcr.io/<propriétaire>/yuki-node-base:<tag>`)
se **réalimente** avec le workflow manuel « Miroir image de base (GHCR) » :
procédure complète dans [`versions.md`](versions.md) § « Réalimentation du
miroir (repli GHCR) ».

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

### Les huit usages des deux modèles (Lot 33)

⚠️ Une seule table fait foi. « Réflexion » = niveau RÉELLEMENT transmis au
modèle pour cet appel, jamais une supposition : il est lu à chaud dans
`llm.<role>.thinking` (défaut `off` pour `light`, `high` pour `heavy`).

| # | usage | rôle | réflexion | repli | fichier:ligne |
| --- | --- | --- | --- | --- | --- |
| 1 | conversation (interface) | discussion | `llm.light.thinking` | aucun — le léger est requis | `src/index.ts:2565` |
| 2 | juge du mode `auto` | discussion | **`off` figé — exception assumée** (exécuté à chaque message) | aucun — léger indisponible ⇒ ne répond pas | `src/index.ts:1464` · appel `:1875` |
| 3 | rédacteur de canal | discussion | **`off` figé** (même fabrique que le juge) | aucun — modèle introuvable ⇒ refus explicite | `src/index.ts:1816` · fabrique `:1464` |
| 4 | worker (tâche déléguée) | travail | `llm.heavy.thinking` | aucun — `delegate` refuse (`heavy_unavailable`) quand le lourd manque | `src/index.ts:2144-2145` · `src/delegation/service.ts:305-307` |
| 5 | extraction mémoire | travail | `llm.heavy.thinking`, sinon `llm.light.thinking` | **léger** (`memoryWriteModelReference`) | `src/index.ts:2227-2237` · `:2251-2254` · `src/memory/write-model.ts:36-48` |
| 6 | consolidation hebdo de la mémoire | travail | `llm.heavy.thinking` | **aucun — lourd imposé** (passe REFUSÉE si le lourd manque) | `src/index.ts:2303-2305` · `src/memory/consolidation-hebdo.ts:437` |
| 7 | synthèse du libraire | travail | `llm.heavy.thinking`, sinon `llm.light.thinking` | **léger** (`memoryWriteModelReference`) | `src/index.ts:2380-2391` |
| 8 | récapitulatif | travail | `llm.heavy.thinking`, sinon `llm.light.thinking` | **léger** (`memoryWriteModelReference`) | `src/index.ts:2925-2938` |

Chaque repli vers le léger journalise **`llm.fallback { usage, de, vers, raison }`**
(`src/memory/write-model.ts:36-48`) — jamais un contenu ni une clé.

### Changer de fournisseur / de modèle (page `/config`)

Depuis le Lot 11, **plus aucun fichier à éditer**. Ouvrez `/config` et réglez,
pour chaque rôle, `baseUrl`, `api`, `model`, `thinking` (bouton **Tester la
connexion** disponible). Ces champs sont marqués **redémarrage** : enregistrés
immédiatement, ils prennent effet au **prochain redémarrage** (bouton
**Redémarrer** de `/config` — le programme est relancé dans le conteneur — ou
`docker compose restart`), car ils nécessitent de **régénérer `models.json`** et
de recréer le runtime de modèles.

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
- **`context` est transmis au worker** (bloc « ⚠️ CONTEXTE » APRÈS la tâche,
  plafond **8 000 caractères**, refus explicite au-delà — jamais de troncature
  muette).
- **Pièces jointes jointes automatiquement** : le worker reçoit la liste des
  fichiers de la conversation (identifiant, nom, genre, taille, date) — aucun
  contenu, aucun historique — bornée à **30 lignes**, avec renvoi à
  `lister_fichiers` s'il y en a plus. Le léger n'a rien à transmettre.
- `lister_fichiers()` (worker lourd) rend les **identifiants** : c'est ce
  qu'exige `deposer_fichier`. Côté léger, `envoyer_fichier` sans argument rend
  la même liste, identifiants compris.
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

## 11. Libraire (Libry)

Service externe (recherche documentaire + web, et capture de pages). Réglé dans
**`/config` → onglet Système → Libraire** :

| Champ | Rôle |
| --- | --- |
| `librarian.baseUrl` | URL de Libry (ex. `http://pi-web:3000`). Vide = outils non exposés. |
| `librarian.apiKey` | **Seul champ requis** : clé `lib-…`, envoyée en `X-API-Key` (et en `Authorization`). |
| `librarian.agentToken` | **Facultatif** (compatibilité) : envoyé en `Authorization` s'il est renseigné, jamais s'il est vide. |
| `librarian.screenshot` | `on` (défaut) / `off` : expose l'outil `capture_libraire` (capture d'une page http/https, image transmise à Yuki et affichée dans la conversation). |

⚠️ Libry n'a **qu'une couche d'authentification** : une clé acceptée en
`Authorization: Bearer` **ou** en `X-API-Key`. Un `agentToken` obsolète n'est
plus exigé et ne masque plus `apiKey`.

⚠️ Les captures sont stockées sous `${state}/librarian-shots` et servies en
same-origin (`/captures/<id>.png`). Aucune clé n'apparaît dans les journaux,
les messages d'erreur ni les artefacts.

⚠️ **Conservation** : une capture n'est plus éphémère. Elle est gardée **comme une
pièce jointe** (même réglage `files.retentionDays`, même purge périodique — voir
`src/files/retention.ts`) et **revient après un rechargement** (le `snapshot` est
suivi de la ré-émission des médias conservés de la conversation). Lire une capture
expirée répond **404** et supprime le fichier.

## 12. Coffre de secrets (exécution sur agents)

Yuki peut injecter des secrets dans une commande exécutée sur une **machine
appairée** — **sans jamais écrire la valeur dans la commande**. Le modèle
référence un secret par son **nom** ; Yuki fournit sa valeur par **variable
d'environnement** (c'est le shell qui développe `$NOM`).

### 12.1 Mise en service (côté opérateur)

1. **Générer une clé maître** et la conserver **AILLEURS** (gestionnaire de
   mots de passe) : `openssl rand -base64 48`.
2. La fournir à Yuki en **`YUKI_VAULT_KEY`** (hors bande, jamais dans un
   fichier suivi par git). ⚠️ Sans cette variable, le coffre **REFUSE toute
   opération** : aucune commande référençant un secret ne s'exécute, et
   l'onglet **Secrets** de `/config` l'indique clairement. **Aucun repli en
   clair.**
3. Dans **`/config` → onglet Secrets**, enregistrer un secret : un **nom**
   (préfixe réservé `YUKI_SECRET_`, ex. `YUKI_SECRET_NAS`), un libellé d'usage
   facultatif, et la **valeur** (≥ 6 caractères). La valeur est **chiffrée**
   (AES-256-GCM) dans `${state}/secrets.vault.json` (mode `0600`) ; l'API ne la
   renvoie **jamais**.
4. Dans une commande (`run_command`), référencer le secret par `${NOM}` :
   ex. `curl -H "Authorization: Bearer ${YUKI_SECRET_NAS}" …`. Le modèle peut
   lister les noms via l'outil `lister_secrets`.

### 12.2 Flux `awaiting_secret`

Si la commande référence un secret **absent du coffre**, elle **n'est pas
exécutée** : une **fenêtre flottante** s'affiche dans la conversation (machine
+ commande EXACTE + TTL). L'humain saisit la valeur ; elle est **chiffrée** puis
la commande est **rejouée automatiquement**. C'est un flux **dédié**, qui couvre
aussi les agents **sans validation**.

⚠️ **Si vous perdez `YUKI_VAULT_KEY`, les secrets sont définitivement perdus** :
il n'existe aucun recours (la clé n'est rangée nulle part avec le coffre).

### 12.3 Limites (à connaître)

- **Secret transformé NON masqué** : le masquage de la sortie couvre la valeur
  **exacte**. Une valeur transformée par la commande (base64, URL-encodage,
  découpage, hachage…) **peut apparaître** dans la sortie. Ne construisez pas de
  commandes qui transforment un secret et l'affichent.
- **Valeur < 6 caractères refusée** : en dessous, le masquage sur-masquerait du
  texte légitime. Le coffre impose donc une longueur minimale.
- **Côté agent Go (hors périmètre de Yuki)** : la valeur lui parvient en
  **variable d'environnement** ; ses **propres** journaux (sur la machine
  distante) peuvent la contenir. Yuki ne peut pas les contrôler.
- **Transport navigateur → serveur** : la fenêtre de secret transmet la valeur
  du **navigateur au serveur** en HTTP. Yuki n'implémente **aucune
  authentification** ; sur un LAN non chiffré, la valeur **transite en clair sur
  le réseau**. Utilisez HTTPS/TLS en amont pour tout secret sensible.

### 12.4 L'agent doit être à JOUR — capacité `env` (refus sécurisé)

Le shell développe `$YUKI_SECRET_…` en **chaîne VIDE** si la variable n'est pas
posée. Une commande anodine comme `rm -rf /$YUKI_SECRET_DIR` deviendrait alors
`rm -rf /` — **destructrice**. Deux garde-fous indépendants existent :

1. **Côté Yuki (gateway)** : l'agent déclare ses **capacités** au `hello`. Si un
   agent ne déclare pas la capacité **`env`** (réception des secrets par variable
   d'environnement), Yuki **REFUSE d'envoyer** toute commande qui référence un
   secret — **aucune commande n'est transmise** — et renvoie un message
   actionnable « **ton agent est TROP ANCIEN : mets-le à jour** ».
2. **Côté agent (Go)** : quelle que soit l'origine de la trame, si une commande
   référence une variable réservée (`$YUKI_SECRET_…` / `${YUKI_SECRET_…}`) qui
   n'est **pas fournie** (ou l'est **vide**), l'agent **REFUSE** la commande
   (`missing_secret_env`) et **ne lance AUCUN processus**.

⇒ **Un agent trop ancien (= binaire d'avant la capacité `env`) ne peut plus
exécuter de commande porteuse d'un secret : il la refuse au lieu de l'exécuter à
vide.** Les commandes SANS secret continuent de fonctionner normalement.

#### Mettre l'agent à jour (exactement)

* **1. Obtenir le binaire** (la version est lisible par `yuki-agent version`) :
  * depuis la **release GitHub `v<version>`** — ⚠️ même numéro que l'image du
    gateway (`version.txt`). La version la plus récente :
    ```sh
    gh release list --limit 1            # ou : voir github.com/grokuku/Yuki/releases
    ```
  * **téléchargement + vérification** (exemple pour `v0.1.0`, linux/amd64) :
    ```sh
    gh release download v0.1.0 \
      --pattern 'yuki-agent-linux-amd64-musl' --pattern SHA256SUMS
    sha256sum -c SHA256SUMS --ignore-missing
    chmod +x yuki-agent-linux-amd64-musl
    ./yuki-agent-linux-amd64-musl version    # → « yuki-agent 0.1.0 »
    ```
    Sans `gh` (même contenu, via `curl`) :
    ```sh
    curl -fLO https://github.com/grokuku/Yuki/releases/download/v0.1.0/yuki-agent-linux-amd64-musl
    curl -fLO https://github.com/grokuku/Yuki/releases/download/v0.1.0/SHA256SUMS
    ```
    ⚠️ `agent/deploy/install.sh` **ne télécharge rien** : il installe un binaire
    DÉJÀ présent (`--binary <chemin>`).
  * ou **en local** (from source), avec la version de `version.txt` :
    ```sh
    cd agent
    go build -ldflags "-s -w -X github.com/grokuku/yuki/agent/internal/buildinfo.Version=$(tr -d '[:space:]' < ../version.txt)" \
      -o yuki-agent ./cmd/yuki-agent
    ./yuki-agent version      # doit afficher la version de version.txt
    ```
* **2. Installer (systemd)** :
  ```sh
  sudo agent/deploy/install.sh --binary ./yuki-agent-linux-amd64-musl
  ```
  Le script **copie le binaire** dans `/usr/local/bin/yuki-agent`, réinstalle
  l'unité et **redémarre** le service (`systemctl restart yuki-agent`).
* **3. Sans le script** : remplacer le fichier puis redémarrer
  ```sh
  sudo install -m 0755 ./yuki-agent /usr/local/bin/yuki-agent
  sudo systemctl restart yuki-agent
  ```
* **4. Unraid** : remplacer `/mnt/user/appdata/yuki-agent/yuki-agent` et relancer
  le wrapper (cf. `agent/deploy/unraid.md` §6, « mise à jour propre »).
* **5. Vérifier** : dans `/config` → Agents, le détail de l'agent doit lister la
  capacité **`env`**. Les journaux de l'agent doivent contenir
  `agent.commande.secret_env_manquant` uniquement en cas d'anomalie.

⚠️ **`systemctl enable --now` ne redémarre PAS un service déjà actif** : la
mise à jour exige un `restart` explicite (fait par `install.sh`). C'est la cause
la plus fréquente d'un « j'ai remplacé le binaire et rien n'a changé ».

## 13. Fichiers échangés (envoi et réception)

Yuki **reçoit** des fichiers de l'utilisateur (bouton « Joindre » du composeur ou
glisser-déposer — le bouton fonctionne aussi **sur téléphone**) et peut en
**envoyer** (outil `envoyer_fichier` : elle renvoie un fichier déjà présent dans
la conversation). Elle peut aussi **transférer** un fichier vers/depuis une
**machine appairée** (`recuperer_fichier` / `deposer_fichier`, voir § 13.7).

Réglages dans **`/config` → onglet Conversation → groupe « Fichiers échangés »** :

| Champ | Rôle |
| --- | --- |
| `files.maxFileBytes` | Plafond **par fichier** (défaut **2 Gio**, max 8 Gio). Au-delà : **refus explicite** (413), rien n'est conservé. |
| `files.retentionDays` | Rétention (défaut **30 jours**). À l'échéance, le **fichier ET son analyse** sont supprimés. |
| `files.maxAttachments` | Fichiers joints à **un** message (défaut 5). Au-delà : non joints, et c'est dit. |
| `files.promptChars` | **Borne d'injection** par fichier (défaut 12 000 caractères). |
| `files.promptTotalChars` | **Borne d'injection** totale par message (défaut 24 000). |
| `files.imageMaxBytes` | **Garde-fou de LECTURE** de VISION : poids maximal du **FICHIER** image transmis au modèle (défaut **3 500 000 octets**). Au-delà, l'image est **réduite à la volée** ; si elle ne peut pas l'être (ou si elle deviendrait illisible), le message est **refusé** explicitement. ⚠️ Ce n'est PAS la taille sur le fil (base64 ×1,33) : voir la ligne suivante. |
| `files.imageMaxWireBytes` | ⚠️ **La borne qui compte sur le fil** : taille maximale **TRANSMISE** d'une image, en **base64** (défaut **700 000 octets**, ~0,7 Mo). Au-delà, l'image est **réduite davantage** (côté, puis **ré-encodage JPEG** si un PNG reste trop lourd) ; si elle ne peut pas l'être sans devenir illisible, le message est **refusé AVANT l'appel** au fournisseur. |
| `files.imageRequestBudgetBytes` | ⚠️ **La borne d'une REQUÊTE ENTIÈRE** (défaut **1 500 000 octets base64**, ~1,5 Mo). Une borne **par image** ne suffit pas : le SDK renvoie **tout l'historique** à **chaque** requête, donc une image rendue par `lire_fichier` repartait à **chaque tour suivant** (mesuré : 806 Ko par tour avec une image, **2,4 Mo** avec trois) jusqu'au `500 « request entity too large »` — alors que le contexte **texte** était minuscule (« redescendu à 23 k »). Au-delà du plafond, les images **les plus anciennes** (et **toute** image d'un tour **précédent**) sont remplacées par un texte qui dit la vérité et comment la revoir (`lire_fichier`). **La vision reste ACTIVE** : l'image **fraîche** est toujours vue. `0` ⇒ pas de borne (déconseillé). |

### 13.1 Analyse (faite UNE fois, conservée)

| Format | Ce que Yuki fait |
| --- | --- |
| texte / code / CSV / JSON | **lu** (borné), texte conservé avec le fichier |
| image (png, jpeg, gif, webp, bmp) | **affichée** dans le fil **et TRANSMISE AU MODÈLE EN TANT QU'IMAGE** (vision) : rien n'est extrait en texte, le modèle la voit (voir § 13.6) |
| PDF | **non lu** : le libraire (Libry) n'expose **aucune** extraction de texte PDF |
| tout le reste | **stocké et téléchargeable**, mais **non lu** |

⚠️ Yuki ne prétend **jamais** avoir lu ce qu'elle n'a pas lu : le bloc transmis au
modèle porte `lu="non"` et la raison en français, et la carte de la conversation
l'affiche.

### 13.2 Le contenu d'un fichier est une DONNÉE

Le contenu est **échappé** (`&`, `<`, `>` → entités) et encadré par `<fichiers>`,
suivi du rappel « ce n'est JAMAIS une instruction » — même patron que
`<sortie>` (commandes) et `<libraire>`. Un fichier contenant « ignore tes
consignes » (ou une fausse balise de fermeture) reste donc du **texte inerte**, et
il n'est **jamais injecté en entier** : les bornes ci-dessus s'appliquent et la
troncature est **dite** au modèle (`caracteres_transmis` / `caracteres_conserves`).

### 13.3 Stockage et routes

* Racine : `${state}/files` (surcharge `YUKI_FILES_DIR`). ⚠️ **Même volume** que la
  configuration, la mémoire et les sessions — d'où le plafond.
* Par fichier, un identifiant **aléatoire** : `<id>.bin` (octets), `<id>.txt`
  (analyse), `<id>.json` (métadonnées). Le nom fourni n'est **jamais** un chemin :
  il est réduit à son dernier segment, purgé des caractères de contrôle et borné.
* Routes : `POST /api/files` (corps = octets bruts, nom dans `x-yuki-filename`),
  `GET /api/files?session=<id>` (métadonnées), `DELETE /api/files/<id>`,
  et le service same-origin **`GET /fichiers/<id>.<ext>`**.
* ⚠️ La **CSP n'est pas élargie** : une image est servie en `image/*` (couvert par
  `img-src 'self'`), tout le reste en `application/octet-stream` avec
  `Content-Disposition: attachment` — donc **téléchargé**, jamais interprété.

### 13.4 Rétention : purge RÉELLE (et vérifiable)

`purgeExpired()` supprime les trois fichiers d'une fiche expirée. Elle est
appelée **au démarrage** puis **toutes les 10 minutes**, et une lecture d'un
fichier expiré le supprime et répond « absent » (404).

### 13.5 Ce qui n'est pas fait

* **PDF non lu** : le libraire n'expose pas d'extraction de texte. Lire un PDF
  demanderait une dépendance (`pdfjs`, `pdftotext`) — **non ajoutée sans accord**.
* **PDF / binaire en vision** : un PDF n'est pas converti en image (il faudrait
  un moteur de rendu, dépendance lourde) — il reste annoncé `lu="non"` avec sa
  raison.
* **Fichier venu d'un agent** : c'est désormais **fait** (capacité `files`, voir
  § 13.7) ; ce qui reste absent est la reprise d'un transfert **après expiration**
  ou au-delà d'**une** reprise après coupure, et le transfert de fichiers
  **supérieurs au plafond** (`run_command` + `scp`/`rsync` restent la voie).
* **Entrée externe** (ex. un process qui dépose un GIF météo) : non construite.
  Le point d'accroche existe — `FilesStore.saveBytes(octets, { name, mimeType,
  origin: "externe", sessionId })`, puis `FilesService.attach(sessionId, [id])`
  (ou `send()` pour une apparition immédiate dans le fil) — sans aucune route
  publique d'écriture pour l'instant.

### 13.6 Vision : l'image est VUE par le modèle (réduite à la volée, jamais stockée)

Une image jointe ne sert pas qu'à l'affichage : elle part dans le **message
utilisateur** sous forme de pièce jointe `ImageContent` (base64 + type MIME),
sur `session.prompt(…, { images })` **et** sur `session.steer(…, images)` quand
le message est injecté dans un tour en cours.

#### ⚠️ La capacité VISION est une DÉCLARATION (le piège qui coûte une soirée)

Aucune API de fournisseur ne publie « ce modèle voit les images » : Yuki **ne
peut pas la mesurer**. La capacité est donc une **déclaration**, réglée dans
`/config` → onglet **Modèles** → **« Reçoit les images (vision) »**
(`llm.light.vision` pour la conversation, `llm.heavy.vision` pour le worker),
valeurs `oui` / `non`, appliquée à chaud.

Ce réglage produit le champ `input` du modèle dans `models.json` :

| Réglage | `input` généré | Conséquence |
| --- | --- | --- |
| `oui` | `["text", "image"]` | l'image part en pièce jointe, le modèle la voit |
| `non` | `["text"]` | ⚠️ **l'image n'est pas envoyée** — et c'est **dit** |

⚠️ **Pourquoi c'est un piège** : avec `input: ["text"]`, le SDK **remplace** toute
partie image par `(tool image omitted: model does not support images)`. Le modèle
reçoit alors du **bruit** au milieu de son prompt et **on croit** qu'il a vu
l'image. D'où deux garde-fous :

* un message porteur d'une **image** est **refusé** (trame d'erreur
  `file_image_vision_disabled`) si la conversation est déclarée sans vision ;
* `recuperer_fichier` **n'envoie pas** l'image au worker déclaré texte seul et
  l'écrit dans son résultat (`image_error: "model_without_vision"`).

⚠️ **Où éditer** : le `models.json` du volume `state` est **réécrit à chaque
démarrage** (`writeModelsFile`, `src/pi/config.ts`) depuis `buildModelsConfigFrom`
(`src/llm/models.ts`) : une correction **manuelle** de ce fichier est **perdue**.
Le seul endroit qui compte est le réglage `/config` (ou, hors interface,
`config/pi/models.json`, qui n'est que le reflet testé des défauts).

| Règle | Valeur |
| --- | --- |
| Côté maximal transmis (`VISION_MAX_EDGE`) | **2 000 px** (au-delà, l'image est réduite) |
| Côté minimal LISIBLE (`VISION_MIN_EDGE`) | **700 px** — en dessous, on **refuse** (un texte ne serait plus lisible) |
| Poids du FICHIER (`files.imageMaxBytes`) | **3 500 000 octets** : au-delà, réduction ; si elle échoue, **refus explicite** |
| Poids **TRANSMIS** (`files.imageMaxWireBytes`) | **700 000 octets base64** (~0,7 Mo sur le fil) : la borne que le fournisseur voit |

#### ⚠️ La taille qui compte est celle TRANSMISE (base64 ×1,33), pas celle du fichier

Le base64 pèse **×1,33** sur les octets du fichier : une capture de **2 876 Ko**
part à **3,8 Mio** si on l'envoie telle quelle, et **3,2 Mio** si on se contente de
réduire le côté en gardant le PNG. C'est exactement ce qui a produit, le
2026-11-01, un `500 « request entity too large »` **après 17 s et 0 jeton** — la
même image, le même modèle et le même fournisseur fonctionnaient depuis un client
qui, lui, **ré-encode** (479,5 Ko en 2000×861).

Le budget donné au réducteur est donc le **plus petit des deux plafonds, exprimé
en base64** (`src/files/vision.ts`) :

| Étape | Ce qui se passe |
| --- | --- |
| 1. côté | ramené à **2 000 px** au plus (`resizeImage` du SDK, Photon) |
| 2. ré-encodage | le SDK essaie **PNG**, puis **JPEG q80 → q40** ; il retient le premier candidat qui tient sous le budget ⇒ un PNG très détaillé est **ré-encodé** (mesuré : 3 208 Ko → **208 Ko**, à dimensions identiques 2000×861) |
| 3. contrôle après coup | les octets **réellement émis** (`data.length`, base64) sont re-vérifiés contre le plafond |
| 4. refus | si la réduction devrait descendre **sous 700 px**, le message est **refusé AVANT l'appel** (`file_image_illegible`) : un texte à cette taille ne serait plus lisible, et l'utilisateur n'aurait aucun moyen d'agir après coup |

* La version réduite est **éphémère** : ni disque, ni cache, ni base.
* Formats transmis : **PNG, JPEG, GIF, WebP**. Un BMP (affichable) est **refusé**
  en vision, avec un message qui le dit.
* **Aucun refus dans le cas normal** : une photo de 5 Mo est réduite et part.
* ⚠️ **Transparence** : un PNG qui tient sous le plafond transmis est conservé
  (alpha préservé). S'il ne tient pas, le ré-encodage JPEG **aplatit** l'alpha sur
  du noir — l'image reste lisible, mais c'est la contrepartie du ré-encodage.
* ⚠️ **Coût (mesuré, pour le TTFT)** : le redimensionneur (`resizeImage` du SDK,
  Photon/WASM) coûte ~**1,8 s** pour une capture 2560×1440 et ~**2 à 4 s** pour
  une image de 5 à 9 Mo à réduire. Une image **déjà dans les bornes ne paie
  RIEN** (chemin rapide : base64 seul, ~1 ms pour 543 Ko).
* ⚠️ **Contexte** : le SDK estime une image à ~1 200 jetons (`ESTIMATED_IMAGE_CHARS`),
  quelle que soit sa taille — le contexte ne peut donc pas exploser par ce canal.
* ⚠️ **Tous les chemins d'image** consultent la MÊME déclaration : un message
  porteur d'une image est **refusé** (`file_image_vision_disabled`) si la
  conversation est déclarée sans vision ; `generer_image` et `capture_libraire`
  **n'attachent pas** l'image (`image_attached: false`) et écrivent le motif dans
  leur résultat ; `recuperer_fichier` et `lire_fichier` font de même (§ 13.7).

#### ⚠️ Une image de RÉSULTAT D'OUTIL change la FORME de la conversation (`requiresAssistantAfterToolResult`)

Le SDK **n'écrit jamais l'image dans le message `tool`** : il y met le texte seul
(`(see attached image)` s'il n'y a pas de texte) et ajoute **après** un message
`user` « Attached image(s) from tool result: » portant `image_url` en data-URL
base64 (`pi-ai` → `dist/api/openai-completions.js`, branche `toolResult`).

⇒ La suite de messages devient **`tool` → `user`**. Une requête **sans image**
n'a **jamais** de `user` après un `tool` : c'est le **seul écart structurel**
entre « le lourd marche » et « le lourd casse dès qu'il doit voir une image ».
Les fournisseurs dont le template de chat exige un tour `assistant` entre un
résultat d'outil et un message utilisateur refusent alors **toute** la requête
(400 « invalid message order ») — le job échoue avec la cause du fournisseur.

**Correctif (posé dans `models.json`, donc à ne pas défaire)** : `compat`
porte `requiresAssistantAfterToolResult: true` (`src/llm/models.ts`,
`buildModelsConfigFrom`). Le SDK intercale alors « I have processed the tool
results. » avant le message image. Verrouillé par
`tests/integration/heavy-image-tool-result.test.ts` (fournisseur simulé
**strict** : il refuse la suite `tool` → `user`).

### 13.7 Fichiers d'une conversation et transfert vers/depuis une machine (capacité `files`)

Trois outils, portés par le **worker lourd** (c'est lui qui agit, jamais le léger
qui converse) :

| Outil | Sens | Paramètres |
| --- | --- | --- |
| `lister_fichiers` | lecture seule | aucun — métadonnées des pièces jointes (**identifiants** compris) |
| `lire_fichier` | lecture du **contenu** | `identifiant` (32 hex), `debut?` (décalage en **caractères**) |
| `recuperer_fichier` | machine → Yuki | `agent` (nom **ou** identifiant de la machine), `chemin` (**absolu** côté machine) |
| `deposer_fichier` | Yuki → machine | `agent`, `fichier` (**identifiant** du fichier stocké), `chemin_distant` (**absolu** côté machine), `ecraser?` |

#### Ce que rend `recuperer_fichier` (et ce qui reste vrai)

| Cas | Ce que le worker reçoit |
| --- | --- |
| fichier **non image** (texte, PDF, binaire) | un **résumé JSON** (statut, `file_id`, nom, taille, SHA-256, `kind`) + la note « tu ne vois pas son contenu ici ». **Aucune** image, aucun binaire dans le prompt. |
| **image** (PNG, JPEG, GIF, WebP) **et** worker déclaré avec vision | le **même résumé**, **plus** un bloc `{ type: "image", data (base64), mimeType }` — le worker **voit** l'image. `details.image_attached = true`. |
| **image** mais worker déclaré **texte seul** (`llm.heavy.vision` = « non ») | **aucune** image jointe ; le texte dit « ce modèle ne reçoit pas les images » et **où activer la vision**. `details.image_error = "model_without_vision"`. |
| **image refusée** par la politique de vision (trop petite pour rester lisible) | **aucune** image ; le code (`file_image_illegible`, `file_image_too_large`, `file_image_unsupported`) et la raison sont dans le texte. `details.image_error = <code>`. |

⚠️ **La politique de vision est la MÊME que celle des pièces jointes**
(§ 13.6) : côté max **2 000 px**, côté min lisible **700 px**, réduction
**éphémère**, **original jamais modifié**. Les octets sont lus par le **store**
(`FilesService.prepareImages` → `readBytes`), jamais par un chemin disque.

⚠️ **Ce qui reste vrai** : le worker n'a **aucun accès disque** aux fichiers de
Yuki (aucun chemin n'est exposé). Le contenu se demande donc **explicitement**,
fichier par fichier, avec `lire_fichier` (§ ci-dessus). Sans le bloc image
(modèle texte seul, refus, format non supporté), il ne voit pas l'image — et il
ne doit pas prétendre le contraire.

⚠️ **Cas silencieux corrigé** : un fichier récupéré arrive en
`application/octet-stream` avec le nom **distant** (souvent **sans extension**).
La classification reconnaît désormais l'image à sa **signature d'octets**
(PNG/JPEG/GIF/WebP, `src/files/analyze.ts`) et le stockage corrige le type MIME
(`files.mime.sniffed`) : sans cela, une capture PNG sans extension était classée
`unknown` et n'était **jamais** montrée au modèle.

#### `lire_fichier` : le contenu, selon le GENRE (worker lourd)

Il manquait le maillon « celui qui peut agir ne peut pas LIRE » : le worker
connaissait l'identifiant d'une image et n'en lisait aucun octet (un fichier du
store n'est **pas** sur un chemin que `read` atteint). `lire_fichier` le ferme.

| Genre | Ce que le worker reçoit | Bornes |
| --- | --- | --- |
| **image** | un bloc `{ type: "image", data (base64), mimeType }` — il la **voit**. `details.image_attached = true` | politique de vision **partagée** (§ 13.6) : côté max **2 000 px**, côté min lisible **700 px**, réduction **éphémère**, original **jamais** modifié |
| **image**, modèle déclaré **texte seul** | **aucune** image ; le texte dit « ce modèle ne reçoit pas les images » et **où** activer la vision. `image_error = "model_without_vision"` | — |
| **image refusée** (trop petite, trop lourde, format non transmissible) | **aucune** image ; le code (`file_image_illegible`, `file_image_too_large`, `file_image_unsupported`) et la raison sont dans le texte | — |
| **texte** | le contenu **décodé** (UTF-8, UTF-16 **LE et BE**, avec ou sans BOM), encadré comme **DONNÉE** (`<fichiers>`, échappement anti-injection), avec l'encodage et la plage rendue | **20 000 caractères** par appel (`MAX_READ_TEXT_CHARS`) et les **2 Mio** premiers octets du fichier |
| **texte plus long que le plafond** | **refus explicite** qui donne la plage exacte à demander : `lire_fichier(identifiant, debut: 20000)`. Un `debut` explicite est **servi** et borné, le reste est **annoncé** | jamais de troncature muette |
| **PDF** | refus (`file_pdf_unreadable`) : le libraire n'expose **aucune** extraction de texte | — |
| **binaire / genre inconnu** | refus (`file_content_binary`, `file_not_readable`) : **aucun** octet binaire dans un prompt | — |

⚠️ **Périmètre** : la conversation est **FORCÉE** (`lightSessionId`, comme
`lister_fichiers`) — la session du worker est éphémère et ne désigne aucun
fichier. Un identifiant d'une **autre** conversation est **refusé** avant toute
lecture (`other_session`).
⚠️ **Audit** : l'ouverture est journalisée (`files.read.opened` : identifiant,
genre, octets, mode, plage) — **jamais** le contenu, comme les transferts.
⚠️ **Le léger ne porte PAS `lire_fichier`** : il reçoit déjà le texte dans le bloc
`<fichiers>` (borné par `files.promptChars`) et les images en pièce jointe de son
message. Lui ouvrir la lecture du store n'ajouterait aucune capacité, seulement
une surface d'accès aux octets.

#### Le parcours complet, sans humain (worker lourd)

0. **générer** (léger) — `generer_image(scene)` : l'image devient un **fichier de
   la conversation** (copie dans le store des fichiers, cf. ci-dessous) et son
   identifiant est rendu dans le résultat (`file_id`) ;
1. **lister** — `lister_fichiers()` (ou le bloc automatique du premier message)
   rend les identifiants des pièces jointes de la conversation ;
2. **lire** — `lire_fichier(identifiant)` : une image est **vue**, un texte est
   rendu décodé et borné, un binaire est **refusé** (la raison est écrite) ;
3. **décider** — le worker juge sur pièce (et non sur le nom du fichier) ;
4. **déposer / récupérer** — `deposer_fichier(agent, fichier: <identifiant>,
   chemin_distant)` ou `recuperer_fichier(agent, chemin)`.

⚠️ **Une image GÉNÉRÉE est un fichier de la conversation** (chantier livré).
`generer_image` écrit l'image dans le store des images générées
(`/images/<id>.<ext>`, `src/comfy/images.ts`) **et en dépose une COPIE** dans le
store des fichiers, rattachée à la conversation (`src/files/generated.ts`, branché
dans `src/index.ts`). Cette copie a un **identifiant du store de fichiers** (32
hex), donc : **listée** par `lister_fichiers`, **lisible** par `lire_fichier`,
**déposable** par `deposer_fichier`. Le résultat de `generer_image` porte
`file_id` — inutile de lister pour le retrouver.

⚠️ **Une copie impossible n'échoue jamais la génération** : plafond
`files.maxFileBytes`, erreur d'entrée/sortie ou format non servi ⇒ l'image est
quand même générée, affichée et conservée, et le résultat porte un
**avertissement** explicite (code + raison). La copie n'est **jamais** refaite deux
fois pour la même image (lien `fileId` dans la fiche de l'image).

⚠️ **Rétention** : la copie expire avec `files.retentionDays` (même règle que les
pièces jointes, `src/files/retention.ts`), indépendamment de la fiche du store
d'images. **C'est la copie qui fait foi** pour « lister / lire / déposer » ;
l'image du store Comfy fait foi pour l'affichage dans le fil.

⚠️ **`fichier` est un IDENTIFIANT, jamais un nom.** Le stockage refuse toute
référence qui n'est pas 32 hexadécimaux (`src/files/store.ts`, `ID_RE`).
**Décision actée : identifiant STRICT** — un nom n'est **jamais** accepté, même
s'il est unique, même s'il ressemble à un chemin ; aucun repli « si le nom est
unique » n'existe ni ne sera ajouté.

Où trouver l'identifiant (**trois sources réelles**) :

1. le marqueur `[fichier] <identifiant> <nom> (n octets)` du message — écrit par
   `src/files/frame.ts` (`formatFileMarker`) et inséré par
   `src/files/service.ts` ;
2. le champ `file_id` du résultat de `recuperer_fichier` (`transferSummary`,
   `src/pi/sdk/execution-tools.ts`) ;
3. l'URL de la carte de fichier, `/fichiers/<identifiant>.<ext>`
   (`src/files/store.ts`, `fileUrl`).

Un nom produit désormais un **refus explicite qui dit quoi passer et où le
trouver** :

* nom inconnu → « « x.txt » n'est pas un identifiant… aucun fichier de cette
  conversation ne porte non plus ce nom » ;
* nom porté par **un** fichier → l'**identifiant** à utiliser est donné ;
* nom porté par **plusieurs** fichiers → « plusieurs fichiers portent ce nom —
  utilisez l'IDENTIFIANT », avec la liste (bornée) des identifiants candidats.

⚠️ Cette aide est **purement diagnostique** : le nom n'est jamais accepté, et la
recherche par nom est bornée à la **conversation** du transfert (aucune fuite
d'un fil à l'autre).

⚠️ **Écart assumé avec `envoyer_fichier`** (Yuki renvoie un fichier à
l'utilisateur, § 13) : celui-ci accepte **identifiant ou nom** parmi les fichiers
de la conversation (`FilesService.send`), parce qu'il ne fait que rendre un
fichier cliquable. Le dépôt, lui, **agit** sur une machine : il exige
l'identifiant.

#### Exemple correct, de bout en bout (récupérer puis redéposer le MÊME fichier)

1. `recuperer_fichier(agent: "nuc00", chemin: "/home/nico/temoin.txt")`
   → résultat : `{ status: "completed", direction: "get", file_id: "9f2c…e1",
   name: "temoin.txt", bytes: 131, sha256: "…" }`.
2. **Redéposer ce même fichier** : `deposer_fichier(agent: "nuc00",
   fichier: "9f2c…e1", chemin_distant: "/home/nico/retour/temoin.txt")`.
   ⚠️ `fichier` = le `file_id` de l'étape 1 (ou l'identifiant du marqueur
   `[fichier] 9f2c…e1 temoin.txt (131 octets)`), **jamais** `"temoin.txt"`.
3. ❌ **Ce qui échoue volontairement** : `deposer_fichier(agent: "nuc00",
   fichier: "temoin.txt", chemin_distant: "/home/nico/retour/temoin.txt")`
   → `status: "not_found"` et un message qui dit qu'un **identifiant** est
   attendu, où le trouver, et — si ce nom est porté par un seul fichier —
   **quel identifiant utiliser**. Rien n'est écrit sur la machine : le refus
   intervient **avant** toute trame.
4. Si la destination existe déjà : l'outil répond `conflict` sans rien écrire ;
   redemander explicitement à l'utilisateur, puis `ecraser: true`.

Garde-fous (inchangés) : chemin **relatif refusé**, agent **hors ligne** refusé
(aucune mise en file), agent **sans capacité `files`** refusé **avant toute
émission** (« ton agent est TROP ANCIEN »), plafond par transfert (au-delà :
`run_command` + `scp`/`rsync`), écriture **atomique** côté machine (`.part` +
renommage) avec empreinte SHA-256 vérifiée, et **aucun écrasement silencieux**.


## 14. Déclencheurs et pré-autorisations (tâches de fond)

Une tâche de fond née d'un **déclencheur** ne peut pas demander de validation
humaine : personne ne lit la conversation à 3 h du matin, et l'approbation expire
en **5 minutes** (`APPROVAL_TTL_MS`, `src/agents/approvals.ts`).

- **Sans pré-autorisation** : `run_command` renvoie `awaiting_validation`, la
  commande **n'est pas exécutée**, et le message dit qu'aucune approbation ne
  peut arriver. Rien n'est bloqué : le tour continue.
- **Avec pré-autorisation** (`/config` → onglet **Déclencheurs** → volet
  « Pré-autorisations ») : la commande déclarée (exacte ou préfixe) sur la
  machine déclarée s'exécute **sans validation**, **une seule fois**, jusqu'à
  l'expiration (30 jours par défaut, 90 au maximum).

Fichier d'état : `<state>/preautorisations.json`
(`YUKI_PREAUTORISATIONS_PATH`). Journal des consommations et des refus :
`<state>/declencheurs-journal.jsonl`, types `preautorisation` et `refus`.

| Ce qui arrive | Ce que ça veut dire |
| --- | --- |
| « Pré-autorisation REFUSÉE : EXPIRÉE » | recréer l'autorisation (durée) |
| « … ne correspond à AUCUN motif » | la commande n'est pas exactement celle déclarée (ou ne commence pas par le préfixe) |
| « … RÉVOQUÉE » | elle a été révoquée depuis la page de gestion |
| « … n'a aucune autorisation pour cet agent » | l'autorisation vise une AUTRE machine |
| « … DESTRUCTRICE » | la commande est classée destructrice : cocher « autoriser les commandes destructrices » |
| `awaiting_validation` sur une tâche de fond | aucune autorisation pour ce déclencheur (ou elle est déjà consommée) |

⚠️ **Aucun joker** (`*`) n'est accepté : la portée est toujours un déclencheur,
un agent et un motif. Révoquer une autorisation prend un clic, et **la commande
suivante sera refusée** (pas « en attente ») si une autorisation existe pour le
déclencheur mais ne la couvre pas.

## 15. Consolidation hebdomadaire de la mémoire (lot 29)

**Ce qui se passe tout seul** : chaque dimanche à **03:00 (Europe/Paris)**, une
passe relit la mémoire durable avec le **modèle lourd** et la nettoie (doublons
fusionnés, entrées corrigées, transitoire supprimé, contradictions signalées).
Réglages : `/config` → **Mémoire durable** → champs `memory.consolidation.*`.

**Où sont les archives** : `<state>/memory-archive/consolidation/<AAAA-MM-JJ_HHMM>/`

| Fichier | Contenu |
| --- | --- |
| `memory.jsonl` | l'état **AVANT** la passe (lisible, restaurable à l'octet) |
| `operations.json` | les opérations réellement appliquées (ou le refus) |
| `rapport.json` | la mesure : entrées, caractères, **tokens estimés**, contexte du modèle, budget, lots, % du contexte, non examinées |

**Restaurer une version** (deux chemins, même mécanisme atomique `tmp` +
`renameSync` + reconstruction de l'index FTS5) :

1. `/config` → **Personnalité** → bloc **Mémoire durable** → liste
   **« Versions de la mémoire »** → **Restaurer** (confirmation `HolafModal`),
   ou **Télécharger** pour récupérer le `memory.jsonl` ;
2. en ligne de commande, sans interface : copier le `memory.jsonl` de la version
   choisie sur `<state>/memory.jsonl`, puis redémarrer Yuki (l'index dérivé est
   reconstruit au démarrage). ⚠️ Arrêter Yuki d'abord : le fichier est la source
   de vérité.

**Diagnostic** (journaux, préfixe `memory.consolidation.*`) :

| Message | Signification |
| --- | --- |
| `memory.consolidation.debut` / `.fin` | mesure et résultat (tokens, budget, lots, %, version) |
| `memory.consolidation.saut` | retard > 24 h, verrou `enCours`, ou passe déjà en cours |
| `memory.consolidation.refus` | réponse du modèle non conforme : **aucune modification** (rapport dans la version) |
| `memory.consolidation.version.purged` | rétention atteinte : la plus ancienne version est supprimée |
| `memory.consolidation.verrou.orphelin` | verrou laissé par un processus tué : ignoré (passe autorisée) |

**Fichiers d'état** : `<state>/memory-consolidation.json` (prochain passage +
verrou), `<state>/memory-archive/consolidation/**` (versions). Surcharges :
`YUKI_MEMORY_CONSOLIDATION_DIR`, `YUKI_MEMORY_CONSOLIDATION_STATE_PATH`.

⚠️ **Rien n'est supprimé sans trace** : une suppression de souvenir laisse une
ligne `delete` dans le journal append-only, et l'état d'avant est dans la
version. Si le modèle lourd est indisponible, la passe est **refusée** (aucun
repli sur le modèle léger).
