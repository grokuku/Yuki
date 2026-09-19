# Publication & déploiement de l'image

Ce document décrit la **publication de l'image Docker du gateway** sur le
GitHub Container Registry (ghcr.io), le **mécanisme de version** et la manière
de **déployer depuis cette image publiée** plutôt que de reconstruire
localement.

## Workflow

`.github/workflows/release.yml` — nom affiché « **Release image** ».

Mécanisme repris **fidèlement** du projet Docky
(`/projects/Docky/.github/workflows/release.yml`), dans cet ordre exact :

1. **lire** la version dans `version.txt` (racine du dépôt) ;
2. **construire et pousser** l'image taguée `:<version>` + `:latest` ;
3. **incrémenter** `version.txt` (patch) ;
4. **committer** puis **pousser** ce bump sur la branche par défaut.

### Source de version : `version.txt`

`version.txt` (racine) est la **source unique de vérité**. Son format est
`MAJOR.MINOR.PATCH` (ex. `0.1.0`). Aucune autre source : ni saisie manuelle, ni
tag Git.

- **Règle d'incrémentation** : le **patch** est incrémenté de 1
  (`0.1.0` → `0.1.1`). Mêmes `MAJOR` et `MINOR`. C'est la règle exacte de
  Docky.
- L'image est poussée avec la version **courante** *avant* que le fichier ne
  soit incrémenté : le tag `:<version>` publié correspond donc toujours à la
  valeur qui était dans `version.txt` au début du run.
- Si `version.txt` est **absent, vide ou de format invalide**, le workflow
  **échoue immédiatement** avec un message clair (aucune image n'est poussée
  avec un tag cassé).

### Déclencheur

| Déclencheur | Détail |
| --- | --- |
| `workflow_dispatch` (manuel) | seul déclencheur |

**Aucun déclencheur `push`** (ni branche, ni tag `v*`). Comme Docky, la
publication se lance **à la main**. C'est aussi le **garde anti-boucle** : le
commit de bump poussé sur `main` par le workflow ne peut pas relancer le
workflow lui-même.

### Tags d'image

| Tag | Rôle |
| --- | --- |
| `:<version>` | release explicite (valeur lue dans `version.txt`) |
| `:latest` | dernier build publié |
| `:sha-<court>` | **immuable** (épinglage reproductible du commit) |

`:latest` et `:<version>` proviennent du **même numéro** (celui de
`version.txt`).

> ⚠️ La règle du projet « pas de tag `latest` » concerne les **images de base**
> (Node, CUDA) du Dockerfile/compose, épinglées par digest pour éviter la
> dérive. Publier `:latest` pour l'**image du projet** est volontaire et
> légitime ; le tag `:sha-<court>` permet d'épingler un artefact exact.

### Plateformes

`linux/amd64` **uniquement**. L'image Node est techniquement multi-arch, mais
l'usage réel (GPU/NVIDIA) est amd64, et les images CUDA des lots 6/7 seront
amd64-only. Aucun émulateur QEMU n'est donc nécessaire (seul écart conservé
avec Docky, qui publie en `linux/amd64,linux/arm64`).

### Permissions & dépendance à la qualité

```yaml
permissions:        # au niveau du job `publish`
  contents: write   # commit + push du bump de `version.txt`
  packages: write   # push de l'image sur ghcr.io
```

`contents: write` est **nouveau et requis** : le job `publish` committe et
pousse le bump de `version.txt` (le job `quality`, lui, reste en
`contents: read`). Sans cette permission, `git push` échoue.

Le job `publish` a un `needs: quality` : la publication ne part que si
**typecheck + tests + build** passent.

### Écriture dans le dépôt

Le bump est committé avec l'identité du bot GitHub Actions (comme Docky) :

```bash
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git commit -m "chore: bump version to <version>"
git push
```

Le message ne contient **pas** `[skip ci]` (Docky ne l'utilise pas).

## Consommer / déployer l'image publiée

Le `docker-compose.yml` de base **tire** l'image publiée : `docker compose up -d`
suffit, sans construire ni surcharge.

```bash
# 1) Si le paquet est privé : se connecter à ghcr.io (PAT avec read:packages).
docker login ghcr.io -u <utilisateur>

# 2) Tirer puis démarrer l'image publiée.
docker compose pull
docker compose up -d
```

Le tag par défaut est `:latest` (`ghcr.io/grokuku/yuki:${YUKI_VERSION:-latest}`).
Pour épingler une révision précise, définir `YUKI_VERSION=sha-<court>` (ou la
version publiée) dans `.env`.

> Pour **construire en local** au lieu de tirer : `compose.build.example.yml`.
> Pour **revenir à des bind mounts** : `compose.bind.example.yml`.

> Le nom d'image est **dérivé du dépôt** : `github.com/grokuku/Yuki` →
> `ghcr.io/grokuku/yuki`. Les références ghcr sont **en minuscules**.

## Paramètres côté dépôt GitHub

- `Settings → Actions → General → Workflow permissions` : autoriser
  l'écriture, ou s'assurer que `contents: write` + `packages: write` sont
  accordés au `GITHUB_TOKEN` (sinon le `push` de l'image échoue avec
  `denied: permission_denied`, et le `git push` du bump est rejeté).
- ⚠️ **Protection de branche** : si `main` est protégée (review obligatoire ou
  interdiction de push direct), le `git push` du workflow sera **rejeté** et la
  release échouera **après** avoir poussé l'image. Parade : autoriser les pushes
  de GitHub Actions sur `main` (ou du rôle bot), ou faire committer le bump sur
  une branche de bot ouverte en PR.
- Le paquet apparaît dans `Settings → Packages` ; sa visibilité (privée/publique)
  se règle là.
