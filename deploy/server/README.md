# Yuki — déploiement serveur autonome

Déployer le gateway Yuki sur un serveur avec GPU NVIDIA, **sans cloner le
dépôt**. Trois fichiers suffisent : `docker-compose.yml`, `.env.example` et
`audiocpp-server.json.example` (config du moteur TTS).

> Prérequis serveur : Docker + Compose v2, et le **NVIDIA Container Toolkit**
> installé (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
> doit afficher le GPU).

## Déployer

```bash
# 1) Copier les trois fichiers depuis le poste de dev (adapter user@serveur)
scp deploy/server/docker-compose.yml deploy/server/.env.example \
    deploy/server/audiocpp-server.json.example user@serveur:~/yuki/

# 2) Sur le serveur : créer le .env et renseigner les 2 clés LLM
cd ~/yuki
cp .env.example .env
vi .env        # renseigner YUKI_LLM_LIGHT_API_KEY et YUKI_LLM_HEAVY_API_KEY

# 3) Config du moteur TTS : créer le dossier monté et y placer server.json
mkdir -p tts-config
cp audiocpp-server.json.example tts-config/server.json
vi tts-config/server.json   # clé models[].path (chemin vu par le MOTEUR : /models/…)

# 4) Uniquement si le paquet ghcr.io est PRIVÉ : s'authentifier
#    (PAT avec le scope `read:packages`). À ignorer si le paquet est public.
docker login ghcr.io -u <utilisateur>

# 5) Démarrer (tire l'image publiée et crée les 5 volumes nommés ; démarre
#    aussi le service `tts`)
docker compose up -d

# 6) Vérifier
curl -s http://127.0.0.1:8080/health | head
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health/ready   # 200 attendu
```

Aucune création de dossier ni `chown` n'est nécessaire **pour les volumes
nommés** : Docker les initialise avec le propriétaire du répertoire
correspondant dans l'image. ⚠️ **Exception : le dossier `tts-config` est un bind
mount** (M2/M3 du Lot 9) : créez-le vous-même et donnez-le à `1000:1000` :

```bash
mkdir -p ~/yuki/tts-config
chown -R 1000:1000 ~/yuki/tts-config
```

Le gateway y **écrit** `server.json` (et sa sauvegarde `server.json.bak`) ; le
moteur `tts` y **lit** `/config/server.json`. Les deux conteneurs tournent en
`1000:1000`.

### Montage M1 — dossier des modèles (écriture côté gateway)

Le gateway monte le volume des modèles en **`rw`** sur `/models` : il peut y
**écrire** les futurs téléchargements depuis l'interface. Le moteur `tts` monte
le **même** volume en **`ro`** : il ne fait que **lire** les GGUF.

Les modèles téléchargés sont rangés par convention dans le sous-dossier
`downloads/` (`/models/downloads/<engineId>/`). Ce n'est **pas** une barrière de
sécurité : le gateway a un accès en écriture à **tout** `/models`. Choix assumé
(composant de confiance, sur votre machine, modèles de ~2 Go).

- **Volume nommé `yuki-server-models`** (ce compose) : aucune préparation hôte.
  Le Dockerfile crée et `chown` déjà `/models` (et `/models/downloads`) ; le
  volume est initialisé en `1000:1000`.
- **Bind mount des modèles** (déploiement alternatif) : créez le dossier et
donnez-le au conteneur :

  ```bash
  mkdir -p ~/yuki/models/downloads
  chown -R 1000:1000 ~/yuki/models
  ```

## Service TTS (voix)

Le service `tts` (moteur `audio.cpp`, image CUDA) **démarre avec la stack** :
`docker compose up -d` le lance. Pour l'en exclure :

```bash
docker compose up -d gateway
```

Trois points restent **à faire à la main** avant que la voix fonctionne :

> Note : ces étapes supposent `tts-config/server.json` **déjà** fourni (voir
> l'encadré plus bas) ; c'est le dossier de configuration du serveur, monté en
> `ro` sur `/config` côté moteur et en `rw` sur `/data/tts-config` côté gateway.

1. **Déposer le modèle GGUF** dans le volume `yuki-server-models` (monté `ro`
   **côté moteur**, donc il ne peut pas s'installer lui-même) :

   ```bash
   docker run --rm -v yuki-server-models:/models -v "$PWD":/src alpine:3.20 \
     cp /src/<le-modele>.gguf /models/
   ```

   Le paquet GGUF provient de `https://huggingface.co/audio-cpp/audio.cpp-gguf`
   (le **nom exact** du fichier dépend de la famille/modèle — non figé ici).
   Renseigner ensuite ce nom dans `models[].path` de `audiocpp-server.json`.
2. **Activer la voix** dans l'interface : page `/config`, onglet **Voix**,
   bouton « Activer la voix » (champ `tts.enabled`, appliqué au redémarrage).
3. **Créer une voix** (upload d'un WAV de référence) : Chatterbox est un modèle
   de **clonage** (`task: "clon"`), il **exige une référence audio** à chaque
   requête. Registre vide ⇒ Yuki n'envoie pas de `voice_ref` et le moteur
   répond `Chatterbox prepare requires speaker reference audio` (500). Voir
   `docs/lot8.md` §11.11.

Le moteur est **non bloquant** : s'il est absent ou en erreur, la conversation
texte continue. État visible sur `GET /api/tts/status` et dans `/health`
(`subsystems.tts`).

### Fichier de configuration du moteur (`tts-config/server.json`)

Le service `tts` monte le dossier `./tts-config` (bind, **`ro`**) sur `/config`
et démarre par :

```yaml
command: ["server", "--config", "/config/server.json"]
```

Le gateway monte **le même dossier** en `rw` sur `/data/tts-config` : c'est ce
qui permet à la page `/config` (onglet **Voix**) de modifier `server.json` de
façon **structurée** — listes fermées pour `task`/`mode`/`family`/`id`/`path`,
jamais de JSON brut envoyé par le navigateur. Chaque enregistrement écrit
`server.json.bak` puis `server.json` **atomiquement**. Le moteur ne relit le
fichier qu'à son **redémarrage** :

```bash
docker compose restart tts        # relit server.json (le conteneur reste en place)
```

Créer le fichier depuis l'exemple fourni :

```bash
mkdir -p tts-config
cp audiocpp-server.json.example tts-config/server.json
vi tts-config/server.json   # renseigner models[].path (chemin vu par le moteur : /models/…)
```

Les clés de l'exemple (`host`, `port`, `backend`, `device`, `lazy_load`,
`ui_enabled`, `voice_dir`, `models[]` avec `id`/`family`/`path`/`task`/`mode`)
sont celles **attestées** par les archives `audio-cpp-*` (`docs/lot8.md` §11.2).
`id` **doit** valoir `chatterbox` (c'est le nom que Yuki envoie au moteur).
`task` **doit** valoir **`clon`** (clonage de voix) : la famille `chatterbox` du
runtime n'accepte **que** `clon` et `vc` — `tts` déclenche
`Chatterbox supports VoiceCloning and VoiceConversion` (preuve :
`src/models/chatterbox/loader.cpp:131-133`, runtime audio.cpp). `mode` reste
`offline` (seul mode supporté par Chatterbox). Voir `docs/lot8.md` §11.11.

> ⚠️ **Commande corrigée d'après une EXÉCUTION RÉELLE** : l'ENTRYPOINT de
> l'image est un **dispatcher à sous-commandes** (`cli`, `server`,
> `model-manager`, `perf`) ; passer `--config` en 1er argument produit
> `Unknown command: --config`. La forme correcte est donc `server --config …`.
> Les flags `--host`/`--port` **n'existent pas** : hôte/port sont des **clés du
> fichier de config** (`host`/`port`). Preuve : logs d'exécution de l'utilisateur
> (voir `docs/lot8.md` §11.4).
>
> ⚠️ Le chemin `/config/server.json` est un choix **Yuki** (le WORKDIR de
> l'image n'est pas attesté) : il est cohérent entre le compose, le gateway et
> l'interface. Le nom exact du `.gguf` reste, lui, à confirmer.

### Variables obligatoires et dégradation

Seules les **deux clés LLM** sont nécessaires à l'usage normal. Leur absence ne
fait **pas** échouer le démarrage (mode `degrade`) :

| Clé absente | Conséquence |
| --- | --- |
| `YUKI_LLM_LIGHT_API_KEY` | `/health/ready` → **503**, `send` → `LLM_UNAVAILABLE` (conversation indisponible) |
| `YUKI_LLM_HEAVY_API_KEY` | démarre normalement, **délégation désactivée** (conversation fonctionnelle) |

## Opérations courantes

```bash
# Logs (JSON-lines sur stdout)
docker compose logs -f --tail=100 gateway

# État (rapport GPU, sous-systèmes, volumes)
curl -s http://127.0.0.1:8080/health | jq '.subsystems, .volumes'
curl -s http://127.0.0.1:8080/version

# Mettre à jour vers une nouvelle version : éditer YUKI_VERSION dans .env,
# puis :
docker compose pull && docker compose up -d

# Sauvegarder un volume (exemple : l'état) dans le répertoire courant
docker run --rm -v yuki-server-state:/data -v "$PWD":/backup alpine:3.20 \
  tar czf /backup/yuki-server-state.tgz -C /data .

# Restaurer un volume (par-dessus le contenu existant)
docker run --rm -v yuki-server-state:/data -v "$PWD":/backup alpine:3.20 \
  tar xzf /backup/yuki-server-state.tgz -C /data

# Lister / inspecter / supprimer un volume
docker volume ls | grep yuki-server
docker volume inspect yuki-server-state
docker volume rm yuki-server-state

# Éditer models.json : il vit sur le volume `yuki-server-pi` (pas dans l'image).
# Le seed initial (config/pi/models.json de l'image) n'est copié qu'à la 1re init.
docker cp yuki-server-gateway:/data/pi/agent/models.json ./models.json
vi ./models.json
docker cp ./models.json yuki-server-gateway:/data/pi/agent/models.json
docker compose restart gateway
```

## Tags d'image : lequel existe vraiment ?

| Tag | Publié par | Existe si… |
| --- | --- | --- |
| `test` | workflow de CI (`test-build.yml`), à chaque push sur `main` | toujours après une CI passée |
| `sha-<court>` | workflow de CI | immuable, par commit |
| `latest` | workflow de **release** (`release.yml`, **manuel**) | **seulement** si une release a été lancée au moins une fois |
| `<version>` (ex. `0.1.0`) | workflow de release | idem |

Donc : s'il n'y a jamais eu de release, `:latest` **n'existe pas** → utiliser
`YUKI_VERSION=test` (ou `sha-<court>`) dans `.env`.

## ⚠️ Piège `YUKI_UID` / `YUKI_GID`

L'image publiée est construite avec **uid/gid 1000** (voir `ARG YUKI_UID` dans
le Dockerfile), et c'est ce propriétaire qui est recopié dans les volumes
nommés au premier démarrage. **Changer `YUKI_UID`/`YUKI_GID` dans `.env` sans
reconstruire l'image** ferait tourner le conteneur avec un uid différent de
celui de ses volumes → `permission denied`, `/health/ready` → **503**. Pour ce
déploiement (image tirée), laisser **1000:1000**.

## Éditer le compose ?

- Changer le port publié : `YUKI_GATEWAY_PORT` dans `.env`.
- Les **chemins internes** (`/models`, `/data/tts-config`, `/config`, `/voices`,
  `/data/pi`, `/workspace`, `/data/state`) sont des **défauts du code**
  (`src/config/container-paths.ts`) : **inutile** de les définir dans `.env` ou
  dans le compose. Seuls les `volumes:` (`source:` / `target:`) sont explicites.
- Épingler une carte précise : remplacer `count: all` par `device_ids: ["0"]`
  sous `deploy.resources.reservations.devices`.
- Le fichier `models.json` reste **le seul** à éditer pour changer de
  fournisseur LLM (`baseUrl`, `api`, identifiant de modèle).
