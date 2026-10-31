# Publication & déploiement (image **et** agents)

Ce document décrit la **publication**, en **une seule action GitHub** : l'**image
Docker du gateway** sur le GitHub Container Registry (ghcr.io) **et** les
**binaires de l'agent d'exécution** attachés à une **GitHub Release** — plus le
mécanisme de **version** (un seul numéro) et la manière de **déployer** ces
artefacts.

## Ce que produit une publication (`release.yml`)

`.github/workflows/release.yml` — nom affiché « **Release image et agents** ».
Déclenchement **manuel uniquement** (`workflow_dispatch`).

| # | Job | Produit |
| --- | --- | --- |
| 1 | `quality` | typecheck + `npm test` + build (garde-fou, aucun artefact) |
| 2 | `publish` | bump de `version.txt`, image ghcr `:<version>` + `:latest` + `:sha-<court>`, commit + push du bump |
| 3 | `agent-build` | 4 binaires statiques de l'agent (workflow réutilisable `agent-build.yml`) |
| 4 | `release` | GitHub Release **`v<version>`** sur le commit de bump |

⚠️ **Chaîne `needs:` stricte, sans `continue-on-error`** : `publish` dépend de
`quality`, `agent-build` de `publish`, `release` de **`publish` ET `agent-build`**.
Une release ne peut donc **jamais** exister si l'image ou un binaire a échoué.

### Assets de la release `v<version>`

| Asset | Contenu |
| --- | --- |
| `yuki-agent-linux-amd64-musl` | ELF statique x86-64 (glibc **et** musl/OpenWrt) |
| `yuki-agent-linux-arm64-musl` | ELF statique aarch64 (glibc **et** musl/OpenWrt) |
| `yuki-agent-windows-amd64.exe` | binaire Windows amd64 |
| `yuki-agent-windows-arm64.exe` | binaire Windows arm64 |
| `SHA256SUMS` | empreintes des 4 binaires (recalculées sur l'ensemble) |
| `docker-compose.yml` | copie de `deploy/minimal/docker-compose.yml` |

⚠️ **Noms de binaires INCHANGÉS** (contrat des utilisateurs et de la doc).
⚠️ **Aucun écrasement d'asset** (pas d'option de clobber) : un asset ou un tag
déjà présent fait **échouer** la release avec un message explicite — jamais
remplacé en silence.

### Anciennes releases `agent-v<version>`

Avant l'unification, l'agent avait **son** numéro (`VERSION` sous `agent/`, ex. `0.2.0`)
et ses propres releases `agent-v<version>`. Ces releases **restent en place**
(historique), mais ne sont **plus produites** : le tag publié est désormais
`v<version>`, **le même numéro que l'image**. Les commandes de ce document et du
runbook ne pointent donc plus que vers `v<version>`.

## Workflow `release.yml` : mécanisme

Mécanisme d'image repris **de Docky**
(`/projects/Docky/.github/workflows/release.yml`), dans cet ordre exact :

1. **lire** la version dans `version.txt` (racine du dépôt) et vérifier que le tag
   `v<version publiée>` n'existe pas déjà ;
2. **incrémenter** `version.txt` (patch) — **avant** le build ;
3. **construire et pousser** l'image taguée `:<version>` + `:latest` ;
4. **committer** puis **pousser** ce bump sur la branche par défaut ;
5. `agent-build` puis `release` (assets ci-dessus) sur le **commit de bump**.

⚠️ **Écart voulu avec Docky** : le bump est écrit **avant** le build, pour que
l'image, le tag de release **et** les binaires de l'agent portent **le même
numéro dans le même run**. Le commit du bump n'est poussé qu'**après** le push
réussi de l'image : si le build échoue, `version.txt` reste intact sur le remote.

### Source de version : `version.txt` (unique)

`version.txt` (racine) est la **source unique de vérité**, pour l'image **et**
pour l'agent. Son format est `MAJOR.MINOR.PATCH` (ex. `0.1.0`). Aucune autre
source : ni `VERSION` sous `agent/` (fichier supprimé), ni saisie manuelle, ni tag Git.

- **Règle d'incrémentation** : le **patch** est incrémenté de 1
  (`0.1.0` → `0.1.1`). Mêmes `MAJOR` et `MINOR`. C'est la règle exacte de
  Docky.
- La version **publiée** est celle du fichier **après** incrément : c'est elle qui
  tague l'image, la release et les binaires (`yuki-agent version`).
- Si `version.txt` est **absent, vide ou de format invalide**, le workflow
  **échoue immédiatement** (aucune image poussée avec un tag cassé).
- ⚠️ Si le tag `v<version publiée>` **existe déjà**, le workflow **échoue avant
toute publication** avec le message « incrémentez `version.txt` » : jamais de
release par-dessus une autre.
- ⚠️ `package.json` porte la version du **paquet npm** (métadonnée interne) : ce
n'est PAS une source de version publiée. Seul `version.txt` compte.

### Déclencheur

| Déclencheur | Détail |
| --- | --- |
| `workflow_dispatch` (manuel) | seul déclencheur |

**Aucun déclencheur `push`** (ni branche, ni tag `v*`). Comme Docky, la
publication se lance **à la main**. C'est aussi le **garde anti-boucle** : le
commit de bump poussé sur `main` par le workflow ne peut pas relancer le
workflow lui-même (sinon : une release par push).

### Tags d'image

| Tag | Rôle |
| --- | --- |
| `:<version>` | release explicite (valeur publiée de `version.txt`) |
| `:latest` | dernier build publié |
| `:sha-<court>` | **immuable** (épinglage reproductible du commit) |

`:latest` et `:<version>` proviennent du **même numéro** (celui de
`version.txt`).

> ⚠️ La règle du projet « pas de tag `latest` » concerne les **images de base**
> (Node, CUDA) du Dockerfile/compose, épinglées par digest pour éviter la
> dérive. Publier `:latest` pour l'**image du projet** est volontaire et
> légitime ; le tag `:sha-<court>` permet d'épingler un artefact exact.

### Plateformes

`linux/amd64` **uniquement** pour l'image (l'usage réel — GPU/NVIDIA — est amd64,
et les images CUDA des lots 6/7 seront amd64-only ; aucun QEMU nécessaire).
Les binaires de l'agent, eux, couvrent linux amd64/arm64 et windows amd64/arm64.

### Permissions (minimales, par job)

```yaml
publish:            # bump + image
  contents: write   # commit + push du bump de `version.txt`
  packages: write   # push de l'image sur ghcr.io
release:            # GitHub Release
  contents: write   # création de la release + du tag `v<version>`
```

`contents: write` n'est accordé qu'aux **deux** jobs qui en ont besoin :
`publish` (commit + push du bump) et `release` (création de la release).
`packages: write` reste **uniquement** sur `publish` ; `quality` et `agent-build`
restent en `contents: read`. Sans `contents: write`, `git push` échoue ; sans
`packages: write`, le push de l'image échoue.

Chaîne de dépendances : `publish` a un `needs: quality` (typecheck + tests +
build), `agent-build` un `needs: publish`, et `release` un
`needs: [publish, agent-build]`.

### Écriture dans le dépôt

Le bump est committé avec l'identité du bot GitHub Actions (comme Docky) :

```bash
# exécuté APRÈS le push réussi de l'image
git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git commit -m "chore: bump version to <version>"
git push
```

Le message ne contient **pas** `[skip ci]` (Docky ne l'utilise pas).

### Récupérer les binaires de l'agent

```bash
# Dernière release : tag v<version> (= numéro de l'image)
gh release download v0.1.0 \
  --pattern 'yuki-agent-linux-amd64-musl' --pattern SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
chmod +x yuki-agent-linux-amd64-musl
./yuki-agent-linux-amd64-musl version      # → « yuki-agent 0.1.0 »

# Tout (4 binaires + empreintes + compose minimal)
gh release download v0.1.0
```

Sans `gh`, les mêmes fichiers sont à
`https://github.com/grokuku/Yuki/releases/download/v0.1.0/<nom>`.
⚠️ `agent/deploy/install.sh` **ne télécharge pas** : il installe un binaire déjà
présent (`--binary <chemin>`). Les détails de mise à jour d'un agent sont dans
`docs/runbook.md` §12.4.

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
