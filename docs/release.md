# Publication & déploiement de l'image

Ce document décrit la **publication de l'image Docker du gateway** sur le
GitHub Container Registry (ghcr.io) et la manière de **déployer depuis cette
image publiée** plutôt que de reconstruire localement.

## Workflow

`.github/workflows/release.yml` — nom affiché « **Release image** ».

Principe repris du projet Docky (`.github/workflows/release.yml`,
`test-build.yml`) : `checkout` → `setup-buildx` → `docker login ghcr.io`
(`secrets.GITHUB_TOKEN`) → `docker/build-push-action` avec `push: true` et le
tag `:latest`.

### Déclencheurs

| Déclencheur | Version utilisée |
| --- | --- |
| `workflow_dispatch` (manuel) | entrée `version` **optionnelle** |
| `push` d'un tag `v*` (ex. `v0.2.0`) | dérivée du tag (`v` retiré → `0.2.0`) |

Aucune exécution sur `pull_request`.

### Tags d'image

| Tag | Quand | Rôle |
| --- | --- | --- |
| `:latest` | toujours | dernier build publié |
| `:sha-<court>` | toujours | **immuable** (épinglage reproductible) |
| `:<version>` | si version fournie (saisie ou tag `v*`) | release explicite |

> ⚠️ La règle du projet « pas de tag `latest` » concerne les **images de base**
> (Node, CUDA) du Dockerfile/compose, épinglées par digest pour éviter la
> dérive. Publier `:latest` pour l'**image du projet** est volontaire et
> légitime ; le tag `sha-<court>` permet d'épingler un artefact exact.

### Plateformes

`linux/amd64` **uniquement**. L'image Node est techniquement multi-arch, mais
l'usage réel (GPU/NVIDIA) est amd64, et les images CUDA des lots 6/7 seront
amd64-only. Aucun émulateur QEMU n'est donc nécessaire.

### Permissions & dépendance à la qualité

```yaml
permissions:
  contents: read   # le workflow n'ÉCRIT JAMAIS dans le dépôt
  packages: write  # push sur ghcr.io
```

Le job `publish` a un `needs: quality` : la publication ne part que si
**typecheck + tests + build** passent. Le job `quality` est défini **dans ce
workflow** (il duplique le job homonyme de `ci.yml`) afin de ne pas modifier
`ci.yml`. À basculer en workflow réutilisable (`uses:`) si `ci.yml` gagne un
jour `on: workflow_call`.

## Écart assumé vs. Docky : pas d'écriture dans le dépôt

Docky, à la fin de `release.yml`, incrémente `version.txt` puis exécute
`git commit` + `git push`. **Yuki ne le fait pas** :

- l'utilisateur gère ses commits lui-même (préférence permanente) ;
- un workflow qui pousse sur la branche par défaut **se redéclencherait
  lui-même** (boucle) ;
- la version vient donc d'un **tag Git `v*`** ou d'une **saisie manuelle**, et
  le workflow reste en `contents: read` (aucune écriture).

## Consommer / déployer l'image publiée

Le `docker-compose.yml` de base **construit** l'image localement (`build:`) et
la nomme `yuki-gateway:${YUKI_VERSION}`. Pour déployer **depuis ghcr.io**, on
utilise la surcharge fournie en exemple, `compose.ghcr.example.yml`, qui retire
le `build:` (`!reset`) et pointe sur l'image publiée — sans modifier le compose
de base.

```bash
# 1) Si le paquet est privé : se connecter à ghcr.io (PAT avec read:packages).
docker login ghcr.io -u <utilisateur>

# 2) Tirer puis démarrer l'image publiée.
docker compose -f docker-compose.yml -f compose.ghcr.example.yml pull
docker compose -f docker-compose.yml -f compose.ghcr.example.yml up -d
```

Pour épingler une révision précise, remplacer `:latest` par `:sha-<court>` ou
`:<version>` dans `compose.ghcr.example.yml`.

> Le nom d'image est **dérivé du dépôt** : `github.com/grokuku/Yuki` →
> `ghcr.io/grokuku/yuki`. Les références ghcr sont **en minuscules**.

## Paramètres côté dépôt GitHub

- `Settings → Actions → General → Workflow permissions` : autoriser
  l'écriture, ou s'assurer que `packages: write` est accordé au `GITHUB_TOKEN`
  (sinon le `push` échoue avec `denied: permission_denied`).
- Le paquet apparaît dans `Settings → Packages` ; sa visibilité (privée/publique)
  se règle là.
