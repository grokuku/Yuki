# Yuki — déploiement serveur autonome

Déployer le gateway Yuki sur un serveur avec GPU NVIDIA, **sans cloner le
dépôt**. Deux fichiers suffisent : `docker-compose.yml` et `.env.example`.

> Prérequis serveur : Docker + Compose v2, et le **NVIDIA Container Toolkit**
> installé (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
> doit afficher le GPU).

## Déployer

```bash
# 1) Copier les deux fichiers depuis le poste de dev (adapter user@serveur)
scp deploy/server/docker-compose.yml deploy/server/.env.example user@serveur:~/yuki/

# 2) Sur le serveur : créer le .env et renseigner les 2 clés LLM
cd ~/yuki
cp .env.example .env
vi .env        # renseigner YUKI_LLM_LIGHT_API_KEY et YUKI_LLM_HEAVY_API_KEY

# 3) Uniquement si le paquet ghcr.io est PRIVÉ : s'authentifier
#    (PAT avec le scope `read:packages`). À ignorer si le paquet est public.
docker login ghcr.io -u <utilisateur>

# 4) Démarrer (tire l'image publiée et crée les 4 volumes nommés)
docker compose up -d

# 5) Vérifier
curl -s http://127.0.0.1:8080/health | head
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health/ready   # 200 attendu
```

Aucune création de dossier ni `chown` n'est nécessaire : Docker initialise les
volumes nommés avec le propriétaire du répertoire correspondant dans l'image.

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
