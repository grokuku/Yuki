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

# 3) Config du moteur TTS : copier l'exemple, renseigner le chemin RÉEL du .gguf
cp audiocpp-server.json.example audiocpp-server.json
vi audiocpp-server.json   # clé models[].path (chemin DANS le conteneur)

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

Aucune création de dossier ni `chown` n'est nécessaire : Docker initialise les
volumes nommés avec le propriétaire du répertoire correspondant dans l'image.

## Service TTS (voix)

Le service `tts` (moteur `audio.cpp`, image CUDA) **démarre avec la stack** :
`docker compose up -d` le lance. Pour l'en exclure :

```bash
docker compose up -d gateway
```

Deux points restent **à faire à la main** avant que la voix fonctionne :

> Note : ces étapes supposent le fichier `audiocpp-server.json` **déjà** fourni
> (voir l'encadré plus bas) ; c'est le fichier de configuration du serveur, monté
> en `ro` sur `/app/server.json`.

1. **Déposer le modèle GGUF** dans le volume `yuki-server-models` (monté `ro`,
   donc le moteur ne peut pas l'installer lui-même) :

   ```bash
   docker run --rm -v yuki-server-models:/models -v "$PWD":/src alpine:3.20 \
     cp /src/<le-modele>.gguf /models/
   ```

   Le paquet GGUF provient de `https://huggingface.co/audio-cpp/audio.cpp-gguf`
   (le **nom exact** du fichier dépend de la famille/modèle — non figé ici).
   Renseigner ensuite ce nom dans `models[].path` de `audiocpp-server.json`.
2. **Activer la voix** dans l'interface : page `/config`, onglet **Voix**,
   bouton « Activer la voix » (champ `tts.enabled`, appliqué au redémarrage).

Le moteur est **non bloquant** : s'il est absent ou en erreur, la conversation
texte continue. État visible sur `GET /api/tts/status` et dans `/health`
(`subsystems.tts`).

### Fichier de configuration du moteur (`audiocpp-server.json`)

Le service `tts` monte `./audiocpp-server.json` (bind, **`ro`**) sur
`/app/server.json` et démarre par :

```yaml
command: ["server", "--config", "/app/server.json"]
```

Créer le fichier depuis l'exemple fourni :

```bash
cp audiocpp-server.json.example audiocpp-server.json
vi audiocpp-server.json   # renseigner models[].path (chemin RÉEL du .gguf)
```

Les clés de l'exemple (`host`, `port`, `backend`, `device`, `lazy_load`,
`ui_enabled`, `voice_dir`, `models[]` avec `id`/`family`/`path`/`task`/`mode`)
sont celles **attestées** par les archives `audio-cpp-*` (`docs/lot8.md` §11.2).
`id` **doit** valoir `chatterbox` (c'est le nom que Yuki envoie au moteur).

> ⚠️ **Commande corrigée d'après une EXÉCUTION RÉELLE** : l'ENTRYPOINT de
> l'image est un **dispatcher à sous-commandes** (`cli`, `server`,
> `model-manager`, `perf`) ; passer `--config` en 1er argument produit
> `Unknown command: --config`. La forme correcte est donc `server --config …`.
> Les flags `--host`/`--port` **n'existent pas** : hôte/port sont des **clés du
> fichier de config** (`host`/`port`). Preuve : logs d'exécution de l'utilisateur
> (voir `docs/lot8.md` §11.4).
>
> ⚠️ **RESTE À CONFIRMER EN RÉEL** : le chemin `/app/server.json` dans le
> conteneur (WORKDIR de l'image non attesté) et le nom exact du `.gguf`.

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
- Épingler une carte précise : remplacer `count: all` par `device_ids: ["0"]`
  sous `deploy.resources.reservations.devices`.
- Le fichier `models.json` reste **le seul** à éditer pour changer de
  fournisseur LLM (`baseUrl`, `api`, identifiant de modèle).
