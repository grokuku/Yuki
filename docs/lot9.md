# Lot 9 — Configuration structurée du moteur TTS + montages `rw`

> **Spécification du Lot 9 — étapes 1 ET 2.** L'**étape 1** permet d'**éditer la
> configuration du moteur `audio.cpp` (`server.json`) depuis l'interface Yuki**,
> sans terminal et **sans jamais envoyer de JSON brut** au navigateur. L'**étape 2**
> (§16) ajoute le **téléchargement des modèles depuis l'interface** — **backend
> seul** (catalogue fermé, job durable, routes) ; l'UI viendra dans un lot séparé
> (refonte de `/config`). Ce document **complète**
> [`docs/lot7.md`](lot7.md) (spécification de référence du TTS) et
> [`docs/lot8.md`](lot8.md) (assistant de mise en route). Il **ne refait pas**
> les lots précédents.
>
> **Date.** 2026-09-22 (étape 1) ; **2026-09-23** (étape 2, backend) ;
> **2026-09-23** (refonte UX de l'onglet Voix de `/config`, §17).
>
> **Style.** Sections numérotées ; tableaux de décisions **« Acté »** (`D##`) et
> **« À confirmer »** (`C##`) ; chaque affirmation est adossée à une preuve
> `fichier:ligne` ou explicitement marquée **non attestée**. La numérotation
> **poursuit** celle des lots précédents : décisions **D46 → D76**, points
> ouverts **C30 → C48** (dernier `D45` : `docs/lot8.md:645` ; dernier `C29` :
> `docs/lot8.md:662`). ⚠️ Un travail intermédiaire (montage **imbriqué** du
> sous-dossier, via l'option Compose de **sous-chemin de volume**) a créé puis
> **retiré** les identifiants **D59** et **C37** : ils ne sont **PAS
> réattribués** ; la forme simple de M1 est actée en **D60** (§13), et la
> **simplification des variables de chemin** en **D61** (§3.1).

## Contexte

Le **Lot 7** a livré le TTS fonctionnel (Chatterbox Multilingual V3, voix clonée,
Web Audio). Le **Lot 8** a rendu le moteur **diagnosticable** depuis `/config`
(`GET /api/tts/status`, `GET /api/tts/models`, `POST /api/tts/test`) et a ajouté
l'**assistant**. Restait un trou : **régler `server.json` demandait un terminal**
et un aller-retour sur l'hôte (copier un fichier, l'éditer, redémarrer).

Le Lot 9, étape 1 **ferme ce trou** en exposant `server.json` sous forme d'un
**patch structuré** (listes fermées), écrit **atomiquement** dans un **dossier**
monté `rw`. Le **téléchargement des modèles depuis l'interface N'EST PAS dans ce
lot** (c'est l'étape 2) — mais les **montages `M1`** et les chemins sont déjà
conçus pour s'y brancher (`/models/downloads/`).

**Décisions produit intégrées** : le TTS doit rester testable/réglable **sans
terminal** ; toute action impossible depuis l'UI est **documentée honnêtement** ;
le **socket Docker reste refusé**.

---

## 1. Objet et périmètre

### Ce que fait le Lot 9, étape 1

1. **Montages** (M1/M2/M3, §3) : le gateway reçoit le dossier des modèles en
   **`rw`** (`/models`, lecture + écriture future des téléchargements, rangés
   par convention dans `downloads/`) et le dossier de config du moteur
   (`/data/tts-config`) ; le moteur garde son dossier des modèles en **`ro`**
   (`/models`) et son dossier de config en **`ro`** (`/config`), commande
   **inchangée** (`server --config /config/server.json`).
2. **Routes structurées** (§4) : `GET`/`PUT /api/tts/engine-config`, `POST
   /api/tts/engine-config/revert`, `GET /api/tts/capabilities`.
3. **Listes fermées** (§5) qui **empêchent les erreurs connues** : `task`
   canonique (`clon`, jamais `clone`), `mode` `offline|streaming` avec `offline`
   **imposé** à `chatterbox`/`cosyvoice3`, `family` et `id` fermés, `path` choisi
   parmi les `.gguf` présents.
4. **Préservation fidèle** des clés inconnues, **écriture atomique**,
   **`server.json.bak`** + **restauration** (§6).
5. **Rétro-compatibilité** stricte (§7) : sans montage, l'UI dit **« non
   monté »** (message honnête) et **rien ne casse**.
6. **Sonde de capacités** sans effet de bord (§8) : la fonction de déchargement
   à chaud n'est montrée que si la route **est confirmée présente**.
7. **UI** (§9) : vanilla sans build, CSP stricte (aucun style inline), thème
   `5 familles × 2 modes`, réutilisation de l'existant.

### Hors périmètre (étape 1)

- **Télécharger** un modèle depuis l'interface (livré à l'**étape 2**, §16 — backend seul, **UI hors périmètre**).
- **Démarrer/redémarrer** un conteneur depuis l'UI (socket Docker **refusé**).
- **Pré-déclarer** automatiquement des entrées `models[]` (§10, C32).
- Vérifier en réel le **timbre/la langue** produits (non vérifiable ici).

---

## 2. Constat factuel de départ (preuves)

| Fait | Preuve |
| --- | --- |
| Le moteur lit **un fichier** `server.json` **à son démarrage** | `command: ["server", "--config", "/config/server.json"]` (`docker-compose.yml:198`) |
| Un `rename` est **impossible** sur un fichier **bind-monté** ⇒ il faut monter un **dossier** | `docs/lot7.md` (approvisionnement) ; conception M2 §3 |
| Le gateway **n'a aucun accès Docker** (pas de socket) | `docker-compose.yml` (aucun `/var/run/docker.sock`), `docs/lot8.md` §2.1 |
| Le gateway tourne **non-root** (uid/gid `1000`) | `docker-compose.yml:83` (`user: "${YUKI_UID:-1000}:${YUKI_GID:-1000}"`), `infra/gateway/Dockerfile:49-50` |
| Le vocabulaire de tâche canonique est **`clon`** (jamais `clone`) | `src/tts/engine-config.ts:73-88`, `docs/lot8.md` §11.11 (`parse_voice_task_kind`) |
| `chatterbox`/`cosyvoice3` n'acceptent que **`offline`** | `src/tts/engine-config.ts:116`, `docs/lot8.md` §13.3 |
| Les 5 moteurs connus de Yuki | `src/tts/engine-config.ts:107-113` |

---

## 3. Montages M1 / M2 / M3

Trois montages, **un seul invariant à ne jamais violer** : **aucun montage du
moteur n'est `rw`** (le moteur ne fait que **lire** son environnement).

| # | Service | Hôte / volume | Cible conteneur | Mode | Rôle |
| --- | --- | --- | --- | --- | --- |
| **M1** | `gateway` | dossier/volume modèles | `/models` | **`rw`** | lecture + écriture **future** des téléchargements (`/models/downloads/`) |
| **M2** | `gateway` | dossier de config du moteur | `/data/tts-config` | **`rw`** | écriture **atomique** de `server.json` |
| **M3** | `tts` | **même** dossier de config | `/config` | **`ro`** | lecture par le moteur à son démarrage |
| — | `tts` | dossier/volume modèles | `/models` | **`ro`** | lecture des GGUF (invariant **conservé**) |

**Preuves.** Compose de base (volumes nommés) : `docker-compose.yml:106-107`
(M1), `:113-114` (M2), `:208-210` (M3, `read_only: true`), `:213-215` (modèles du
moteur, `ro`), `:260-261` (volume `yuki-tts-config`). Surcharge bind :
`compose.bind.example.yml:48-49` (M1), `:52-53` (M2), `:68-70` (M3),
`:72-74` (modèles du moteur, `ro`). Variante serveur autonome :
`deploy/server/docker-compose.yml:107-108` (M1), `:113-114` (M2), `:208-210`
(M3), `:212-214` (modèles du moteur, `ro`).

**Justifications.**

- **M1** — le dossier des modèles est monté **une seule fois**, en **`rw`**, sur
  `/models` côté gateway : le gateway peut **lire** (diagnostic) **et écrire** les
  futurs téléchargements (`src/tts/engine-config.ts:63` `MODELS_DOWNLOADS_SUBDIR`,
  joint à `/models` → `<models>/downloads`). ⚠️ **Honnêteté** : ce choix donne au
  gateway un accès en **écriture à TOUT `/models`** ; le sous-dossier `downloads/`
  n'est qu'une **CONVENTION d'organisation**, **PAS** une barrière de sécurité.
  C'est un choix **assumé** par l'opérateur (composant de confiance, sur sa
  propre machine, modèles de ~2 Go) — voir **D60**. Le montage du **moteur** reste
  `ro`.
- **M2** — on monte un **dossier**, pas un fichier : l'écriture atomique
  (`tmp` + `rename`, `src/tts/engine-config.ts:265-270`) est **impossible** sur un
  fichier bind-monté. C'est la raison d'être de M2.
- **M3** — le moteur monte le **même dossier hôte** en `ro` sur `/config` ; la
  commande reste `server --config /config/server.json`. **Aucun** montage `rw`
  n'est ajouté au moteur.

**Préparation hôte (bind).** Les dossiers manquants sont créés par Docker en
`root:root` ; le conteneur (uid 1000) ne pourrait pas écrire. Sur l'hôte :

```bash
mkdir -p .local/tts-config .local/models/downloads
chown -R 1000:1000 .local/tts-config .local/models/downloads
```

(`.local/models` est monté `rw` côté gateway ; le sous-dossier `downloads/` est
créé et donné à `1000:1000` pour que l'étape 2 puisse y ranger ses fichiers.)

**Volumes nommés.** Aucune préparation n'est nécessaire **si** le répertoire
existe déjà **dans l'image** avec le bon propriétaire : `infra/gateway/Dockerfile:74-75`
crée **et** `chown` `/models` (dont `/models/downloads`) et `/data/tts-config`
(patron de `/voices`). Sans cela, Docker initialise le volume en `root:root` et le
gateway **ne peut pas écrire**. Preuve : `infra/gateway/Dockerfile:74` (`mkdir -p
… /models /models/downloads … /data/tts-config`), `:75` (`chown -R
"${YUKI_UID}:${YUKI_GID}" …`).

ℹ️ Il n'y a **plus** de prérequis de version Compose (l'option de **sous-chemin
de volume** a été retirée, voir **D60**) et **plus aucune migration** de volume
existant : le montage porte sur le dossier `/models` déjà présent.

### 3.1 Chemins internes = défauts du code, compose muet (D61)

Décision **D61** : les **cibles de montage** internes (`/models`,
`/data/tts-config`, `/config`, `/voices`, `/data/pi`, `/workspace`,
`/data/state`, et les chemins Pi dérivés `…/agent`, `…/agent/sessions`,
`…/home`) sont des **défauts du code**. Ils vivent dans une **source unique**,
`CONTAINER_PATHS` (`src/config/container-paths.ts:20-35`), consommée par
`src/config/env.ts:158-195`. Les composes ne définissent **AUCUNE** variable
d'environnement de chemin interne : ils restent **explicites** sur leurs montages
(`volumes: … target: /models`, …) et **muets** sur les variables.

La **surcharge par variable** (`YUKI_MOUNT_*`, `YUKI_TTS_CONFIG_DIR`,
`YUKI_TTS_ENGINE_CONFIG_DIR`, `YUKI_TTS_ENGINE_MODELS_DIR`, `YUKI_PI_*`,
`YUKI_CONFIG_DIR`) **reste lue** — capacité conservée pour les déploiements
existants, `deploy/minimal` et la CI, PAS un réglage à renseigner.

**Garde-fou.** `tests/config/container-paths.test.ts` vérifie, dans les deux
sens : (a) sans variable, les défauts **égalent EXACTEMENT** les `target:` des
composes ; (b) avec variable, la surcharge fonctionne ; (c) aucun compose ne
définit de variable de chemin interne. Une désynchronisation code ↔ compose est
donc **impossible par accident**.

---

## 4. Contrat des routes livrées

Toutes les routes vivent sous `/api/tts/**`, servies par le gateway
(`src/gateway/routes/tts.ts:1157-1190`), et **n'existent que si** le port
`engineConfig` est câblé (`src/index.ts:332-359`) ; sinon **`503
engine_config_unavailable`** (`src/gateway/routes/tts.ts:944-950`).

### 4.1 `GET /api/tts/engine-config`

- **Garde-fous** : aucun (lecture).
- **Réponse** : **toujours `200`** — un état « non monté » est un **cas normal**,
  pas une erreur (`src/gateway/routes/tts.ts:952-956`).
- **Corps** : `EngineConfigReport` (`src/tts/engine-config.ts:221-246`) —
  notamment `mounted`, `writable`, `available`, `fileExists`, `valid`,
  `parseError`, `backupExists`, `globals`, `models` (avec `pathStatus`
  `exists|missing|unverifiable`), `unknownTopLevelKeys`, `diagnostics`,
  `warnings`, `diskModels`, `diskTruncated`, `configPath`, `engineConfigPath`.

### 4.2 `PUT /api/tts/engine-config`

- **Garde-fous** : `requireWriteGuards` ⇒ en-tête `X-Yuki-Config: 1` **et** même
  origine, sinon **`403`** (`src/gateway/routes/config.ts:117-138`,
  `src/gateway/routes/tts.ts:977-978`).
- **Corps** : patch structuré `{ globals?, models? }` — **jamais** le JSON complet.
- **Réponses** :
  | Code | `code` | Cause |
  | --- | --- | --- |
  | `200` | — | patch appliqué, rapport renvoyé |
  | `400` | `invalid_json` | corps illisible |
  | `400` | `invalid_body` / `unknown_patch_field` / `invalid_globals` / `invalid_models` | forme du patch |
  | `400` | `invalid_engine_config` | champs refusés (détail `fields[]`) |
  | `403` | `missing_config_header` / `bad_origin` | garde-fous |
  | `422` | `config_invalid` | `server.json` existant illisible (jamais écrasé) |
  | `503` | `config_dir_not_mounted` / `config_dir_unwritable` / `engine_config_unavailable` | montage/wiring |
  | `500` | `backup_failed` / `config_write_failed` / `engine_config_failed` | E/S |
  Erreurs portées par `EngineConfigError` (`src/tts/engine-config.ts:154-164`),
  mappées par `engineConfigErrorResponse` (`src/gateway/routes/tts.ts:959-975`).

### 4.3 `POST /api/tts/engine-config/revert`

- **Garde-fous** : `requireWriteGuards` (**requis**, y compris en l'absence de
  `.bak`). Preuve : test `tests/integration/tts-engine-config.test.ts:278-302`.
- **Réponses** : `200` (restauré), `404 no_backup`, `422 backup_invalid`,
  `500 backup_unreadable`/`config_write_failed`, `503` non câblé.
- **Sémantique** : `server.json.bak` → `server.json`, **atomiquement** ;
  le `.bak` **n'est pas** supprimé (`src/tts/engine-config.ts:989-1037`).

### 4.4 `GET /api/tts/capabilities`

- **Garde-fous** : aucun (lecture) ; ne fait qu'une **sonde** (§8).
- **Réponse** : **`200` toujours**, même moteur injoignable
  (`unloadModels: null`). Preuve : test
  `tests/integration/tts-engine-config.test.ts:332-346`.

**Traduction des chemins.** Le `path` **stocké** est **toujours** le chemin **vu
par le moteur** (`/models/…`). Le gateway accepte en écriture tout chemin vu par
lui sous `/models` (y compris le sous-dossier de téléchargement
`/models/downloads`) et le **traduit** (`EngineConfigStore.toEnginePath`,
`src/tts/engine-config.ts:619-631`).

---

## 5. Listes fermées et validations (preuves)

| Champ | Valeurs autorisées | Comportement | Preuve |
| --- | --- | --- | --- |
| `task` | jetons canoniques `vad\|asr\|diar\|sep\|gen\|tts\|clon\|vc\|s2s\|align\|vdes\|spk\|svc\|midi` | `clone` **refusé** avec un message nommant `clon` | `src/tts/engine-config.ts:73-88`, `:391-402` ; `public/ui/engine-config-patch.js:16-32` |
| `mode` | `offline\|streaming` | `offline` **obligatoire** pour `chatterbox`/`cosyvoice3` | `src/tts/engine-config.ts:91`, `:116`, `:403-420` |
| `family` | noms **MOTEUR** `chatterbox\|qwen3_tts\|cosyvoice3\|kokoro_tts\|sanotts` | hors liste ⇒ `400` ; ⚠️ **corrigé** à l'étape 2 (D66) : ce sont les `family()` des loaders (`qwen3_tts`/`kokoro_tts`, underscores), pas les ids `tts.engine` | `src/tts/engine-config.ts:104-112`, `:402-407` |
| `id` | les **5** valeurs de `tts.engine` | hors liste ⇒ **accepté mais signalé** (`report.warnings`) | `src/tts/engine-config.ts:107-113`, `:744-747` |
| `path` | un `.gguf` **présent** dans les montages | hors montages ⇒ refusé ; `..` interdit ; absolu requis | `src/tts/engine-config.ts:421-448`, `:923-930` |

**Idempotence UI** : les mêmes listes sont appliquées **côté navigateur** (avant
envoi) pour un retour immédiat (`validateModelDraft`,
`public/ui/engine-config-patch.js:96-140`), et **revalidées côté serveur** — on
ne fait pas confiance au client.

**`clone` au lieu de `clon`** : la saisie est impossible via l'UI (le `task` est
un `<select>` alimenté par la liste), et un envoi direct est refusé **`400`**
avec `models[0].task` dans `fields[]` (test
`tests/integration/tts-engine-config.test.ts:240-253`).

**`mode` invalide** : refusé `400` ; un `streaming` sur une famille forcée est
refusé avec `mode_not_supported`. Preuve :
`tests/tts/engine-config.test.ts` (« refuse un mode inconnu et impose `offline` »),
`tests/ui/engine-config-patch.test.ts` (« impose `offline` … »).

---

## 6. Atomicité, sauvegarde et préservation

- **Préservation fidèle.** Le document existant est **cloné** puis fusionné ; les
  clés de premier niveau **inconnues** (`cors_origins`, `live_ingest`,
  `load_options`, …) et les clés **inconnues par entrée** (même `id`) sont
  conservées telles quelles. Preuve :
  `src/tts/engine-config.ts:817-959`, tests
  `tests/tts/engine-config.test.ts` (« préserve les clés inconnues… »,
  « conserve les clés inconnues d'une entrée réécrite »).
- **Écriture atomique.** `tmp` + `rename` dans le **même** dossier (M2), mode
  `0o644`, aucun fichier `.tmp-*` résiduel. Preuve :
  `src/tts/engine-config.ts:265-270`, test « écrit de façon ATOMIQUE ».
- **Sauvegarde unique.** Avant chaque écriture, l'ancien contenu devient
  `server.json.bak` (**une** version précédente). Preuve :
  `src/tts/engine-config.ts:961-987`, test « conserve UNE sauvegarde ».
- **Restauration.** `POST …/revert` réécrit `server.json` depuis le `.bak`
  (**atomiquement**), sans supprimer le `.bak`.

---

## 7. Rétro-compatibilité (« non monté »)

Une installation **déjà déployée** (fichier de config seul, sans M2) doit
**continuer de fonctionner** : la configuration n'est **pas** exposée, mais
**rien ne casse**.

- **Lecture** : `GET` répond `200` avec `mounted:false`, `available:false`, et un
  message qui **dit** que le dossier n'est pas monté
  (`public/ui/engine-config-patch.js:349-362`). Preuve : test
  `tests/integration/tts-engine-config.test.ts:177-184`.
- **Écriture** : `PUT` répond `503 config_dir_not_mounted` — **jamais** `500`.
  Preuve : test `tests/integration/tts-engine-config.test.ts:254-263`.
- **Lecture disque** : `report()` n'appelle `probeWritable` que si le dossier
  **existe** ⇒ aucune création de dossier par une lecture (rootfs gateway
  `read_only: true`). Preuves : `src/tts/engine-config.ts:649-679`, test « ne crée
  jamais le dossier de config lors d'une lecture ».

---

## 8. Sonde de capacités (sans effet de bord)

On ne veut **jamais** décharger un modèle réellement utilisé en « testant » une
route. La sonde envoie donc un **id sentinelle** qui ne peut correspondre à
aucun modèle : `__yuki_capability_probe__`
(`src/tts/engine-config.ts:1063`, `:1133`).

| Statut moteur | Lecture | `unloadModels` |
| --- | --- | --- |
| `404` | route absente | `false` |
| `405`, `2xx`, `400`, `422` | route présente (corps sentinelle refusé toléré) | `true` |
| `5xx` / erreur réseau | indéterminé | `null` |

L'UI **ne montre la fonction que si `true`** (`describeCapabilities`,
`public/ui/engine-config-patch.js:394-405`). ⚠️ La route
`POST /v1/tasks/unload_models` est **attestée par la documentation amont**, mais
son **existence réelle n'est pas re-vérifiée ici** (C33).

---

## 9. Interface (UI)

- **Vanilla, sans build.** Le composant `public/ui/tts-assistant.js` est monté par
  `id` et importe la logique pure `public/ui/engine-config-patch.js`
  (`public/ui/tts-assistant.js:28-41`).
- **CSP stricte.** Aucun `<style>` injecté, aucun `style=` : le CSS vit dans
  `public/ui/tts-assistant.css`. Preuve : test E2E « zéro `<style>` / attribut
  style / balise `<audio>` » et `tests/integration/static-ui.test.ts` (aucun
  `.style.` dans le JS).
- **Thèmes.** Le rendu respecte `5 familles × 2 modes` (attribut
  `data-theme`), comme le reste de `/config`.
- **Honnêteté du redémarrage.** L'UI distingue « **déjà déclaré → activable sans
  redémarrage** » de « **non déclaré → redémarrer le conteneur `tts`** »
  (`applicationState`, `public/ui/engine-config-patch.js:200-233`), et rappelle
  que le **socket Docker est refusé** (`restartProcedure`, `:235-248`).
- **Garde-fou anti-symbole-non-défini.** Le bug réel « `ENGINE_FORCE_OFFLINE_FAMILIES`
  utilisé sans être importé » (aujourd'hui **corrigé**,
  `public/ui/tts-assistant.js:30`) ne peut plus repasser : un test statique passe
  le compilateur TypeScript en `checkJs` sur **tous** les JS de `public/ui/` et
  échoue sur `TS2304`/`TS2552`/`TS2305`/`TS2307`/`TS2459`
  (`tests/ui/ui-modules-defined.test.ts`), avec un **auto-test** du détecteur.

---

## 10. Ce qui reste à faire

### 10.1 Étape 2 — téléchargement des modèles (**LIVRÉE, backend seul**)

Les montages et chemins sont **prêts** : `M1` (`/models`, `rw`) et
`MODELS_DOWNLOADS_SUBDIR` (`src/tts/engine-config.ts:63`), à partir duquel le code
**dérive** le chemin d'écriture `<models>/downloads`.

Le **backend** du téléchargement est **livré** à l'étape 2 : catalogue fermé
(`src/tts/catalog-data.ts`), job durable (`src/tts/downloads.ts`), routes
`/api/tts/catalog` et `/api/tts/downloads*` (§16). **L'UI est désormais livrée**
(§19) : catalogue, téléchargement, progression, annulation et déclaration sont
montés dans `#tts-downloads-root`. Le bloc « Ce qui reste à faire à la main » de
l'assistant a été **corrigé en conséquence** : déposer le fichier n'est **plus**
requis pour les 4 variantes du catalogue, mais **reste vrai** pour un moteur hors
catalogue (p. ex. `sanotts`, GPL-3.0).

### 10.2 Pré-déclaration des modèles (point ouvert C32)

Faut-il pré-remplir `models[]` depuis les `.gguf` présents sur le disque
(`report.diskModels`) lors d'une configuration vide ? Aujourd'hui l'UI propose
les chemins (liste fermée) mais **ne devine pas** les entrées. À trancher (§13).

---

## 11. Runbook — appliquer les montages depuis l'UI Docker

> Le gateway **n'a aucun accès au socket Docker** (décision ferme) : ces
> opérations se font depuis **votre** UI Docker (ou la CLI). Elles n'ont besoin
> d'être faites **qu'une fois**.

1. **Préparer l'hôte.** Pour un **bind mount** (dossier visible sur l'hôte) :

   ```bash
   mkdir -p <hôte>/tts-config <hôte>/models/downloads
   chown -R 1000:1000 <hôte>/tts-config <hôte>/models
   ```

   Le gateway monte `<hôte>/models` en `rw` (il peut y écrire) ; le sous-dossier
   `downloads/` est une **convention** de rangement pour l'étape 2, **pas** une
   barrière. Pour des **volumes nommés**, cette étape est inutile : le Dockerfile
   crée et `chown` déjà `/models` (dont `/models/downloads`) et `/data/tts-config`
   (`infra/gateway/Dockerfile:74-75`).

2. **Appliquer le compose.** Dans l'UI Docker de l'utilisateur (Unraid :
   *Edit* → *Apply*), ou en CLI :

   ```bash
   docker compose up -d gateway
   ```

   puis, si besoin, redémarrer le moteur :

   ```bash
   docker compose restart tts
   ```

3. **Vérifier que le gateway voit le montage.** Page `/config`, onglet **Voix**,
   section **« Configuration du moteur »** : le message doit être « prêt » (et
   non « non monté »). Équivalent CLI :

   ```bash
   curl -s http://127.0.0.1:8083/api/tts/engine-config | head
   # attendu : "mounted":true,"writable":true
   ```

4. **Éditer et enregistrer.** Ajoutez un modèle (liste fermée), enregistrez : le
   gateway écrit `server.json.bak` puis `server.json` **atomiquement**. Le moteur
   ne relit le fichier qu'à son **redémarrage** (`docker compose restart tts`).

---

## 12. Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **636 passed / 4 skipped** (avant la simplification des variables : 628 passed / 4 skipped ; +8 : `tests/config/container-paths.test.ts`, garde-fou des chemins internes) |
| `npm run typecheck` | vert |
| `npm run build` | vert |
| `node --check` (JS UI + harnais E2E) | vert |
| E2E headless (`_tools/e2e-tts-ui.mjs`) | **45/45**, **0 violation CSP**, **0 exception JS** |
| YAML des composes / JSON des exemples | parse OK |

**Preuves anti-régression** : `clone` refusé et `offline` imposé (tests unitaires
+ intégration), « non monté » honnête (intégration), auto-test du détecteur de
symboles (`tests/ui/ui-modules-defined.test.ts`), et **E2E qui rejoue le bug**
(famille `chatterbox` sans import ⇒ mode non forcé **et** exception JS).

---

## 13. Décidé / À confirmer

### Acté

| # | Décision | Preuve |
| --- | --- | --- |
| **D46** | **M1 — le gateway monte le dossier des modèles en `rw`** (`/models`) : lecture + écriture **future** des téléchargements. Le sous-dossier `downloads/` est une **CONVENTION** d'organisation (`MODELS_DOWNLOADS_SUBDIR` **dérivé**), **pas** une barrière. Le montage du **moteur** reste `ro`. | `docker-compose.yml:106-107,213-215`, `compose.bind.example.yml:48-49,72-74`, `src/tts/engine-config.ts:63,553` |
| **D47** | **M2 — le gateway monte le DOSSIER de config du moteur en `rw`** (`/data/tts-config`) : nécessaire à l'écriture **atomique** (`rename` impossible sur un fichier bind-monté). | `docker-compose.yml:113-114`, `src/tts/engine-config.ts:265-270` |
| **D48** | **M3 — le moteur monte le dossier de config en `ro`** sur `/config` ; **commande inchangée** (`server --config /config/server.json`) ; **aucun** montage moteur `rw`. | `docker-compose.yml:198,208-210,213-215`, `deploy/server/docker-compose.yml:201,208-210,212-214` |
| **D49** | **Listes fermées** : `task` canonique (`clon`, **jamais** `clone`), `mode` `offline\|streaming`, `family` fermée — validation **client ET serveur**. | `src/tts/engine-config.ts:73-100`, `public/ui/engine-config-patch.js:16-59` |
| **D50** | **`offline` obligatoire** pour `chatterbox`/`cosyvoice3` (tout autre mode refusé, `mode_not_supported`). | `src/tts/engine-config.ts:116,403-420` |
| **D51** | **`id` = les 5 valeurs de `tts.engine`** ; un id hors liste est **accepté mais signalé** (le moteur le charge, Yuki ne saura pas le sélectionner). | `src/tts/engine-config.ts:107-113,744-747` |
| **D52** | **`path` choisi parmi les `.gguf` présents** ; chemin **stocké = vue moteur** ; traduction gateway↔moteur explicite ; hors montages refusé. | `src/tts/engine-config.ts:619-631,923-930` |
| **D53** | **Préservation fidèle** des clés inconnues (top-level et par entrée de même `id`) lors du patch. | `src/tts/engine-config.ts:817-959` |
| **D54** | **Écriture atomique** (`tmp`+`rename`) + **`server.json.bak`** (une version) + **route de restauration**. | `src/tts/engine-config.ts:265-270,961-1037`, `src/gateway/routes/tts.ts:999-1008` |
| **D55** | **Rétro-compatibilité** : sans M2, `GET` `200` avec `mounted:false` et `PUT` `503 config_dir_not_mounted` ; **rien ne casse**. | `src/gateway/routes/tts.ts:952-956`, `tests/integration/tts-engine-config.test.ts:177-184,254-263` |
| **D56** | **Sonde de capacités sans effet de bord** (id sentinelle) ; la fonction n'est montrée que si la route est **confirmée**. | `src/tts/engine-config.ts:1082-1175`, `public/ui/engine-config-patch.js:394-405` |
| **D57** | **Socket Docker refusé** ; l'UI ne prétend jamais redémarrer un conteneur : elle décrit le chemin « redémarrer `tts` depuis votre UI Docker ». | `public/ui/engine-config-patch.js:235-248`, `docs/lot8.md` §2.1 |
| **D58** | **UI vanilla sans build, CSP stricte, thèmes 5×2, réutilisation de l'existant**, plus un **garde-fou statique anti-symbole-non-défini** (auto-testé). | `public/ui/tts-assistant.js:28-41`, `tests/ui/ui-modules-defined.test.ts` |
| **D60** | **Décision opérateur : simplifier M1 — un SEUL montage `/models`, en `rw`.** Écriture sur **tout** `/models` **assumée** (composant de confiance, sur la machine de l'opérateur, modèles ~2 Go) ; `downloads/` = **convention**, pas **barrière**. **Retrait** de l'option de **sous-chemin de volume**, du montage **imbriqué**, du **prérequis Compose** et de la **migration** de volume. Les identifiants **D59**/**C37** (travail intermédiaire) sont **retirés** et **non réattribués**. | `docker-compose.yml:106-107`, `compose.bind.example.yml:48-49`, `deploy/server/docker-compose.yml:107-108`, `src/tts/engine-config.ts:63` |
| **D61** | **Chemins internes = défauts du code, compose muet.** Les cibles de montage (`/models`, `/data/tts-config`, `/config`, `/voices`, `/data/pi`, `/workspace`, `/data/state`) sont une **source unique** (`CONTAINER_PATHS`, `src/config/container-paths.ts`) consommée par `env.ts`. Les composes ne définissent **aucune** variable de chemin interne ; la **surcharge par variable** (`YUKI_MOUNT_*`, `YUKI_TTS_CONFIG_DIR`, `YUKI_TTS_ENGINE_CONFIG_DIR`, `YUKI_TTS_ENGINE_MODELS_DIR`, `YUKI_PI_*`, `YUKI_CONFIG_DIR`) **reste lue** (rétro-compatibilité). Un test garde-fou compare défauts ↔ `target:` des composes. | `src/config/container-paths.ts:20-35`, `src/config/env.ts:158-195`, `tests/config/container-paths.test.ts`, `docker-compose.yml:28-53` |
| **D62** | **Qwen3-TTS (paquet `Base`) retenu** : `id: "qwen3-tts"`, `family: "qwen3_tts"`, **`task: "tts"`**, **`mode: "offline"`**. Paquet `Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` (**2 695 175 104 o**, ≈ 2,51 Gio, **Apache-2.0**), `ui.recommended_package` de la spec. **La tâche dépend de la VARIANTE du paquet** (Base→`tts`, VoiceDesign→`vdes`, CustomVoice→`tts`), pas de la liste `tasks` de la famille. | §14.1, §14.2 ; `model_specs/qwen3_tts.json` (`ui.recommended_package`), `src/models/qwen3_tts/loader.cpp` (`capabilities`, `create_task_session`), `src/framework/runtime/task_vocabulary.cpp`, API HF |
| **D63** | **`language` : Qwen3-TTS attend un NOM, pas un code ISO.** Yuki envoyait `language: "fr"` (enum `tts.language`) ⇒ `Qwen3 talker unsupported language: fr` (**HTTP 500**). Correctif : `engineLanguageValue` traduit le code Yuki en nom pour `qwen3-tts` (`fr`→`French` ; inconnu→`Auto`) ; les autres moteurs sont **inchangés** (`fr`). | §14.5 ; `src/tts/audio-cpp.ts` (`engineLanguageValue`), `src/models/qwen3_tts/talker.cpp` (`build_prompt_state`), `config.json` embarqué (`talker_config.codec_language_id`), README `Qwen/Qwen3-TTS-12Hz-1.7B-Base` |
| **D64** | **`id` d'une entrée `models[]` = étiquette LIBRE** (pas le nom de famille) : `id: "qwen3-tts"` + `family: "qwen3_tts"` coexistent dans l'exemple amont ; le serveur indexe par `id` et Yuki envoie `tts.engine` **tel quel** comme clé `model`. | §14.7 ; `examples/docker/server/qwen3-tts-server.json`, `app/server/runtime.cpp` (`require_model`, `model_config_from_json`) |
| **D65** | **Voice design / CustomVoice : possibles sans référence, mais NON pilotables depuis Yuki.** `VoiceDesign` (`task: "vdes"`) génère depuis une `instruction`/`instruct` que Yuki n'envoie pas (rendu par défaut, sans crash) ; `CustomVoice` (`task: "tts"`) **exige** un `speaker` (préréglage) et **échoue** sans (`unsupported speaker: `). **Recommandation : paquet `Base` + voix de référence (comme CosyVoice 3).** | §14.4 ; `src/models/qwen3_tts/session.cpp` (`make_request`), `src/models/qwen3_tts/prompt_tts_voice_design.cpp` |
| **D66** | **Correction de la liste fermée `family`** (défaut de l'étape 1) : les valeurs sont les **noms MOTEUR** — `chatterbox`, `qwen3_tts`, `cosyvoice3`, `kokoro_tts`, `sanotts` — et **non** les ids `tts.engine` (`qwen3-tts`, `kokoro`). Sans ce correctif, déclarer Qwen/Kokoro via l'éditeur aurait produit un `family` que le moteur REFUSE (`unsupported model family hint`). Miroir UI mis à jour. | preuves : `model_specs/*.json` (`family`), README HF (tableau « audio.cpp family »), `app/server/runtime.cpp:2116` (`family != "kokoro_tts"`), `examples/docker/server/qwen3-tts-server.json` (`id: qwen3-tts`, `family: qwen3_tts`), `src/models/chatterbox/loader.cpp:27`, `src/models/qwen3_tts/loader.cpp:27` ; `src/tts/engine-config.ts:104-112`, `public/ui/engine-config-patch.js:37-46`, tests `tests/tts/engine-config.test.ts`, `tests/ui/engine-config-patch.test.ts` |
| **D67** | **Catalogue FERMÉ côté serveur, destination imposée.** Le client n'envoie qu'un `catalogId` (jamais d'URL) ; les URL `resolve` HF sont construites par le serveur. Destination `/models/downloads/<id>/model.gguf` (nom IMPOSÉ, sélectionnable par le moteur). Le **nom exact et la taille** sont **résolus à la demande** via l'API HF (`tree`), avec un **repli documenté** (nom/taille annoncés, `sha256` non prétendu) si l'API est injoignable. | `src/tts/catalog-data.ts` (`CATALOG_ENTRIES`, `resolveCatalogPackage`), `tests/tts/catalog.test.ts` |
| **D68** | **Job DURABLE à garanties** : écriture `.part` puis **`rename` atomique** ; contrôle de **taille** et d'**intégrité** SHA-256 (si HF expose `lfs.oid`) ; **reprise `Range`** conditionnelle (`206` + taille inchangée) ; **contrôle d'espace disque** avant démarrage ; **1 téléchargement à la fois** ; **annulation** `AbortController` ; registre persistant qui passe toute tâche non terminale en **`interrupted`** (jamais `done`) après un redémarrage du gateway. | `src/tts/downloads.ts`, `tests/tts/downloads.test.ts`, `tests/integration/tts-downloads.test.ts` |
| **D69** | **Cohérence avec le redémarrage : `POST /api/admin/restart` REFUSE (`409 download_in_progress`)** tant qu'un téléchargement est `queued`/`downloading`/`verifying` (le process serait sinon tué sans explication). Aucun téléchargement actif ⇒ **comportement inchangé** (`200` + arrêt planifié). | `src/gateway/routes/admin.ts` (`handleRestart`), câblage `src/index.ts`, tests `tests/gateway/restart-api.test.ts`, `tests/integration/tts-downloads.test.ts` |
| **D70** | **`sanotts` ÉCARTÉ du catalogue, mais SIGNALÉ.** Seul paquet amont identifié (`ampixa/sanoTTS`, `model_specs/sanotts.json`), sous **GPL-3.0** : hors politique MIT/Apache-2.0. Exposé dans `GET /api/tts/catalog` (`notIncluded`), jamais retiré silencieusement ; sa famille reste autorisée par l'éditeur (un GGUF déposé à la main reste déclarable). | `src/tts/catalog-data.ts` (`CATALOG_REJECTIONS`), API/README HF `ampixa/sanoTTS` (`license: gpl-3.0`), `tests/tts/catalog.test.ts` |

### À confirmer

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C30** | Le **chemin `/config/server.json`** est un **choix Yuki** (le WORKDIR de l'image `audio.cpp` n'est **pas attesté**) ; c'est un **défaut du code** (D61), surchargeable par `YUKI_TTS_ENGINE_CONFIG_DIR` pour une relocalisation avancée (hors compose). **À confirmer** en réel sur le conteneur. | M3 / déploiement |
| **C31** | **Écriture réelle** du gateway dans le dossier monté `rw` : confirmer les permissions bind (`chown 1000:1000`) sur l'hôte Unraid (et non seulement les volumes nommés, préparés par l'image) — vaut pour M2 (`tts-config`) ET pour M1 (`models`, où l'étape 2 rangera `downloads/`). | M2 / M1 / runbook §11 |
| **C32** | **Pré-déclaration des modèles** : pré-remplir `models[]` depuis les `.gguf` présents (`report.diskModels`) ? Aujourd'hui, non. | UX §10.2 |
| **C33** | **Existence réelle de `POST /v1/tasks/unload_models`** : la sonde la **teste** sans effet de bord, mais le lot ne **re-vérifie pas** son contrat (corps/statuts exacts). | §8 |
| **C34** | **Ordre et format** du JSON après aller-retour : les clés inconnues sont **conservées**, mais l'ordre/indentation sont **réécrits** par `JSON.stringify(…, 2)`. Acceptable ? | §6 |
| **C35** | **Téléchargement (étape 2)** : source des URLs, vérification d'intégrité (hash), reprise après interruption, garde de taille. | §10.1 |
| **C36** | **`max_loaded_models` / éviction LRU** : le comportement réel du moteur (défaut `0` = illimité) n'est **pas re-vérifié ici**. | §5 / `docs/lot8.md` D45 |
| **C38** | **Contrat d'options RÉEL de `qwen3_tts`** : la spec amont (`main`) **n'a ni `schema_version` ni `options`** (legacy, comme Chatterbox), et le GGUF publié **embarque une spec legacy** (métadonnée `audiocpp.model_spec.json` lue par Range HTTP) ⇒ `model_contract()` = `nullopt` ⇒ **aucun rejet strict d'option**. La spec **installée dans l'image** peut différer (build différent) : à confirmer. **Sans effet sur Yuki** (elle n'envoie ni `options` ni `speed`). Manip : `docker exec yuki-tts curl -s -X POST localhost:8081/v1/audio/speech -H 'content-type: application/json' -d '{"model":"qwen3-tts","input":"x","options":{"__bogus__":1}}'` (500 ⇒ contrat strict ; 200/other ⇒ legacy). | §14.6 |
| **C39** | **`mode: streaming` proposé par l'UI pour `qwen3-tts`** : `qwen3-tts` n'est **pas** dans `ENGINE_FORCE_OFFLINE_FAMILIES` (`src/tts/engine-config.ts:117`) alors que le moteur n'accepte **que** `offline`. Envisager de l'y ajouter (correctif UI, non fait ici). | §14.3, §14.10 |
| **C40** | **Qualité française perçue** Qwen3-TTS (Base, voix `voix-fr`) vs Chatterbox/CosyVoice 3, et **VRAM réelle** du chargement à trois (poids Q8). | §14.10 |
| **C41** | **Téléchargement RÉEL de plusieurs Go** : les tests utilisent un serveur simulé (quelques Ko). À confirmer en réel : débit du CDN Xet, `Accept-Ranges`/`If-Range`, et que le `.part` est bien repris après un `POST /api/admin/restart`. Manip : `curl -s -X POST .../api/tts/downloads -H 'X-Yuki-Config: 1' -H 'content-type: application/json' -d '{"catalogId":"kokoro"}'` (plus léger, ≈ 181 Mio). | §16.6 |
| **C42** | **`family` de `sanotts` / licences hors politique** : l'utilisateur peut vouloir un modèle GPL-3.0 pour un usage strictement privé — politique à trancher (refus ferme vs avertissement). Aujourd'hui : refus au téléchargement, déclaration manuelle possible. | D70, §16.2 |
| **C43** | **Coût de la reprise** : après un `.part`, le SHA-256 complet exige de **relire le préfixe** (le contexte de hachage n'est pas persisté). Acceptable pour ~2 Go, à mesurer en réel. Alternative : vérifier par tranche (Merkle) — non implémenté. | §16.4 |
| **C44** | **Profondeur de file** : un seul téléchargement à la fois, **sans borne** du nombre de tâches en attente (contrairement à `JobQueue`). À borner si besoin. | §16.4 |
| **C45** | **Paquets à fichiers MULTIPLES** : le nom `model.gguf` imposé suppose un GGUF **seul**. Les 4 paquets retenus le sont ; `sanotts` (écarté) embarque un `config.json` sidecar — à gérer si un jour on l'accepte. | §16.2 |

---

## 14. Faire tourner Qwen (famille `qwen3_tts`)

> **Ajout du 2026-09-22.** Établi depuis le **code source amont** `0xShug0/audio.cpp`
> (branche `main`), l'**API Hugging Face** réellement interrogée, la **spec
> embarquée du GGUF** lue par **requête HTTP Range**, et le README du modèle
> `Qwen/Qwen3-TTS-12Hz-1.7B-Base`. **Aucune valeur n'est extrapolée de
> Chatterbox ni de CosyVoice 3.**
>
> **Pourquoi ici et pas dans `docs/lot8.md` (`§13` CosyVoice 3) ?** Le Qwen
> n'introduit **pas** de nouveau montage ni de nouveau protocole : il s'ajoute
> comme **entrée `models[]`** dans `server.json` (listes fermées `family`/`task`/
> `mode`/`id` = lot 9) et se sélectionne par **`tts.engine`**. Les tableaux
> **D##/C##** étant ici (dernier **D61**/**C36**), la continuité imposée par la
> note d'en-tête s'y poursuit (**D62 → D65**, **C38 → C40**).

### 14.1 Fichiers GGUF (preuve : API HF)

`GET https://huggingface.co/api/models/audio-cpp/audio.cpp-gguf/tree/main/<dossier>`
(**HTTP 200**) — **9 fichiers** répartis en **4 dossiers** :

| Dossier | Fichier | Octets | Taille |
| --- | --- | ---: | ---: |
| `Qwen3-TTS-12Hz-0.6B-Base-GGUF` | `qwen3-tts-12hz-0.6b-base-q8_0.gguf` | `1991211136` | ≈ 1,85 Gio |
| `Qwen3-TTS-12Hz-0.6B-Base-GGUF` | `qwen3-tts-12hz-0.6b-base-bf16.gguf` | `2516154496` | ≈ 2,34 Gio |
| `Qwen3-TTS-12Hz-1.7B-Base-GGUF` | `qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` | `2695175104` | ≈ **2,51 Gio** |
| `Qwen3-TTS-12Hz-1.7B-Base-GGUF` | `qwen3-tts-12hz-1.7b-base-bf16.gguf` | `4203158464` | ≈ 3,91 Gio |
| `Qwen3-TTS-12Hz-1.7B-Base-GGUF` | `qwen3-tts-12hz-1.7b-base-orig.gguf` | `4544273280` | ≈ 4,23 Gio |
| `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF` | `qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf` | `2817044064` | ≈ 2,62 Gio |
| `Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF` | `qwen3-tts-12hz-1.7b-customvoice-bf16.gguf` | `4179144352` | ≈ 3,89 Gio |
| `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF` | `qwen3-tts-12hz-1.7b-voicedesign-q8_0.gguf` | `2816988960` | ≈ 2,62 Gio |
| `Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF` | `qwen3-tts-12hz-1.7b-voicedesign-bf16.gguf` | `4179089248` | ≈ 3,89 Gio |

**Licence** — lignes du README du dépôt HF (`.../raw/main/README.md`, HTTP 200) :
« `Qwen3-TTS-12Hz-1.7B-Base-GGUF` | `qwen3_tts` | original + BF16 + Q8 |
**Apache-2.0** » (idem pour les 3 autres dossiers). ⚠️ Le **tag global** du dépôt
agrégé reste `license: other` : c'est la licence **du dossier** qui compte
(**Apache-2.0**).

**Recommandation : `Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf`**
(≈ 2,51 Gio). Justification : c'est le **paquet recommandé par la spec amont**
(`ui.recommended_package = "qwen3_tts_1_7b_base_q8_0"`, `model_specs/qwen3_tts.json`),
taille **1,7 B** (meilleure qualité que 0,6 B), quantification **Q8_0** (≈ 40 % plus
léger que BF16 et 2× moins que `orig`), et c'est la **variante `Base`** = clonage
(le cas d'usage de la voix `voix-fr`). Les variantes `VoiceDesign`/`CustomVoice`
ne sont **pas** retenues ici (cf. D65, §14.4).

### 14.2 Tâches acceptées (prouvées par le loader)

`model_specs/qwen3_tts.json` (famille) : `"tasks": ["tts", "clone", "design"]`.
Mais **le loader décide par VARIANTE** (`src/models/qwen3_tts/loader.cpp`,
`capabilities()` + `create_task_session()`) :

| Variante du paquet | Tâche runtime | Mode | Référence |
| --- | --- | --- | --- |
| `Base` | **`Tts`** (⇒ `task: "tts"`) | `offline` | **obligatoire** (`supports_speaker_reference`) |
| `VoiceDesign` | **`VoiceDesign`** (⇒ `task: "vdes"`) | `offline` | aucune (instruction) |
| `CustomVoice` | **`Tts`** (⇒ `task: "tts"`) | `offline` | aucune (`speaker`) |

⚠️ Le jeton écrit dans `server.json` suit `parse_voice_task_kind`
(`task_vocabulary.cpp`) : la spec écrit `clone`/`design`, le **jeton canonique**
est **`clon`**/**`vdes`**. Pour le paquet `Base` retenu, c'est **`tts`** (le loader
refuse `clon` sur `Base` : `Qwen3 base TTS model only supports the Tts task`).

### 14.3 Modes : `offline` UNIQUEMENT (pas de streaming)

`model_specs/qwen3_tts.json` : `"modes": ["offline"]`. Le loader n'annonce que
`RunMode::Offline`, et `create_task_session` **lève** `Qwen3 TTS only supports
offline sessions` pour tout autre mode. ⇒ **pas de streaming**, donc **pas de
gain de TTFA** (le premier son attend la synthèse du premier segment, comme
ailleurs). Yuki **n'envoie de toute façon pas** `stream_format`
(`src/tts/synthesizer.ts`).

### 14.4 Voix de référence : OBLIGATOIRE pour `Base` ; sans référence = `VoiceDesign`/`CustomVoice` (non pilotables depuis Yuki)

- **`Base` — référence obligatoire.** Sans audio, `session.cpp` lève
  `Qwen3 base TTS requires voice clone reference audio`. L'audio provient de
  `request.voice.speaker.audio` OU `request.audio_input` (i.e. la clé top-level
  **`voice_ref`**, chemin) — **Yuki l'envoie déjà** (`voice_ref` =
  `/voices/presets/voix-fr.wav`). `reference_text` est **optionnel** (lu dans
  `options`), recommandé comme pour CosyVoice 3.
- **`VoiceDesign` — sans référence.** Génère depuis une **`instruction`/
  `instruct`** (naturelle). Yuki **ne l'envoie pas** ⇒ rendu **sans description**
  (le prompt builder tolère une instruction vide : pas de crash, voix générique).
- **`CustomVoice` — sans référence, mais ÉCHOUE via Yuki.** Il exige un
  **`speaker`** (préréglage, ex. `Vivian`) ; sans lui, `talker.cpp` lève
  `Qwen3 custom voice unsupported speaker: `. Yuki n'envoie pas `speaker`.

**Conclusion nette : oui, Qwen peut générer SANS référence** (`VoiceDesign`,
`task: "vdes"`), **mais Yuki n'expose ni `instruct` ni `speaker`** → la seule
variante **réellement pilotable depuis Yuki est `Base` + voix de référence**
(comme CosyVoice 3). C'est le choix recommandé.

### 14.5 ⚠️ Le piège `language` (échec immédiat corrigé)

Yuki envoie **toujours** `language` au niveau supérieur (= `tts.language`, enum
**`["fr"]`**). Or le talker Qwen3-TTS fait `ascii_lower(language)` puis
`codec_language_id.find(...)`, dont les **clés sont des NOMS** (`chinese`,
`english`, …, **`french`**) — `src/models/qwen3_tts/talker.cpp`,
`build_prompt_state`. Un code `fr` **lève** `Qwen3 talker unsupported language: fr`
⇒ **HTTP 500**. Le README du modèle documente d'ailleurs `language="French"`.

**Correctif (D63) :** `engineLanguageValue` (`src/tts/audio-cpp.ts`) traduit le
code Yuki en **nom** pour `qwen3-tts` (`fr` → `French` ; code inconnu → `Auto`,
toujours accepté) ; les **autres moteurs sont inchangés** (`fr`). ⚠️ C'est une
modification **du code**, donc de l'**image Yuki** (`ghcr.io/grokuku/yuki`) :
elle doit être **reconstruite/publiée** (ou `compose.build.example.yml`) — pas
seulement changer `tts.language` (impossible : l'enum n'a que `fr`).

### 14.6 Options acceptées / rejetées

⚠️ **« Contrat schema-v1 strict » NON prouvé pour `qwen3_tts`.** La spec amont
(`model_specs/qwen3_tts.json`, `main`) n'a **ni `schema_version` ni `options`**
(contrairement à `cosyvoice3.json`), et le **GGUF publié embarque une spec
legacy** (métadonnée `audiocpp.model_spec.json`, 937 o : uniquement `family` +
`sources`) ⇒ `model_contract()` renvoie `nullopt` ⇒ `model_accepts_request_option()`
renvoie **`true`** partout (`metadata.cpp:299-309`, `runtime.cpp:95-115`). Le
moteur **n'a donc pas de liste d'options à rejeter** (comme Chatterbox). C'est
**C38** s'il faut le figer pour l'image déployée.

Quoi qu'il en soit, **Yuki n'envoie à ce moteur que des clés sûres** : `model`,
`input`, `language` (traduite), `response_format`, `voice`, `voice_ref`,
`reference_text`. Elle **n'envoie ni `options`, ni `speed`/`speaking_rate`, ni
`stream_format`** (`engineSupportsEmotion`/`engineSupportsSpeed` ; D40/D42).
Aucune de ces clés n'est validée à l'arrivée (le `language` vit dans
`text_input`, jamais dans `options`).

### 14.7 `server.json` (tri-modèle) — prêt à coller

Le moteur garde **Chatterbox + CosyVoice 3**, on **ajoute** Qwen (`lazy_load`,
chargement multiple attestés : `docs/lot8.md` D45). Multi-ligne, indenté :

```json
{
  "host": "0.0.0.0",
  "port": 8081,
  "backend": "cuda",
  "device": 0,
  "lazy_load": true,
  "ui_enabled": false,
  "voice_dir": "/voices",
  "models": [
    {
      "id": "chatterbox",
      "family": "chatterbox",
      "path": "/models/Chatterbox-GGUF/chatterbox-q8_0.gguf",
      "task": "clon",
      "mode": "offline"
    },
    {
      "id": "cosyvoice3",
      "family": "cosyvoice3",
      "path": "/models/CosyVoice3-GGUF/cosyvoice3-q8_0.gguf",
      "task": "clon",
      "mode": "offline"
    },
    {
      "id": "qwen3-tts",
      "family": "qwen3_tts",
      "path": "/models/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
      "task": "tts",
      "mode": "offline"
    }
  ]
}
```

⚠️ **`id` = `"qwen3-tts"` (tiret)**, **pas** `qwen3_tts` (la **famille**, underscore) :
Yuki envoie `tts.engine` **tel quel** comme clé `model`, et le serveur indexe par
**`id`** (`examples/docker/server/qwen3-tts-server.json` : `id` et `family`
diffèrent). C'est une **étiquette libre** (D64).

Options de confort inchangées (`max_loaded_models`, `idle_unload_ms`,
`min_free_memory_mb`) — voir `docs/lot8.md` §13.7.

### 14.8 Téléchargement (URL vérifiée HTTP 200)

```bash
curl -L --fail --create-dirs \
  -o /mnt/user/appdata-ssd/yuki-server/models/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf \
  https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf
```

URL `resolve/main/...` vérifiée **HTTP 200** (redirection CDN Xet, `x-linked-size:
2695175104`). Chemin **dans le conteneur** :
`/models/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf`.

### 14.9 Suite côté Yuki

1. Déployer l'image Yuki **avec le correctif `language`** (D63) — sans lui, chaque
   requête Qwen renvoie **500** (§14.5).
2. `server.json` (§14.7) → **redémarrer** le service `tts` (bind `ro` relu au
   démarrage) : `docker restart yuki-tts`.
3. Dans `/config`, onglet **Voix** → **Configuration du moteur**, ajouter/valider
   l'entrée `qwen3-tts` (listes fermées) si elle n'est pas déjà dans le fichier.
4. Dans `/config`, changer **`tts.engine`** = **`qwen3-tts`** (`src/config/schema.ts`),
   **`apply: restart`** ⇒ cliquer **Redémarrer** (onglet **Maintenance**).
5. **Aucun autre champ** : `tts.voice` (vide = `voix-fr`) reste valable ;
   `tts.speed` **n'est pas envoyé** ; émotion (`tts.emotion`/`exaggeration`/`cfg`)
   ne s'applique **qu'à Chatterbox** (déjà grisée par l'UI).

### 14.10 Pièges

- **VRAM.** Poids Q8 ≈ **2,51 Gio** ; estimation serveur (`poids × 1,5 + 128 Mio`)
  ≈ **3,9 Gio**. Les **trois** modèles chauds (Chatterbox ≈ 3,0 + CosyVoice 3
  ≈ 3,3 + Qwen ≈ 3,9 Gio est.) ≈ **10 Gio** + arènes : confortable sur 16–24 Gio,
  tendu sur 8 Gio. Sinon `"max_loaded_models": 1` (un seul résident, LRU).
- **Erreur d'allocation** (`failed to allocate backend tensors`, déjà vu avec
  ComfyUI) : `nvidia-smi` → libérer la VRAM (arrêter le conteneur GPU) → relancer.
- **Streaming / TTFA** : §14.3 — **offline only**, pas de flux incrémental.
- **Retour arrière en 30 s** : `tts.engine` = `chatterbox` (ou `cosyvoice3`) dans
  `/config`, **Redémarrer**. `server.json` garde les trois modèles : rien à démonter.

---

## 16. Téléchargement des modèles (Lot 9, étape 2 — backend seul)

> **Ajout du 2026-09-23.** Le **backend** du téléchargement est livré : catalogue
> fermé, job durable, routes et tests. ⚠️ **Aucune UI** dans ce lot (la page
> `/config` est en refonte) : l'API est complète et documentée, prête à être
> consommée. Décisions **D66 → D70**, points ouverts **C41 → C45**.

### 16.1 Fichiers livrés

| Fichier | Rôle |
| --- | --- |
| `src/tts/catalog-data.ts` | Catalogue **fermé** + résolution HF **à la demande** + `CATALOG_REJECTIONS` |
| `src/tts/downloads.ts` | `TtsDownloadManager` : job durable, registre persistant, reprise, annulation |
| `src/gateway/routes/tts.ts` | Routes `catalog` / `downloads` / `downloads/{id}/cancel` |
| `src/gateway/routes/admin.ts` | Refus `409` du redémarrage pendant un téléchargement (D69) |
| `src/index.ts` | Câblage (registre dans le volume `state`, garde-fou admin) |
| `tests/tts/catalog.test.ts`, `tests/tts/downloads.test.ts`, `tests/integration/tts-downloads.test.ts`, `tests/gateway/restart-api.test.ts` | Tests |

### 16.2 Catalogue FERMÉ (preuves)

Toutes les valeurs sont **établies depuis la source amont** : API Hugging Face
(`GET /api/models/<repo>/tree/main/<dir>`, HTTP 200), tableau du README du dépôt
(licence par dossier), `model_specs/*.json` (family/tasks/modes) et le code des
loaders/sessions. **Aucune valeur inventée.**

| `tts.engine` | dépôt / dossier HF | fichier retenu | taille (o) | licence | `family` | `task` | `mode` |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| `chatterbox` | `audio-cpp/audio.cpp-gguf` / `Chatterbox-GGUF` | `chatterbox-q8_0.gguf` | 2 088 393 668 | MIT | `chatterbox` | `clon` | `offline` |
| `cosyvoice3` | `audio-cpp/audio.cpp-gguf` / `CosyVoice3-GGUF` | `cosyvoice3-q8_0.gguf` | 2 257 658 080 | Apache-2.0 | `cosyvoice3` | `clon` | `offline` |
| `qwen3-tts` | `audio-cpp/audio.cpp-gguf` / `Qwen3-TTS-12Hz-1.7B-Base-GGUF` | `qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` | 2 695 175 104 | Apache-2.0 | `qwen3_tts` | `tts` | `offline` |
| `kokoro` | `audio-cpp/audio.cpp-gguf` / `Kokoro-82M-GGUF` | `kokoro-82m-q8_0.gguf` | 189 549 408 | Apache-2.0 | `kokoro_tts` | `tts` | `offline` |
| `sanotts` | `ampixa/sanoTTS` / `gguf` | (`heart-nano-f32.gguf`) | 1 197 376 | **GPL-3.0 → ÉCARTÉ** | `sanotts` | `tts` | `offline` |

**Preuves par ligne :**

- **chatterbox** — README HF (« `Chatterbox-GGUF` … **MIT** ») ;
  `model_specs/chatterbox.json` (`family: chatterbox`, `tasks: [tts, clone, vc]`,
  `modes: [offline]`) ; loader `src/models/chatterbox/loader.cpp:27`
  (`out.family = "chatterbox"`), `:17-18` (VoiceCloning/VoiceConversion),
  `:131-138` (offline). Tâche **`clon`** : le loader ne supporte QUE le clonage et
  la conversion de voix.
- **cosyvoice3** — README HF (**Apache-2.0**) ; `model_specs/cosyvoice3.json`
  (`family: cosyvoice3`, `tasks: [tts, clone]`, `modes: [offline]`) ;
  `src/models/cosyvoice3/session.cpp:88-92` (« supports tts and clone », offline).
- **qwen3-tts** — README HF (**Apache-2.0**) ; `model_specs/qwen3_tts.json`
  (`family: qwen3_tts`, `ui.recommended_package = qwen3_tts_1_7b_base_q8_0`) ;
  loader `src/models/qwen3_tts/loader.cpp:140` (« **Qwen3 base TTS model only
  supports the Tts task** ») ⇒ `task: tts` ; `:137-138` offline only. Exemple amont
  `examples/docker/server/qwen3-tts-server.json` (`id: qwen3-tts`,
  `family: qwen3_tts`, `task: tts`, `mode: offline`).
- **kokoro** — README HF (**Apache-2.0**) ; `model_specs/kokoro_tts.json`
  (`family: kokoro_tts`, `tasks: [tts]`, `modes: [offline]`) ; `app/server/runtime.cpp:2116`
  compare bien `family != "kokoro_tts"`.
- **sanotts** — `model_specs/sanotts.json` : `family: sanotts`, `tasks: [tts]`,
  `modes: [offline]`, `package_defaults.download.repo = ampxa/sanoTTS` ; fiche HF
  `ampixa/sanoTTS` : `license: gpl-3.0`. **Hors politique (MIT/Apache-2.0) ⇒ écarté**
  (D70), mais **signalé** dans `notIncluded`.

⚠️ Les URL `resolve/main/...` ont été **vérifiées HTTP 200** (redirection CDN Xet,
`x-linked-size` = taille ci-dessus, `x-linked-etag` = SHA-256 LFS). Le `lfs.oid`
de l'API `tree` **est** ce SHA-256 : il sert d'attendu d'intégrité (D68).

### 16.3 Contrat des routes

Toutes sous `/api/tts/**` (gateway), **présentes seulement si le port `downloads`
est câblé** ; sinon **`503 downloads_unavailable`**.

#### `GET /api/tts/catalog`

- **Garde-fous** : aucun (lecture).
- **Réponse** : `200` (état local) ou `503 downloads_unavailable`.
- **Corps** : `{ schemaVersion, entries[], notIncluded[], engineConfigAvailable, note }`.
  Chaque `entries[]` porte : `id, label, repo, dir, variant, family, task, mode,
  license, licenseAllowed, expectedFile, expectedBytes, expectedSha256, enginePath,
  gatewayPath, installed, installedBytes, declared, declaredPath, download` et
  **`prefill: { id, family, task, mode, path }`** — les champs EXACTS à envoyer à
  `PUT /api/tts/engine-config` (pré-remplissage, testé de bout en bout).
- **`notIncluded`** : moteurs écartés (`sanotts`) avec `reason`, `license`, `detail`.

#### `GET /api/tts/downloads`

- **Garde-fous** : aucun. **Réponse** : `200 { schemaVersion, active, tasks[] }`
  (`active` = id de la tâche `downloading`/`verifying`, sinon `null`).

#### `POST /api/tts/downloads`

- **Garde-fous** : `requireWriteGuards` (`X-Yuki-Config: 1` **et** même origine).
- **Corps** : `{ catalogId }` — **jamais d'URL**.
- **Réponses** :

| Code | `code` | Cause |
| --- | --- | --- |
| `202` | — | tâche acceptée : `{ ok, accepted, task }` |
| `400` | `invalid_json` / `invalid_body` / `invalid_catalog_id` | corps |
| `400` | `unknown_catalog_id` | id hors catalogue |
| `403` | `missing_config_header` / `bad_origin` | garde-fous |
| `409` | `download_in_progress` | téléchargement déjà non terminal pour ce modèle |
| `502` | `catalog_resolve_failed` | résolution HF impossible (paquet introuvable/changé) |
| `503` | `models_dir_unwritable` / `downloads_unavailable` | dossier non inscriptible (message exact via `describeWriteFailure`) / câblage |
| `507` | `insufficient_disk_space` | espace disque insuffisant (message avec tailles) |
| `500` | `download_failed` | E/S inattendue |

#### `POST /api/tts/downloads/{catalogId}/cancel`

- **Garde-fous** : `requireWriteGuards`. **Réponses** : `200 { ok, task }` ;
  `403` garde-fous ; `404 unknown_download` ; `409 download_not_active` (déjà
  terminale) ; `503` non câblé. L'id est borné (jamais un chemin).

#### `POST /api/admin/restart` (modifié)

- **Garde-fous** : inchangés. **Nouveau** : si un téléchargement est
  `queued`/`downloading`/`verifying` ⇒ **`409 download_in_progress`**
  (`activeDownload` fourni), **aucun arrêt demandé**. Sinon ⇒ `200` + arrêt
  planifié, **comportement strictement inchangé** (D69).

### 16.4 Garanties du job (telles qu'implémentées)

- **Source fermée** : le client ne fournit qu'un `catalogId` ; l'URL est
  construite côté serveur (anti-SSRF par construction).
- **Destination imposée** : `/models/downloads/<id>/model.gguf`.
- **Atomicité** : écriture dans `model.gguf.part`, puis `rename` **atomique** dans
  le même dossier ; aucun fichier final tronqué.
- **Taille** : le fichier final doit égaler la taille annoncée, sinon `failed`
  (`size_mismatch`) et `.part` supprimé.
- **Intégrité** : SHA-256 calculé en flux ; **vérifié seulement si HF expose
  `lfs.oid`** ; sinon **enregistré** (`sha256`) avec `sha256Verified: false`.
  En cas d'écart ⇒ `failed` (`integrity_mismatch`) et fichier supprimé.
- **Reprise `Range`** : uniquement si un `.part` existe et que le serveur répond
  **`206`** avec une taille `Content-Range` **inchangée** ; sinon on repart de
  zéro. `If-Range` envoyé si un ETag a été mémorisé.
- **Espace disque** : `statfs` du dossier `models` avant démarrage, marge par
  défaut **64 Mio** ; refus `507` avec le détail des tailles.
- **Un seul à la fois** : les autres tâches restent `queued` (file en mémoire).
- **Annulation** : `AbortController` ; la tâche passe `cancelled`, **jamais** `done`.
- **Registre persistant** : `tts-downloads.json` (volume `state`), écriture
  atomique, écrit à chaque transition et **périodiquement** pendant le transfert
  (défaut 1 s). Au démarrage, toute tâche non terminale devient **`interrupted`**
  (le `.part` est conservé pour reprise) — **jamais** `done`.
- **Erreurs honnêtes** : dossier non inscriptible ⇒ `describeWriteFailure`
  (jamais « chown » quand le montage est en lecture seule, etc.).

**Simplifications assumées** :

- **Catalogue `GET` statique** : le nom/taille affichés sont le **repli annoncé à
  la rédaction** ; la **résolution HF vivante** a lieu au **démarrage du
  téléchargement** (source de vérité). Repli documenté si HF est injoignable
  (`sha256` alors **non** prétendu).
- **Pas de SSE** : la progression se lit par `GET /api/tts/downloads` (l'UI
  pollera).
- **Reprise** : le préfixe est **relu** pour un SHA complet (le contexte de
  hachage n'est pas persisté) — coût I/O en plus, jamais un faux positif.
- **Un seul worker, file non bornée** (pas de limite de profondeur type `JobQueue`).
- **Pas de dépendance npm** : `fetch`, `fs`, `crypto` suffisent.

### 16.5 Arbitrage sur le redémarrage

**Décision : REFUS (`409 download_in_progress`)** quand un téléchargement est
actif (y compris seulement `queued`). **Justification** : `POST /api/admin/restart`
tue le processus (exit 75) ; un redémarrage pendant un transfert ferait passer la
tâche en `interrupted` **sans que l'utilisateur l'ait explicitement demandé**, ce
qui est exactement l'ambiguïté que le registre durable sert à éviter. Un refus
explicite et actionnable (« attendez la fin ou annulez ») est plus honnête qu'un
redémarrage silencieux. **Aucun téléchargement actif ⇒ le bouton Redémarrer garde
son comportement d'origine** (test `tests/gateway/restart-api.test.ts`).

### 16.6 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **687 passed / 4 skipped** (avant : 648 passed / 4 skipped ; **+39** : catalogue, job, routes, garde-fou redémarrage) |
| `npm run typecheck` | vert |
| `npm run build` | vert |
| URL `resolve/main/...` (4 paquets) | **HTTP 200**, `x-linked-etag` = SHA-256 LFS |

### 16.7 Non vérifiable sans moteur réel

- **Téléchargement RÉEL** de plusieurs Go (débit Xet, `206`/`If-Range`, reprise
  après `POST /api/admin/restart`). Test court : télécharger **kokoro** (≈ 181 Mio)
  via `POST /api/tts/downloads {"catalogId":"kokoro"}` puis couper/relancer, ou
  `curl -L -o /dev/null --range 0-1048575 <url resolve>`.
- **Chargement effectif** par le moteur du fichier déclaré :
  `docker exec yuki-tts ls -l /models/downloads/<id>/model.gguf`, puis déclarer
  (`prefill`), `docker restart yuki-tts`, puis
  `curl -s http://tts:8081/v1/models`. Non exécuté ici (pas de moteur).

### 16.8 À faire au lot suivant (UI) — **LIVRÉE en §19**

> **Livrée** (Lot 9, étape 3) : la structure de l'onglet Voix en 5 zones, le
> conteneur **`#tts-downloads-root`** (place RÉSERVÉE) **et l'UI complète**
> (catalogue, téléchargement, progression, annulation, déclaration) sont en
> place — voir **§19**. Les points ci-dessous, initialement « à faire », sont
> désormais **implémentés et vérifiés** :

- **Section catalogue** dans `/config` : liste des 4 entrées + `notIncluded`
  (`sanotts`, GPL-3.0), badges « à télécharger » / « téléchargé » / « déclaré »,
  licence et taille (§19.2).
- **Bouton « Télécharger »** (`POST /api/tts/downloads`, en-tête `X-Yuki-Config: 1`).
- **Progression** : poll de `GET /api/tts/downloads` (états, octets, `active`) —
  **uniquement tant qu'une tâche est non terminale** (§19.3).
- **Annulation** (`POST …/{id}/cancel`, confirmation `HolafModal`).
- **« Déclarer ce modèle »** : `prefill` tel quel → éditeur existant
  (`PUT /api/tts/engine-config`), **aucune ressaisie** (§19.4).
- **Redémarrage** : `409 download_in_progress` traité comme une **information**
  (`presentRestartRefusal`, §19.5).
- **Assistant** : l'action manuelle « déposer le fichier » a été **corrigée** pour
  les variantes téléchargeables (§19.6).
- **Cohérence des listes** : la liste `ENGINE_FAMILIES` UI a été corrigée (D66) ;
  vérifier l'affichage `family` ≠ `id` (`qwen3_tts` vs `qwen3-tts`).

### 16.9 `git status --short` (à la fin du lot)

```
 M public/ui/engine-config-patch.js
 M src/gateway/routes/admin.ts
 M src/gateway/routes/tts.ts
 M src/index.ts
 M src/tts/engine-config.ts
 M src/tts/index.ts
 M tests/gateway/restart-api.test.ts
 M tests/tts/engine-config.test.ts
 M tests/ui/engine-config-patch.test.ts
?? src/tts/catalog-data.ts
?? src/tts/downloads.ts
?? tests/integration/tts-downloads.test.ts
?? tests/tts/catalog.test.ts
?? tests/tts/downloads.test.ts
```

---

## 17. Refonte de l'onglet Voix de `/config` (simplification UX)

> **Ajout du 2026-09-23.** Suite directe de §16.8 (« À faire au lot suivant (UI) »).
> Diagnostic validé par l'utilisateur : l'onglet **Voix** contenait **8 zones**,
> **9 boutons fixes** et faisait **≈ 3,5–4 écrans** ; **quatre listes de
> « modèles »** y cohabitaient et **trois choses** s'appelaient « Voix ». Ce lot
> **réorganise l'onglet en 5 zones**, **supprime deux doublons réels** et
> **réserve la place** de l'UI de téléchargement (§16). Les autres onglets
> (Modèles, Conversation, Système, Maintenance) sont **inchangés**.

### 17.1 Structure cible — telle qu'implémentée

Arbre de `#panel-voix` (`public/ui/config.html:139-162`) :

```text
#panel-voix
├── #tts-assistant-root            ← ① VISIBLE  « État de la voix » (bandeau compact)
├── #voices-root                   ← ② VISIBLE  « Ma voix » (sélecteur + liste + cloner)
├── #group-voix                    ← ③ VISIBLE  « Réglages de la voix » (6 essentiels)
│   └── details.config-advanced    ← ④ REPLIÉ   « Avancé » (adresse, exag., CFG, préchargement, découpe, délai)
└── #tts-engine-root               ← ⑤ REPLIÉ   « Moteur TTS et modèles » (zone technique)
```

- **①** = la carte d'état existante de l'assistant, **compactée** (titre « État de
  la voix », bouton « Vérifier le moteur » toujours accessible) — logique
  `describeTtsState`/`statusTechnicalDetails` **inchangée**
  (`public/ui/tts-assistant.js:640-650`).
- **②** = panneau des voix, titre renommé « Ma voix » (`public/ui/voices-panel.js:118`).
- **③** = 6 réglages visibles **sans clic** (`public/ui/config.js:151-197`) :
  `tts.enabled`, `tts.engine`, `tts.language`, `tts.emotion`, `tts.speed`, `tts.volume`.
- **④** = `tts.baseUrl`, `tts.exaggeration`, `tts.cfg`, `tts.prefetchDepth`,
  `tts.minSentenceChars`, `tts.maxSentenceChars`, `tts.timeoutMs`
  (`public/ui/config.js:203-269`, tous marqués `advanced: true`).
- **⑤** = zone **technique/diagnostic** (disque, modèles du moteur, configuration
  du moteur, test, manuel et **[PLACE RÉSERVÉE]** au téléchargement), repliée sous
  un `<details>` (`public/ui/tts-assistant.js:652-691`).

⚠️ **Le rendu reste EAGER** : tous les champs sont construits dans le DOM au
chargement ; les replis sont des `<details class="config-advanced">` qui
**masquent sans retirer**. Aucune sous-navigation ARIA : le contrat des
**5 `role="tab"` / 5 `role="tabpanel"`** est **intact**.

### 17.2 Doublons supprimés / déplacés / renommés

| Élément | Avant | Après | Preuve |
| --- | --- | --- | --- |
| `tts.voice` **champ texte** | champ du groupe « Voix / TTS » | **supprimé** ; le **select** de la bibliothèque est l'unique contrôle | `public/ui/config.js:198-199` (le champ n'est plus dans `fields`) |
| `tts.enabled` **écriture** | select + bouton qui `PUT` **puis redémarre** | **un seul chemin** : l'enregistrement global | `public/ui/config.js:895-910`, `public/ui/tts-assistant.js:1557-1585` |
| Titre du groupe | « Voix / TTS » | « Réglages de la voix » | `public/ui/config.js:151` |
| Panneau voix | « Voix » | « Ma voix » | `public/ui/voices-panel.js:118` |
| Assistant | « Assistant de mise en route de la voix » (tout déplié en tête) | « État de la voix » (①) + « Moteur TTS et modèles » replié (⑤) | `public/ui/tts-assistant.js:645,659` |
| Libellés | « Activation », « Moteur », « Débit (%) », « URL du service TTS », « Prefetch… », « Timeout… », « CFG (pour-mille) » | « Activer la voix », « Moteur de synthèse », « Débit de parole (%) », « Adresse du moteur (avancé) », « Préchargement (phrases d'avance) », « Délai maximal de synthèse (ms) », « Contrôle de guidage (CFG) » | `public/ui/config.js:156-269` |
| « Réinitialiser au défaut » | textarea seulement | **tous** les champs ayant un défaut | `public/ui/config.js:600-625` |

### 17.3 Chemin d'écriture unifié

**`tts.enabled` — UN SEUL écrivain : l'enregistrement global.**

- Le **select** « Activer la voix » (③) est un champ normal : enregistré par le
  bouton **« Enregistrer »** (barre sticky) comme tout le reste.
- Le **bouton du bandeau** (①) n'appelle **plus** `PUT /api/config` ni
  `POST /api/admin/restart`. C'est un **raccourci** : `enableVoiceShortcut()`
  règle le select puis déclenche le **même** `save()`
  (`public/ui/config.js:895-910`, transmis via `requestEnableVoice`,
  `public/ui/config.js:1151`).
- Après enregistrement, l'assistant **guide explicitement** vers le redémarrage
  manuel : « Voix activée et enregistrée. Redémarrez Yuki (onglet Maintenance)
  pour l'appliquer. » (`public/ui/tts-assistant.js:1577-1584`).
  **Plus de redémarrage silencieux déclenché par un bouton.**

**`tts.voice` — UN SEUL contrôle : le select de la bibliothèque.**

- Le champ texte a été retiré ; `voices-panel.js` écrit `tts.voice`
  **immédiatement** (`PUT /api/config`), comme avant, et `onVoiceSelected` ne met
  à jour que l'état local (`public/ui/config.js:1128-1133`). L'ancien libellé
  reste connu pour les messages (`public/ui/config.js:280-282`).
- **Conséquence assumée** : choisir une voix n'apparaît **pas** dans l'indicateur
  global « modifications non enregistrées » — l'écriture est **déjà faite**.

### 17.4 Place réservée au téléchargement (§16) — **LIVRÉE en §19**

Dans la zone **⑤** : un conteneur **`#tts-downloads-root`** (classe
`.tts-downloads`) qui **contient désormais l'UI de téléchargement** (catalogue,
progression, annulation, déclaration) — voir **§19**. Au moment de la refonte, il
était **vide** et commenté « PLACE RÉSERVÉE » ; ce commentaire a été **retiré**
devenu faux (le contenu est livré).

### 17.5 Correctif lié : `[hidden]` désormais effectif

`.config-row { display: flex }` (origine **auteur**) écrasait l'attribut `hidden`
(origine **UA** sans `!important`) : la révélation conditionnelle des curseurs
`exaggeration`/`cfg` (émotion « personnalisée ») était donc **sans effet**
**visuel**, alors que la propriété DOM `hidden` valait bien `true`. Ajout de
`.config-row[hidden] { display: none }` (`public/ui/config.css:93-97`).

### 17.6 Décidé / À confirmer (suite)

#### Acté

| # | Décision | Preuve |
| --- | --- | --- |
| **D71** | **`tts.voice` : suppression du champ texte** du groupe ; le **select de la bibliothèque** (zone ②) est l'**unique contrôle**, écriture **immédiate** (`PUT /api/config`). Le libellé reste connu pour les messages. | `public/ui/config.js:198-199,280-282` ; `public/ui/voices-panel.js` (`setActiveVoice`) |
| **D72** | **`tts.enabled` : un SEUL chemin d'écriture** = l'**enregistrement global**. Le bouton du bandeau est un **raccourci** (aucun `PUT` propre, **aucun redémarrage silencieux**) et **guide** vers l'onglet Maintenance. | `public/ui/config.js:895-910,1151` ; `public/ui/tts-assistant.js:1557-1585` |
| **D73** | **Onglet Voix en 5 zones**, replis par `<details class="config-advanced">` (**classe DISTINCTE** de `tts-details`), **rendu EAGER conservé**, **5 onglets ARIA inchangés**. | `public/ui/config.html:139-162` ; `public/ui/config.js:660-676` ; `public/ui/tts-assistant.js:652-691` |
| **D74** | **« Réinitialiser au défaut » généralisé** à **tous** les champs ayant un défaut (plus seulement les textarea) + affichage « Valeur par défaut : X. » quand `origin === "default"`. Table `FIELD_DEFAULTS` **miroir UI** ; le reset envoie **`null`** au serveur (qui applique son propre défaut). | `public/ui/config.js:284-322,600-625` |
| **D75** | **Place RÉSERVÉE** au téléchargement : conteneur **vide** `#tts-downloads-root`, commenté, **dans la zone ⑤ repliée**. | `public/ui/tts-assistant.js:615-630` |
| **D76** | **Correctif** : `.config-row[hidden] { display: none }` rend **visuellement** effectif le masquage des champs conditionnels (déjà effectif dans le DOM). | `public/ui/config.css:93-97` |

#### À confirmer

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C46** | **`FIELD_DEFAULTS` est un miroir MANUEL** de `src/config/schema.ts` (le navigateur n'a pas accès au schéma). Toute évolution d'un défaut backend doit être répercutée côté UI, sinon « Réinitialiser au défaut » montre une valeur périmée. Alternative non retenue (hors périmètre) : exposer `default` dans `GET /api/config`. | UI / maintenance |
| **C47** | **Deux points de montage pour UN seul assistant** (`#tts-assistant-root` + `#tts-engine-root`) — une seule instance `initTtsAssistant`. À confirmer : acceptable, ou préférer un portail/`display: contents` ? L'E2E interroge désormais `#panel-voix` (portée des deux zones). | UI / E2E |
| **C48** | **Le repli « Avancé » s'ouvre automatiquement** quand une émotion « personnalisée » rend visibles `exaggeration`/`cfg` ; il n'est **jamais refermé** automatiquement (l'utilisateur reste maître). Comportement à confirmer. | UX |

### 17.7 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **692 passed / 4 skipped** (avant ce lot : **687 passed / 4 skipped** ; **+5** : tests de structure UI dans `tests/integration/static-ui.test.ts:392-453`) |
| `npm run typecheck` | vert |
| `npm run build` | vert |
| `node --check` (`config.js`, `tts-assistant.js`, `voices-panel.js`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **54/54** ; **0 violation CSP** ; **0 exception JS** |
| Vérifs E2E ajoutées | zones (① ② ③④ ⑤), 6 essentiels **visibles sans clic**, replis ④/⑤ **repliés par défaut** et **dépliés** avec contenu, `tts.voice` texte **absent**, `#tts-downloads-root` **présent et vide**, `[hidden]` **effectif** |
| Captures | `_tools/shots/config-voix-zones-visible.png` (replié), `config-voix-reglages-essentiels.png` (6 essentiels), `config-voix-zones-avance.png` (④ déplié), `config-voix-zones-technique.png` (⑤ déplié) |

### 17.8 Suite (lot suivant) — **LIVRÉE en §19**

> Les trois points ci-dessous sont désormais **implémentés** (§19) :

- **Boutons de téléchargement** : catalogue (`GET /api/tts/catalog`), `POST /api/tts/downloads`,
  progression par poll (`GET /api/tts/downloads`), annulation, et « Déclarer ce modèle »
  (réutilise la config moteur de ⑤) — montés dans `#tts-downloads-root`.
- **`409 download_in_progress`** au redémarrage (§16.5) : présenté comme une
  **protection**, pas une panne.
- L'action manuelle « déposer le fichier » a été **corrigée** pour les variantes
  du catalogue.

---

## 18. Renvois

- [`docs/lot7.md`](lot7.md) — spécification de référence du TTS (transport, voix, émotion).
- [`docs/lot8.md`](lot8.md) — assistant de mise en route, `server.json` attesté (`§11`), CosyVoice 3 (`§13`).
- [`docs/architecture.md`](architecture.md) — vue d'ensemble, carte des lots.
- [`deploy/server/README.md`](../deploy/server/README.md) — runbook de déploiement (bind `tts-config`).

---

## 19. UI du téléchargement des modèles (Lot 9, étape 3)

> **Ajout du 2026-09-23.** Suite directe de §16 (« backend seul ») et §17
> (« place réservée »). Ce lot **n'ajoute aucun comportement backend** : il
> **consomme** le contrat déjà livré et testé (`GET /api/tts/catalog`,
> `GET/POST /api/tts/downloads`, `POST …/{id}/cancel`, `PUT /api/tts/engine-config`).
> Décisions **D77 → D83**, points ouverts **C49 → C50**.

### 19.1 Fichiers livrés

| Fichier | Rôle |
| --- | --- |
| `public/ui/tts-assistant.js` | Fonctions **pures** (mapping) + UI montée dans `#tts-downloads-root` |
| `public/ui/tts-assistant.css` | Styles `.tts-dl__*` (CSP stricte, variables de thème) |
| `public/ui/config-patch.js` | `presentRestartRefusal` (le `409` n'est pas une panne) |
| `public/ui/config.js` | `activateEngineShortcut` (raccourci « Choisir comme moteur ») + `409` au redémarrage |
| `tests/ui/tts-downloads.test.ts` | **37 tests** de logique pure |
| `tests/ui/config-patch.test.ts` | **+4 tests** pour `presentRestartRefusal` |
| `tests/integration/static-ui.test.ts` | présence de l'UI + garde CSP |
| `Yuki and Libs/_tools/e2e-tts-serve.ts` | téléchargement **simulé** (~2 Ko, jamais de Go) |
| `Yuki and Libs/_tools/e2e-tts-ui.mjs` | parcours E2E complet |

### 19.2 Catalogue et états affichés

Le contenu est **monté dans le conteneur réservé** `#tts-downloads-root`
(`public/ui/tts-assistant.js:878`), dans la zone ⑤ **repliée** — **rien** n'est
remonté au-dessus de la ligne de flottaison.

- **Une ligne par modèle** : libellé, **taille** (`formatBytes`), **licence**,
  variante, et un **badge d'état** (`describeCatalogEntry`, `:176`) :
  `à télécharger` (neutre) / `téléchargé` (avertissement) / `déclaré` (succès).
- **Modèles écartés** (`notIncluded`, ex. `sanotts` GPL-3.0) : affichés dans un
  repli « Moteurs écartés (n) » **avec leur raison**, **sans aucun bouton**
  (`describeNotIncluded`, `:261` ; `renderExcluded`).
- **Boutons contextuels** (`catalogAction`, `:216`) :
  `Télécharger` / `Réessayer` → `Déclarer ce modèle` → `Choisir comme moteur`,
  ou `Annuler` pendant un transfert. Un téléchargement en cours **désactive** les
  boutons des autres lignes (« Un téléchargement est déjà en cours. »).
- **États d'une tâche** (`describeDownloadStatus`, `:126`), tels qu'affichés :
  `queued`→« En attente », `downloading`→« Téléchargement… », `verifying`→« Vérification… »,
  `done`→« Téléchargé », `failed`→« Échec », `cancelled`→« Annulé »,
  **`interrupted`→« Interrompu »** (tonalité **erreur**, jamais un succès, avec
  « Réessayer »).

### 19.3 Progression et poll

- **Barre native `<progress>`** (`buildProgress`, `:1680`) : `role="progressbar"`
  **implicite**, `aria-label` + `aria-valuetext` en français, **aucun `style=`**
  (la largeur vient de `value`/`max`). Sans total connu, barre **indéterminée**
  (aucun pourcentage inventé).
- **Octets/total + pourcentage** (`downloadProgress`, `:151`) ; **pas d'ETA promise**.
- **Poll `GET /api/tts/downloads` seulement tant qu'une tâche est non terminale**
  (`shouldPollDownloads`, `:279` ; intervalle `TTS_DOWNLOAD_POLL_MS = 1000`, `:58`).
  Le `POST` répond en millisecondes (il **démarre** la tâche) : **aucune requête
  longue**. À l'arrêt du transfert, le poll **s'arrête** et le catalogue est
  rechargé **une fois** (badge → « Téléchargé »).
- **Survie au rechargement** : `refresh()` (`:2040`) recharge catalogue + tâches ;
  la tâche la plus **fraîche** vient de `GET /api/tts/downloads`
  (`renderCatalog`, `:1804`) — l'UI **reprend l'affichage** au lieu de croire
  qu'il ne se passe rien.

### 19.4 Parcours clic par clic (télécharger → déclarer → activer)

1. Ouvrir `/config` → onglet **Voix** → déplier **« Moteur TTS et modèles »** (zone ⑤).
2. Dans **« Télécharger un modèle »**, chaque ligne affiche taille + licence + badge.
   Cliquer **« Télécharger »** → `POST /api/tts/downloads` (`X-Yuki-Config: 1`).
   Le poll prend le relais : **progression** (barre + « 847 o / 2.1 Ko — 38 % »).
   On peut **« Annuler »** (confirmation `HolafModal`) ; l'annulation **conserve le
   fichier partiel** pour reprise.
3. À `done`, le badge passe à **« Téléchargé »** et le bouton devient
   **« Déclarer ce modèle »** : il pousse **le `prefill` du catalogue** dans le
   **brouillon de l'éditeur existant** puis appelle `saveEngineConfig()`
   (`declareCatalogEntry`, `:1951`) — **la validation n'est pas réimplémentée**,
   aucune ressaisie. La confirmation est `HolafModal`.
4. Après déclaration, le badge passe à **« Déclaré »** et le bouton devient
   **« Choisir comme moteur »** : `activateCatalogEntry` (`:1991`) →
   `requestActivateEngine` → `activateEngineShortcut` (`public/ui/config.js:922`)
   règle `tts.engine` puis passe par **l'enregistrement global** (même patron que
   `requestEnableVoice`). Le message rappelle qu'il faut **redémarrer le conteneur
   `tts`** (le gateway n'a pas accès à Docker).

### 19.5 `409 download_in_progress` au redémarrage

`POST /api/admin/restart` répond `409` tant qu'un téléchargement est actif
(§16.5). L'UI ne le présente **pas** comme un bug : `presentRestartRefusal`
(`public/ui/config-patch.js:227`) renvoie une **information** (sans préfixe
« Échec »), reprise par `requestGatewayRestart` (`public/ui/config.js:1025`).
Message affiché (exact, du serveur) :

> « Un téléchargement de modèle est en cours : redémarrer maintenant l'interromprait.
> Attendez la fin du téléchargement ou annulez-le, puis redémarrez. »

Le **raccourci de l'assistant** (bouton « Onglet Maintenance ») mène au **même**
flux : le redémarrage reste centralisé dans `config.js`.

### 19.6 Bloc « Ce qui reste à faire à la main » — corrigé

Le bloc (`public/ui/tts-assistant.js`, `buildManualSection`) dit désormais
**exactement** :

- **Nouveau/faux** : « déposer le fichier du modèle » n'est **plus** nécessaire
  pour les **4 variantes du catalogue** (téléchargeables ici).
- **Toujours vrai** : (1) **démarrer/redémarrer** le conteneur `tts` (hors Yuki,
  pas d'accès Docker) ; (2) le dépôt manuel reste la **seule** voie pour un
  **moteur hors catalogue** (p. ex. `sanotts`, GPL-3.0) ou un GGUF personnel.

Messages corrigés en cohérence : `describeModelsDir` (« vide ») et
`appendDiskModels` plus le paragraphe « Le fichier du modèle doit être présent… »
ne disent plus « déposez-le pour l'instant » / « arrivera à l'étape suivante ».

### 19.7 Décidé / À confirmer (suite)

#### Acté

| # | Décision | Preuve |
| --- | --- | --- |
| **D77** | UI livrée **dans le conteneur réservé** `#tts-downloads-root` (zone ⑤), classes **dédiées** `.tts-dl__*`, barre `<progress>` **native** (aucun `style=`). | `public/ui/tts-assistant.js:878,1680` ; `public/ui/tts-assistant.css` |
| **D78** | **Poll `GET /api/tts/downloads` seulement tant qu'une tâche est non terminale**, intervalle 1 s ; arrêt net sinon. | `shouldPollDownloads` `:279` ; `TTS_DOWNLOAD_POLL_MS` `:58` ; `loadDownloads` `:1869` |
| **D79** | **« Déclarer ce modèle »** pousse le **`prefill`** dans le brouillon de l'éditeur **existant** puis `saveEngineConfig()` — validation **non réimplémentée**. | `declareCatalogEntry` `:1951` |
| **D80** | **« Choisir comme moteur »** = raccourci `requestActivateEngine` → `tts.engine` écrit par **l'enregistrement global**. | `activateCatalogEntry` `:1991` ; `public/ui/config.js:922,1170` |
| **D81** | **`409 download_in_progress`** au redémarrage présenté comme une **information** (pas une panne), message serveur repris. | `presentRestartRefusal` `public/ui/config-patch.js:227` ; `public/ui/config.js:1025` |
| **D82** | **`interrupted` n'est jamais un succès** : badge « Interrompu » (erreur) + « Réessayer ». | `describeDownloadStatus` `:126` |
| **D83** | Bloc « à la main » **corrigé** : dépôt manuel **plus** requis pour les variantes du catalogue, **reste vrai** hors catalogue. | `buildManualSection` (tts-assistant.js) ; `describeModelsDir` |
| **D84** | **Correctif du bug « Déclarer » (famille écrasée) + garde-fou famille ↔ fichier.** La déclaration part d'une base **AUTORITAIRE côté serveur** (`draftFromReport`) et applique le `prefill` **par `id`** (`applyCatalogPrefill`) ; l'enregistrement écrit CE brouillon **sans relecture DOM** (`saveEngineConfig({capture:false})`). Édition par entrée via `setModelField` (nouveau tableau, **aucune référence partagée**). Garde-fou serveur : un `path` **du catalogue** impose sa `family`/`task`/`mode` (400 sinon) ; un chemin **inconnu** reste libre. | `declareCatalogEntry` `public/ui/tts-assistant.js` ; `applyCatalogPrefill`/`setModelField` `public/ui/engine-config-patch.js` ; `checkCatalogCoherence` `src/tts/engine-config.ts` |
| **D85** | **Élargissement du garde-fou D84 aux chemins MANUELS + signalement dans l'éditeur.** Le catalogue est indexé par chemin exact, dossier de téléchargement, **basename** de fichier (casse libre) et nom de dossier : un `path` reconnu impose sa `family`/`task`/`mode` (`400` sinon). Chemin/dossier **inconnu** libre. `GET /api/tts/engine-config` expose `coherenceIssues` par entrée (affiché sur la ligne, **avant** enregistrement) ; le garde-fou ne porte que sur le **patch entrant**, une config **déjà** cassée reste réparable. La cause d'origine de l'écriture fautive reste **non reproduite** (constat honnête). | `checkCatalogCoherence`/`catalogSpecForPath`/`isModelPathShape` `src/tts/engine-config.ts` ; `coherenceIssues` `report()` ; `renderModelRows` `public/ui/tts-assistant.js` ; §21 |
| **D86** | **Piste « index dérivé du DOM » TRANCHÉE (fausse) + durcissement structurel + refus côté client + instrumentation.** L'éditeur n'utilise **AUCUN** index de position DOM : « Moteur actif (tts.engine) » est un **badge** `h("span")` **dans** la carte du modèle dont `id === engine`, pas une carte en plus ; `modelRowRefs`/`captureEngineDraft` sont **supprimés** (édition par entrée via `setModelField`, globales via `captureGlobals`) ; la déclaration cible par `id` (`applyCatalogPrefill`). **Refus côté client** (`findCatalogFamilyIncoherence`, miroir du garde-fou serveur) : un patch dont une `family` ne correspond pas au `path` reconnu n'est **pas envoyé**. Instrumentation : en-tête `x-yuki-config-flow` + journal `tts.engine_config.write`. | `renderModelRows`/`saveEngineConfig` `public/ui/tts-assistant.js` ; `findCatalogFamilyIncoherence` `public/ui/engine-config-patch.js` ; `configWriteFlow` `src/gateway/routes/config.ts` ; `handleEngineConfigPut`/`handleEngineConfigRevert` `src/gateway/routes/tts.ts` ; §22 |
| **D87** | **`cancelRequested` est un état TRANSITOIRE.** Après une annulation, l'identifiant restait dans l'ensemble `cancelRequested` : un **nouveau** téléchargement du même modèle était mis en file puis abandonné au premier tour de `runTask` → la tâche restait `queued` **indéfiniment**. `start()` nettoie désormais l'entrée. | `TtsDownloadManager.start` `src/tts/downloads.ts:425` ; `runTask` `:595` ; test `tests/tts/downloads.test.ts` |
| **D88** | **Durée de clonage élargie à 30 s, taille à 6 Mo (couple cohérent).** Le moteur **ne rejette pas** les références longues : il **tronque** le prompt fin à **10 s** (prompt mel S3Gen, `DEC_COND_LEN`) et **6 s** (tokens de prompt T3, `ENC_COND_LEN`), mais calcule l'embedding d'identité (VoiceEncoder) sur **toute** la référence. 30 s est donc un choix de **confort** (au-dessus de 20 s), et `MAX_VOICE_BODY_BYTES` passe à **6 Mo** pour que 30 s **stéréo** 48 kHz 16 bits (≈ 5,76 Mo) reste atteignable. Messages de refus nomment **limite**, **valeur reçue**, **valeur autorisée** + sortie. §23. | `MAX_VOICE_DURATION_SECONDS` `src/tts/wav.ts` ; `MAX_VOICE_BODY_BYTES` `src/tts/voices-store.ts` ; `conditionals.h:13-14`/`conditionals.cpp` (amont) ; `src/chatterbox/tts.py:107-194` ; tests `tests/tts/wav.test.ts`/`tests/integration/voices-api.test.ts` ; UI `public/ui/voices-panel.js` ; §23 |

#### À confirmer

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C49** | Le **catalogue `GET` est statique** (taille/licence au repli documentaire) : l'écart éventuel avec Hugging Face n'est connu qu'à la **résolution** (démarrage du transfert) et n'est pas réaffiché dans la ligne. | UI / honnêteté |
| **C50** | **« Choisir comme moteur » n'exige pas de redémarrer le gateway** (écriture à chaud) mais **exige** de redémarrer le conteneur `tts` ; le message le dit sans le **forcer** (pas de blocage). À confirmer : faut-il proposer un rappel persistant tant que `tts.engine` a changé ? | UX |
| **C51** | **Strictness du garde-fou pour les VARIANTES** : depuis D84, remplacer le fichier d'un chemin de catalogue par une variante à `task` différent (ex. Qwen `VoiceDesign` → `vdes`) est REFUSÉ tant que l'entrée ne suit pas le catalogue. À confirmer : assouplir `task` (garder `family`/`mode` stricts, la famille étant embarquée dans le GGUF) ? | UI / honnêteté |
| **C52** | **Cause d'origine de l'entrée famille-écrasée NON reproduite** avec le code HEAD (D84 avait écarté la propagation inter-lignes ; D85 refuse et signale désormais l'état). Reste incertain : identifier l'écrivain historique fautif (état hérité d'une version antérieure au garde-fou). | Honnêteté / diagnostic |
| **C53** | **L'écrivain historique exact reste inconnu** : la piste « index de position DOM » est **écartée** (§22.2, preuve par lecture) et deux reproductions du parcours réel ont échoué. La prochaine occurrence est désormais **capturable** par le journal `tts.engine_config.write` (flux + patch) — sans quoi on ne pourra trancher entre « ancienne version » et un chemin non encore envisagé. | Honnêteté / diagnostic |
| **C54** | **Gain QUALITATIF d'une référence > 10 s non mesuré.** Au-delà de 10 s, le prompt fin est **tronqué** ; seule la passe VoiceEncoder voit la référence complète. On ne peut donc pas affirmer ici qu'un clip de 20 s rend un meilleur clonage qu'un clip de 10 s (ni l'inverse) : non vérifiable **sans le moteur réel** (GPU). | Honnêteté / qualité |

### 19.8 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **736 passed / 4 skipped** (avant ce lot : **692 passed / 4 skipped** ; **+44** : 37 logique pure, 4 `presentRestartRefusal`, 3 structure UI) |
| `npm run typecheck` | vert |
| `npm run build` | vert |
| `node --check` (`tts-assistant.js`, `config.js`, `config-patch.js`, `e2e-tts-ui.mjs`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **68/68** ; **0 violation CSP** ; **0 exception JS** |
| Vérifs E2E ajoutées | catalogue (4 modèles + taille/licence), badges « à télécharger », écartés sans bouton, démarrage, **progression** (barre native + octets/total), **reprise après rechargement**, `done` → « Déclarer », modale puis **déclaré**, « Choisir comme moteur » (`tts.engine = kokoro`), **`409` au redémarrage**, annulation + « Réessayer » |
| Captures | `_tools/shots/config-voix-zones-technique.png` (zone ⑤ dépliée **avec le catalogue**), `config-voix-downloads-progress.png` (progression), `config-voix-downloads-declare.png` (déclaré) |

> **Mise à jour après le correctif D84 (§20)** : `npm test` = **751 passed / 4
> skipped** (+15) ; E2E = **71/71** ; **0 violation CSP** ; **0 exception JS** ;
> `typecheck`/`build` verts ; `node --check` OK.

### 19.9 Non vérifiable sans un VRAI téléchargement de plusieurs Go

- **Débit Xet, `206`/`If-Range`, reprise après `POST /api/admin/restart`** sur un
  **vrai** paquet (`kokoro` ≈ 181 Mio). L'E2E ne sert que ~2 Ko **simulés** : il
  prouve le CÂBLAGE UI, pas le transfert réel (déjà couvert côté backend par
  `tests/tts/downloads.test.ts`).
- **Chargement effectif** par le moteur du fichier déclaré.

Commande de vérification courte à faire jouer à l'utilisateur (dans le conteneur
**gateway**, une fois `tts` démarré) :

```bash
# 1) télécharger un petit modèle (kokoro, ~181 Mio) puis suivre l'état
curl -s -X POST http://localhost:8080/api/tts/downloads \
  -H 'content-type: application/json' -H 'x-yuki-config: 1' \
  -d '{"catalogId":"kokoro"}'
watch -n1 'curl -s http://localhost:8080/api/tts/downloads | head -c 400'
# 2) déclarer puis redémarrer le moteur et vérifier sa liste de modèles
docker restart yuki-tts
curl -s http://tts:8081/v1/models
```

### 19.10 `git status --short` (UI, à la fin du lot)

```
 M public/ui/config-patch.js
 M public/ui/config.js
 M public/ui/tts-assistant.css
 M public/ui/tts-assistant.js
 M tests/integration/static-ui.test.ts
 M tests/ui/config-patch.test.ts
?? tests/ui/tts-downloads.test.ts
 M "Yuki and Libs/_tools/e2e-tts-serve.ts"
 M "Yuki and Libs/_tools/e2e-tts-ui.mjs"
?? "Yuki and Libs/_tools/shots/config-voix-downloads-declare.png"
?? "Yuki and Libs/_tools/shots/config-voix-downloads-progress.png"
```

## 20. Correctif — bug « Déclarer » (famille écrasée) et garde-fou famille ↔ fichier

> **Signalement production.** Après avoir téléchargé Qwen via la nouvelle UI et
> cliqué « Déclarer ce modèle », `models[]` contenait un `chatterbox` dont la
> `family` valait `qwen3_tts` (faux), si bien que le moteur refusait de démarrer :
> `audiocpp_server failed: GGUF embeds model spec for family 'chatterbox', not
> 'qwen3_tts'`. C'est le premier défaut de l'UI qui casse le démarrage du moteur.

### 20.1 Cause et hypothèses écartées

`declareCatalogEntry` cible déjà la bonne entrée **par `id`**
(`engineDraft.models.some((m) => m.id === prefill.id)`) ; les trois pistes du
signalement ont été vérifiées par reproduction (Chromium headless + gateway
RÉEL `_tools/e2e-tts-serve.ts`) :

- **Flux « Déclarer »** : le `prefill` du catalogue est correct
  (`catalogItemView`, `src/gateway/routes/tts.ts:1166`) et vise l'`id` du
  catalogue — **écarté** comme cause directe.
- **Rendu de la liste** : chaque rangée a SES `<select>` (`selectInput`), aucune
  référence partagée ; modifier la famille d'une ligne ne touche pas les autres
  (vérifié en navigateur) — **écarté**.
- **Sérialisation** : `buildEnginePatch` construit **par entrée** (`id`, `family`,
  `task`, `mode`, `path`) — **écarté** comme régression.

Le seul chemin par lequel une déclaration pouvait écrire une valeur d'une AUTRE
entrée était le fait que `declareCatalogEntry` repartait d'un
`captureEngineDraft()` (relecture du DOM de TOUTES les rangées) avant de
`saveEngineConfig()` : le patch persistait alors l'état DOM de **toutes** les
entrées. Le correctif supprime cette dépendance : la déclaration ne peut plus
propager la valeur d'une ligne à l'autre.

### 20.2 Correctif (UI)

| Changement | Fichier |
| --- | --- |
| `applyCatalogPrefill(models, prefill)` : cible l'entrée de **même `id`** (mise à jour, sinon ajout), renvoie un **nouveau tableau**, préserve les clés inconnues | `public/ui/engine-config-patch.js` |
| `setModelField(models, index, field, value)` : édite **UNE** entrée (nouveau tableau, aucune référence partagée) | `public/ui/engine-config-patch.js` |
| `declareCatalogEntry` : base **autoritaire serveur** (`draftFromReport`) + `applyCatalogPrefill`, puis `saveEngineConfig({capture:false})` (aucune relecture DOM) | `public/ui/tts-assistant.js` |
| Changement de famille → correction du mode via `setModelField` (par entrée) | `public/ui/tts-assistant.js` |

### 20.3 Garde-fou serveur (défense en profondeur)

`EngineConfigStore` indexe désormais le catalogue par **chemin de
téléchargement moteur** (`downloadEnginePath(id)`) et, à chaque `PUT
/api/tts/engine-config`, croise le `path` de chaque entrée :

- **chemin reconnu dans le catalogue** ⇒ `family`, `task` et `mode` doivent
  correspondre à ceux du catalogue, sinon **`400 invalid_engine_config`** ;
- **chemin inconnu** (GGUF personnel, moteur hors catalogue) ⇒ **LIBRE**, aucune
  contrainte (cas légitime, prouvé par test).

Portée EXACTE : **seuls** les chemins `/models/downloads/<id>/model.gguf` du
catalogue fermé sont contraints. Le contrôle est appliqué au **patch entrant**
(`applyPatch`), **pas** à la lecture (`validateEngineConfig`) : un `server.json`
déjà incohérent reste **corrigeable** depuis l'éditeur (aucun `422
config_invalid`).

Message exact (exemple du cas production, `models[0]`) :

> L'entrée models[0] « chatterbox » pointe le chemin
> « /models/downloads/qwen3-tts/model.gguf », qui est celui du modèle de
> catalogue « qwen3-tts » : sa famille doit être « qwen3_tts », or elle est
> déclarée « chatterbox ». Corrigez la famille (choisissez « qwen3_tts ») ou le
> chemin (ce fichier ne correspond pas à cette famille).

Preuve : `checkCatalogCoherence` `src/tts/engine-config.ts` ; tests
`tests/tts/engine-config.test.ts` (unitaire),
`tests/integration/tts-engine-config.test.ts` (HTTP réel : refus chemin du
catalogue, acceptation chemin inconnu, correction d'un fichier cassé).

### 20.4 Tests

| Vérification | Résultat |
| --- | --- |
| `npm test` | **751 passed / 4 skipped** (avant : **736 / 4** ; **+15** : 6 `engine-config-patch` par entrée, 6 intégration garde-fou, 3 `EngineConfigStore`) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check` (`tts-assistant.js`, `engine-config-patch.js`, `e2e-tts-ui.mjs`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **71/71** ; **0 violation CSP** ; **0 exception JS** |
| Vérif E2E ajoutée | déclarer Chatterbox (téléchargé) avec `cosyvoice3` + `kokoro` pré-déclarés : les deux entrées restent **inchangées** ; le garde-fou refuse `family = qwen3_tts` sur le chemin catalogue de chatterbox (`400` clair) |

### 20.5 Réparer une config cassée (consigne utilisateur)

Dans `/config`, onglet **Voix** → zone ⑤ → **Configuration du moteur** :

1. repérer l'entrée dont la **Famille** ne correspond PAS au fichier (celle qui a
   déclenché `GGUF embeds model spec for family '…', not '…'`) ;
2. remettre la famille **du fichier** — ex. pour `/models/chatterbox-q8_0.gguf`,
   **Famille = `chatterbox`** (et non `qwen3_tts`) ; garder `task = clon`,
   `mode = offline` ;
3. laisser l'entrée Qwen (`id = qwen3-tts`, `family = qwen3_tts`, `task = tts`,
   `path = /models/downloads/qwen3-tts/model.gguf`) telle quelle ;
4. **Enregistrer la configuration du moteur**, puis **redémarrer le conteneur
   `tts`** (seul le moteur relit `server.json`, à son démarrage).

En CLI (hôte) : éditer `server.json` (sauvegarde `server.json.bak` déjà présente)
et corriger le `family` de l'entrée fautive, puis `docker restart yuki-tts`.

## 21. Lacune du garde-fou D84 (chemins du catalogue seulement) — élargissement aux chemins manuels

> **Signalement production PERSISTANT.** Malgré D84, le moteur refuse toujours de
> démarrer :
> `audiocpp_server failed: GGUF embeds model spec for family 'chatterbox', not
> 'qwen3_tts'`.
> Une entrée `models[]` déclare `family: "qwen3_tts"` alors que son `path`
> (`/models/chatterbox-q8_0.gguf`) pointe un GGUF de **Chatterbox** déposé **à la
> main**. Le fichier existe, la famille est fausse.

### 21.1 Pourquoi D84 ne l'a pas détectée

Le garde-fou `checkCatalogCoherence` (`src/tts/engine-config.ts`) n'indexait le
catalogue QUE par **chemin de téléchargement exact**
(`downloadEnginePath(id)` = `/models/downloads/<id>/model.gguf`). Un `path`
**manuel** (`/models/chatterbox-q8_0.gguf`) n'était donc **jamais** reconnu ⇒
aucun contrôle ⇒ la config invalide passait, et l'échec n'apparaissait qu'au
**démarrage du moteur**. **Lacune confirmée par lecture** : la portée de D84 était
volontairement limitée aux chemins de téléchargement (voir §20.3).

### 21.2 Élargissement (D85)

Le catalogue est désormais indexé de QUATRE façons (`EngineConfigStore`) :

1. **chemin de téléchargement exact** (`/models/downloads/<id>/model.gguf`) — D84 ;
2. **dossier de téléchargement** (`/models/downloads/<id>`) ;
3. **basename de fichier** (`chatterbox-q8_0.gguf`, `cosyvoice3-q8_0.gguf`,
   `qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf`, `kokoro-82m-q8_0.gguf`), **casse
   libre** (`Chatterbox-Q8_0.GGUF`) ;
4. **nom de dossier** (`<id>` ou dossier amont, p. ex. `Chatterbox-GGUF`).

Dès qu'un `path` est reconnu, `family`/`task`/`mode` doivent correspondre au
catalogue, sinon **`400 invalid_engine_config`**. Un chemin **inconnu** (GGUF
personnel, moteur hors catalogue) et un **dossier inconnu** restent **LIBRES**.

La validité de forme du `path` accepte aussi un **dossier** (nom sans extension
de fichier, y compris versionné à points `Qwen3-…-1.7B-…`) en plus du fichier
`*.gguf` (casse libre) — miroir UI `isModelPathShape`.

Message exact FR (exemple du cas production, `models[0]`) :

> L'entrée models[0] « chatterbox » pointe le chemin
> « /models/chatterbox-q8_0.gguf », reconnu comme le fichier
> « chatterbox-q8_0.gguf » du modèle de catalogue « chatterbox » : sa famille doit
> être « chatterbox », or elle est déclarée « qwen3_tts ». Corrigez la famille
> (choisissez « chatterbox ») ou le chemin (ce fichier ne correspond pas à cette
> famille).

### 21.3 Signalement dans l'éditeur (zone ⑤) et réparation

`GET /api/tts/engine-config` expose, **par entrée**, `coherenceIssues` (vide =
rien à signaler). L'éditeur affiche, **sur la ligne concernée** (`.tts-engine-config__coherence`)
et **avant tout enregistrement**, « Configuration enregistrée incohérente — … »,
plus un bandeau de synthèse. Le garde-fou porte sur le **patch ENTRANT**
uniquement : une config **déjà** incohérente reste **éditable et réparable**
(prouvé par test unitaire, intégration HTTP et E2E).

`GET /api/tts/status` expose `declaredModelCount` / `declaredModelsIncoherent` :
la zone ① (moteur injoignable) ajoute alors une **piste** (« N modèles sont
déclarés… vérifiez la Configuration du moteur ») — **jamais** une cause affirmée.

### 21.4 Audit des écrivains de `family` (honnêteté)

Recensement et verdict (aucune écriture incohérente **silencieuse** trouvée) :

| Écrivain | Fichier | Verdict |
| --- | --- | --- |
| `draftFromReport` | `tts-assistant.js` | copie la valeur **serveur** (lecture seule) |
| `captureEngineDraft` | `tts-assistant.js` | relit les `<select>` (valeurs de la liste fermée) |
| `<select>` famille | `tts-assistant.js` | options = `ENGINE_FAMILIES` (jamais hors liste) |
| changement de famille → mode | `tts-assistant.js` (`setModelField`) | édite **une** entrée (nouveau tableau) |
| `applyCatalogPrefill` | `engine-config-patch.js` | `family` = **celle du catalogue** (pré-remplissage serveur) |
| `declareCatalogEntry` | `tts-assistant.js` | base serveur + `prefill` par `id`, `saveEngineConfig({capture:false})` |
| `buildEnginePatch` | `engine-config-patch.js` | sérialise le brouillon tel quel (par entrée) |
| `validateModelDraft` | `engine-config-patch.js` | refuse hors liste ; le serveur re-vérifie |
| `applyPatch` | `engine-config.ts` | validation + garde-fou catalogue : une incohérence ⇒ `400` |
| `validateEngineConfig` / `checkCatalogCoherence` | `engine-config.ts` | **lecture** seule |

**Cause d'origine (honnêteté)** : la reproduction du chemin d'écriture exact qui a
produit l'entrée cassée de l'utilisateur **n'a toujours pas été obtenue** avec le
code HEAD (D84 avait écarté la propagation inter-lignes). Ce lot **constate** que
la config fautive (chemin manuel) était **acceptée sans contrôle** — c'est
désormais **refusé** et **signalé**. On ne prétend pas avoir identifié l'écrivain
fautif d'origine.

### 21.5 Tests

| Vérification | Résultat |
| --- | --- |
| `npm test` | **768 passed / 4 skipped** (avant : **751 / 4** ; **+17** : 9 `EngineConfigStore` chemins manuels, 4 intégration, 3 `describeTtsState`, 1 `describeEngineConfig`) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check` (`tts-assistant.js`, `engine-config-patch.js`, `e2e-tts-ui.mjs`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **75/75** ; **0 violation CSP** ; **0 exception JS** |
| Vérifs E2E ajoutées | chemin **manuel** reconnu (basename) incohérent ⇒ `400` ; chemin **inconnu** ⇒ `200` ; config **déjà** incohérente ⇒ **signalée** dans l'éditeur **et** **réparée** |

### 21.6 Correctif à appliquer par l'utilisateur

Dans `/config`, onglet **Voix** → zone ⑤ → **Configuration du moteur**, l'entrée
fautive est désormais **surlignée** (« Configuration enregistrée incohérente —
… »). Corriger l'entrée :

```json
{
  "id": "chatterbox",
  "family": "chatterbox",
  "task": "clon",
  "mode": "offline",
  "path": "/models/chatterbox-q8_0.gguf"
}
```

Puis **Enregistrer la configuration du moteur** et **redémarrer le conteneur
`tts`**. Le `family` doit être `chatterbox` (le fichier `chatterbox-q8_0.gguf`
embarque la famille `chatterbox`), **jamais** `qwen3_tts`.

## 22. Stabilisation après session interrompue — piste DOM tranchée, durcissement, instrumentation

> Une session précédente a été **interrompue (timeout)** et son rapport n'est
> jamais arrivé. Le bug de production **persiste** (une entrée `chatterbox` a
> hérité de la famille `qwen3_tts` du moteur actif). Ce lot **établit l'état**,
> **tranche la piste principale** et **pose un piège de diagnostic**.

### 22.1 État de l'arbre (reprise)

La session interrompue avait produit un travail **complet et vert**, conservé
tel quel :

- **D85** (garde-fou famille ↔ fichier étendu aux chemins manuels, `coherenceIssues`) ;
- le **durcissement du brouillon par entrée** (`captureEngineDraft`/`modelRowRefs` supprimés) ;
- le **correctif `cancelRequested`** (D87) ;
- la **régression E2E D86** (parcours complet vérifié à chaque étape).

Chiffres réels : `npm test` = **781 passed / 4 skipped** (baseline 768) ;
`npm run typecheck` et `npm run build` **verts** ; `node --check` OK ; E2E
`_tools/e2e-tts-ui.mjs` = **80/80**, **0 violation CSP**, **0 exception JS**.
Les scripts de repro temporaires (`_tools/_repro*-tts-tmp.mjs`) et les PNG
régénérés ont été retirés/restaurés (tree propre).

### 22.2 Piste principale TRANCHÉE : l'index dérivé du DOM est FAUSSE

**Verdict : faux.** Il n'existe **aucun** index de position DOM dans l'éditeur.

Preuves par lecture (`fichier:ligne`) :

1. La « carte supplémentaire » évoquée n'existe pas : « Moteur actif
   (tts.engine) » est un **badge** (`h("span", …)`) **dans** la carte du modèle
   dont `id === engine` — une seule carte est rendue par entrée
   (`public/ui/tts-assistant.js:1339`, dans la boucle `forEach((model, index)`).
2. Dans la version historique, `modelRowRefs` n'était poussé qu'**une fois par
   ligne de modèle**, dans l'ordre du `forEach` ; `captureEngineDraft` le
   `map`-ait ⇒ l'index DOM **égalait** l'index du tableau (aucun décalage). Le
   badge ne pousse rien.
3. Recherche exhaustive : **aucun** `data-index`, `indexOf`, `childNodes`,
   `children[...]`, `selectedIndex`, `parentNode`/`closest` servant à dériver un
   index vers `models[]`.

Le durcissement D86 **supprime même** cette relecture DOM (voir §22.3) : le
chemin d'écriture croisée est désormais **structurellement impossible**.

### 22.3 Durcissement structurel (D86)

- **Édition par entrée** : chaque contrôle écrit UNIQUEMENT le champ de SON
  entrée (`setField` → `setModelField`, nouveau tableau, aucune référence
  partagée) ; `selectInput` reçoit un `onChange` **par ligne**
  (`public/ui/tts-assistant.js:1339,1345,1178`). Les **globales** passent par
  `captureGlobals` (`:1214`) — plus **aucune** relecture DOM des `models[]`.
- **Enregistrement fidèle au brouillon** : `saveEngineConfig` lit `engineDraft`
  (`:1636`) ; la déclaration cible par `id` (`applyCatalogPrefill`).
- **Refus côté client** (avant l'aller-retour) : `findCatalogFamilyIncoherence`
  (`public/ui/engine-config-patch.js:317`) indexe le catalogue comme le serveur
  (chemin exact, dossier de téléchargement, basename casse libre, nom de dossier
  amont) et, dans `saveEngineConfig` (`:1661`), **n'envoie pas** un patch dont
  une entrée a une `family` incohérente avec un `path` reconnu. Message exact
  affiché (statut d'erreur de l'éditeur, section « Erreurs de validation ») :

  > **Enregistrement refusé : une entrée a une famille incohérente avec son
  > fichier. Corrigez la famille (ou le chemin) de la ligne signalée, puis
  > enregistrez.**

  Un chemin **inconnu** (GGUF personnel / moteur hors catalogue) reste **libre**,
  comme côté serveur. Sans catalogue chargé, le serveur garde la main.

### 22.4 Instrumentation (piège de diagnostic en production)

Objectif : si l'entrée famille-écrasée se reproduit, les logs diront **quelle
action** l'a écrite et **avec quel contenu**.

- **En-tête de flux** : `x-yuki-config-flow` (assaini, borné ; valeur de repli
  `unspecified` si absent → **compatibilité** préservée). Côté client, chaque
  écriture le transmet explicitement :
  `engine-editor-save`, `declare-model`, `revert-engine-config` (éditeur du
  moteur), `activate-engine`, `enable-voice`, `config-save` (enregistrement
  global `/api/config`).
- **Journal serveur** : chaque écriture de `server.json` émet
  `tts.engine_config.write` avec `flow`, `action` (`put`/`revert`), `result`
  (`accepted`/`refused`/`invalid_json`), le `code` de refus, et le **patch borné**
  (`modelCount`, jusqu'à 32 entrées `{id, family, task, mode, path}`, `globalKeys`)
  — `src/gateway/routes/tts.ts:1094,1123,1162`. `/api/config` ajoute `flow` à
  `config.changed` (`src/gateway/routes/config.ts`).
- **Où lire les logs** : `docker compose logs gateway` (une ligne JSON par
  écriture). Exemple :
  ```json
  {"ts":"…","level":"info","msg":"tts.engine_config.write","flow":"declare-model","action":"put","result":"accepted","modelCount":4,"models":[{"id":"chatterbox","family":"qwen3_tts","path":"/models/chatterbox-q8_0.gguf"}, …]}
  ```
- **Ce que l'utilisateur doit nous envoyer** si le bug se reproduit : la (les)
  ligne(s) `tts.engine_config.write` (et `config.changed`) autour de l'incident,
  avec le champ `flow` et le tableau `models` — c'est la **trace de l'écrivain**.

### 22.5 Bug prérequis `cancelRequested` (D87)

`cancel()` ajoutait l'identifiant à `cancelRequested` **sans jamais le retirer**.
Un **nouveau** téléchargement du même modèle était mis en file puis abandonné dès
la première ligne de `runTask` (`src/tts/downloads.ts:595`) → tâche bloquée
`queued` **indéfiniment**. `start()` nettoie désormais l'entrée
(`src/tts/downloads.ts:431`). Test de non-régression : annuler puis relancer
aboutit à `done` (`tests/tts/downloads.test.ts`).

### 22.6 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **781 passed / 4 skipped** (baseline : 768 / 4) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check` (`tts-assistant.js`, `engine-config-patch.js`, `config.js`, `e2e-tts-ui.mjs`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **80/80** ; **0 violation CSP** ; **0 exception JS** |
| Vérifs ajoutées | **D86** parcours complet (3 entrées → télécharger → déclarer → **choisir le moteur** → enregistrer, familles vérifiées **écran + serveur à chaque étape**) ; refus client unitaire (8 cas) ; journalisation `tts.engine_config.write` (5 cas) ; `cancelRequested` (1 cas) |

## 23. Durée des échantillons de clonage — élargissement cohérent (D88)

> **Demande utilisateur** : cloner une voix depuis un échantillon de **19,8 s**,
> refusé par « Durée maximale : 10 s (reçu 19.8 s) » ; « est-ce gênant
> d'augmenter la durée d'échantillonnage ? ».

### 23.1 Le moteur a-t-il une limite dure ? — **NON** (troncature, pas rejet)

Le code source amont le prouve, **en Python** (référence) **et** dans le portage
C++ `audio.cpp` (moteur effectivement exécuté) :

- **Python** — `src/chatterbox/tts.py` (et `mtl_tts.py`) :
  ```python
  ENC_COND_LEN = 6 * S3_SR        #  6 s @ 16 kHz =  96 000 échantillons
  DEC_COND_LEN = 10 * S3GEN_SR    # 10 s @ 24 kHz = 240 000 échantillons
  ...
  s3gen_ref_wav = s3gen_ref_wav[:self.DEC_COND_LEN]        # prompt mel S3Gen
  t3_cond_prompt_tokens, _ = s3_tokzr.forward([ref_16k_wav[:self.ENC_COND_LEN]], max_len=plen)  # tokens T3
  ve_embed = self.ve.embeds_from_wavs([ref_16k_wav], sample_rate=S3_SR)   # VoiceEncoder = RÉFÉRENCE ENTIÈRE
  ```
- **C++ (`audio.cpp`)** — `include/engine/models/chatterbox/conditionals.h:13-14` :
  ```cpp
  int64_t encoder_condition_samples = 6 * 16000;
  int64_t decoder_condition_samples = 10 * 24000;
  ```
  et `src/models/chatterbox/conditionals.cpp:79-95` :
  ```cpp
  auto generator_audio  = trim_audio(reference_audio_24k, config_.decoder_condition_samples); // 10 s
  auto tokenizer_audio  = trim_audio(reference_audio_16k, config_.encoder_condition_samples); //  6 s
  const auto & voice_encoder_audio = reference_audio_16k;                                     // entier
  ```
- Le commentaire du portage le confirme : *« Use the full 16 kHz reference for
  VoiceEncoder speaker embedding. Use only the first ENC_COND_LEN samples for T3
  prompt speech tokens. »* (`conditionals.cpp:71-75`).
- `s3gen.py:136` n'émet qu'un **avertissement** (`print("WARNING: s3gen received
  ref longer than 10s")`) si la référence dépasse 10 s **avant** la troncature —
  **jamais** une erreur.

**Conclusion attestée** : aucune borne dure. La référence **au-delà de 10 s** est
**acceptée** par le moteur ; seuls le **prompt fin** (timbre/prosodie local, 10 s)
et les **tokens de prompt T3** (6 s, plafonnés à `speech_cond_prompt_len = 150`)
sont **tronqués**, tandis que l'**embedding d'identité** (VoiceEncoder) voit
**toute** la référence. **La limite « 10 s » de Yuki était un choix de Yuki**
(estimation documentaire « 3–10 s »), pas une contrainte du moteur. On peut donc
autoriser davantage.

### 23.2 Effets d'une référence plus longue — prouvé vs plausible

| Effet | Statut | Détail |
| --- | --- | --- |
| **Préparation** : une fois par (voix, `exaggeration`, langue), puis **cache** | **Prouvé** | `audio.cpp` `ChatterboxSession::prepare` met en cache les conditionals (clé = référence + exaggeration + langue ; `conditionals_cache_slots` défaut **1**, `session.cpp:327-454`). Un **changement de voix** provoque un retraitement. |
| **Temps de préparation au-delà de 10 s** : seule la passe **VoiceEncoder** grandit | **Prouvé** | `conditionals.cpp` : mel/tokenizer bornés à 10 s/6 s ; le VoiceEncoder travaille sur `reference_audio_16k` **entier**. |
| **VRAM** : les conditionals restent **bornés** (≤ 10 s) | **Prouvé** (par le code) | `prompt_mel`/`prompt_tokens` sont issus du signal **tronqué** ; l'embedding d'identité est de taille **fixe**. Le surcoût d'un clip long n'est qu'un **tampon transitoire** de rééchantillonnage. |
| **Qualité** : un clip de 20 s fait **mieux** qu'un clip de 10 s | **Plausible, NON prouvé** | Le prompt fin ne voit que les 10 premières s ; seule la moyenne VoiceEncoder change. Non mesurable ici (GPU absent) — voir **C54**. |
| **Qualité** : un clip de 24 kHz mono suffit au moteur | **Prouvé** | Le moteur rééchantillonne (24 kHz pour le mel, 16 kHz pour le tokenizer). |

### 23.3 Nouvelles limites (couple cohérent)

- `MAX_VOICE_DURATION_SECONDS = 10` → **30** (`src/tts/wav.ts`).
  **Justification** : au-dessus des 19,8 s de l'utilisateur, avec marge pour un
  enregistrement réel ; le moteur n'impose aucune borne, et la troncature interne
  à 10 s/6 s n'est pas une raison de refuser.
- `MAX_VOICE_BODY_BYTES = 3_000_000` → **6_000_000** (`src/tts/voices-store.ts`).
  **Justification** : rendre la durée annoncée **atteignable** (sinon l'utilisateur
  lirait « ≤ 30 s » puis serait bloqué par la taille).

**Preuve de cohérence (calcul)** — `dataSize = floor(sr × s) × canaux × (bits/8)` :

| Format (30 s) | Taille | Sous 6 Mo ? |
| --- | --- | --- |
| mono 16 bits 48 kHz | 2 880 044 o | ✅ |
| mono 16 bits 24 kHz | 1 440 044 o | ✅ |
| **stéréo 16 bits 48 kHz** | **5 760 044 o** | ✅ |
| stéréo 16 bits 44,1 kHz | 5 292 044 o | ✅ |
| stéréo 24 bits 48 kHz | 8 640 044 o | ❌ → convertir en **mono 24 kHz** |

**Preuve par test** : `tests/tts/wav.test.ts` accepte **30 s stéréo 48 kHz 16 bits**
et **30 s mono 24 kHz** ; `tests/integration/voices-api.test.ts` crée une voix de
**30 s stéréo 48 kHz** (HTTP **201**). Les deux limites restent **indépendantes** :
un dépassement de **durée** seule ⇒ `too_long` ; de **taille** seule ⇒ `too_large`.

### 23.4 Messages de refus (avant → après)

- **422 `too_long`**
  - avant : `Durée maximale : 10 s (reçu 19.8 s).`
  - après : `Durée trop longue : 19.8 s reçues, maximum 30 s. Coupez l'échantillon à 30 s ou moins, ou convertissez-le en mono 24 kHz.`
- **422 `too_large`** (store / appels directs)
  - avant : `Échantillon trop volumineux (maximum 3000000 octets).`
  - après : `Échantillon trop volumineux : 6.0 Mo (6000001 octets) reçus, maximum 6 Mo (6000000 octets). Convertissez-le en WAV mono 24 kHz 16 bits (bien plus léger).`
- **413 `body_too_large`** (limite HTTP de l'upload)
  - avant : `Corps trop volumineux (maximum 3000000 octets).`
  - après : `Échantillon trop volumineux : 6000001 octets reçus, maximum 6000000 octets (6 Mo). Réduisez la durée (≤ 30 s) ou convertissez-le en mono 24 kHz 16 bits.`

Chaque message nomme la **limite**, la **valeur reçue**, la **valeur autorisée**
et la **sortie** — sans inventer de cause.

### 23.5 UI

`public/ui/voices-panel.js` : constantes `MAX_VOICE_BODY_BYTES = 6_000_000` /
`MAX_VOICE_DURATION_SECONDS = 30` ; texte d'aide de la modale
(`WAV PCM, durée ≤ 30 s, taille ≤ 6 Mo. Le moteur n'exploite que le début (~10 s)
pour le timbre fin : un extrait plus court suffit.`) ; repli 413/422 et
pré-contrôle de taille alignés. Aucun `style=` (CSP stricte respectée).

### 23.6 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **785 passed / 4 skipped** (baseline **781 / 4** ; **+4** : 3 validation WAV, 1 API) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check public/ui/voices-panel.js` | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **80/80** ; **0 violation CSP** ; **0 exception JS** (captures restaurées) |
| Tests ajoutés | bornes **basse et haute** de durée, message exact `too_long` ; message exact `too_large` ; 2 tests de **cohérence durée↔taille** ; API : 30 s stéréo 48 kHz accepté (201), 31 s refusé (422), corps > 6 Mo refusé (413) |

### 23.7 Non vérifiable sans le moteur réel

Le **gain qualitatif** d'une référence > 10 s (C54) et le **temps de préparation**
réel sur GPU : `tests/chatterbox/*_bench.py` et l'E2E n'exécutent pas le moteur
(la qualité acoustique n'est pas testable en headless — spec §13). Les faits de
troncature et de cache sont, eux, **prouvés par le code**.

## 24. UI — icônes SVG `currentColor` / `--icon-color` (source icons0.dev) ; **navigation clavier et transitions RETIRÉES**

> **Demandes utilisateur** (lot d'interface) : ① « avec les flèches on navigue
> entre les onglets » ; ② transitions distinctes (glissement au clavier, fondu
> au clic) ; ③ « les icônes … sont affichées en blanc … régler la couleur de
> l'icône par élément ».
>
> **Résultat final** : ② et le durcissement de ① sont **RETIRÉS** (hors périmètre
> Yuki, D92) ; ③ est **conservé** et ses SVG sont désormais **sourcés sur
> `https://icons0.dev/`** (D93). La navigation clavier **d'origine** de ① est
> restaurée et fonctionne.

### 24.1 État réel AVANT modification (prouvé)

**① Navigation clavier : ELLE EXISTAIT DÉJÀ.** Le gestionnaire vivait sur le
`tablist` (`public/ui/config.js`, ancien
`tablistEl.addEventListener("keydown", …)`) et gérait `←`/`→`/`↑`/`↓` +
`Home`/`End`. Il ne s'activait QUE si `document.activeElement` était un
`[role=tab]` (`tabButtons.indexOf(...) === -1` ⇒ `return`). L'E2E le prouvait
déjà (check « flèche gauche change d'onglet », **80/80** avant ce lot).

**Pourquoi l'utilisateur ne le constatait pas** : le focus doit d'abord être
SUR un onglet (touche `Tab` pour atteindre la barre). Si le focus est ailleurs
(corps de page, panneau, champ), les flèches ne font rien (ou défilent / changent
la valeur d'un `<select>`). La barre n'annonce pas ce comportement.

**② Icônes : il n'y a AUCUN `<svg>` dans l'UI** (`grep -rn "<svg" public/` → 0).
Les « icônes » perçues sont des **glyphes Unicode/emoji** :

| Icône | Emplacement | Couleur actuelle |
| --- | --- | --- |
| `☾`/`☀` (mode) | `public/ui/index.html`, `config.html`, `theme.js:syncControls` | glyphe, suivait `color` (`--text`/`--accent`) |
| `🔇`/`🔊` (voix) | `public/ui/index.html`, `tts-preference.js:resolveSpeechState`, `app.js:refreshTtsToggle` | **emoji** posé par `textContent` — NON recolorable |
| `←` (retour) | `public/ui/config.html` | glyphe, `color` |
| `✕` (fermer) | `public/ui/vendor/holaf/holaf-modal.js` | glyphe (brique vendorisée, non modifiée) |

En l'absence de police emoji couleur (cas de Chromium headless, et de
l'utilisateur), ces glyphes se rendent en **monochrome** et, sur un thème sombre
(`--text` quasi blanc), **en blanc** : c'est exactement ce que décrit
l'utilisateur. Le seul moyen de rendre les emoji **réglables** est de les
remplacer par du SVG `currentColor`.

### 24.2 Navigation clavier — durcissement RETIRÉ (demande ①)

> ⛔ **RETIRÉ — hors périmètre Yuki.** Ce durcissement (D89) a été livré sur
> Yuki **par erreur**, en même temps qu'un lot destiné à **un autre projet**
> (l'utilisateur a demandé : « ne touche pas aux autres projets, et ici ne garde
> que les SVG »). Il est **intégralement retiré** ; le gestionnaire **d'origine**
> est restauré — la navigation clavier **existait avant** et **fonctionne
> toujours** (vérifié E2E, §24.5).

- **D89 — ~~Délégation clavier élargie à `.config-tabs`~~ (RETIRÉ).** Le
  gestionnaire d'origine — écoute `keydown` sur `.config-tablist[role="tablist"]`,
  verrou `tabButtons.indexOf(document.activeElement) === -1` — est **restauré**
  (`public/ui/config.js`). Sont supprimés : `holdsArrowKeys`, `tabIndexOfActive`,
  l'écoute déléguée sur `.config-tabs`, le garde `defaultPrevented` et la gestion
  `Alt`/`Ctrl`/`Meta`. `aria-selected`, roving `tabindex`, focus visible,
  `Home`/`End` et mise à jour du `hash` (`replaceState`) restent en place
  (comportement **d'origine**, prouvé E2E).

- **D92 — Retrait acté (navigation clavier + transitions).** Décision : le
  durcissement clavier (D89) **et** les transitions d'onglets (D90) sont
  **hors périmètre Yuki** et retirés. Seul le **système d'icônes SVG** (D91/D93)
  de ce lot est conservé. Aucun autre projet n'a été touché.

### 24.3 Transitions d'onglets — RETIRÉES (demande ②)

> ⛔ **RETIRÉ — hors périmètre Yuki** (même lot que D89, livré par erreur).
> Retour à une **bascule simple par `hidden`**.

- **D90 — ~~Clavier = glissement directionnel, clic = fondu enchaîné~~ (RETIRÉ).**
  Supprimés : `playTabTransition`/`clearTabTransition` (`public/ui/config.js`),
  l'option `transition` de `selectTab`, les classes `config-panels--animating`/
  `--forward`/`--backward`/`--fade`, les attributs `data-transition` et les
  `@keyframes yuki-tab-*` + `@media (prefers-reduced-motion)` associé
  (`public/ui/config.css`), ainsi que la gestion `inert`/`aria-hidden` liée.
  `activateTab` ne pose plus que `aria-selected`/`tabindex`/`hidden` → **bascule
  simple par `hidden`**. `git grep` sur ces symboles : **aucun résidu** (§24.5).

### 24.4 Couleur des icônes (demande ③)

- **D91 — Icônes monochromes en SVG inline `stroke="currentColor"`, couleur
  réglable PAR ÉLÉMENT via `--icon-color` (héritée).** Les emoji `🔇`/`🔊` et les
  glyphes `☾`/`☀`/`←` sont remplacés par des SVG (haut-parleur/barré, soleil/lune,
  flèche). `.icon { color: var(--icon-color, currentColor) }` (+ utilitaires
  `--accent`/`--muted`/`--danger`) : sans `--icon-color`, l'icône suit `color` du
  contexte ; avec, n'importe quel conteneur la surcharge (ex.
  `.nav-back { --icon-color: var(--accent) }`). L'état visuel suit le thème
  (`:root[data-theme$="-light"]`) ou l'état du bouton (`.tts-toggle--off`/`--muted`),
  **sans JS** et sans `style=`. Preuve : `public/ui/styles.css` (`.icon`) ;
  `public/ui/index.html`/`config.html` (SVG) ; `public/ui/config.css`
  (`--icon-color`) ; `public/ui/theme.js`/`app.js` (plus de `textContent`) ;
  `public/ui/tts-preference.js` (champ `icon` retiré).

- **D93 — Tracés SVG SOURCÉS sur `https://icons0.dev/` (collection « Lucide », ISC).**
  Les SVG ne sont plus « dessinés à la main » : ils viennent de l'**API**
  `GET https://icons0.dev/api/icons?q=lucide:<nom>` — `lucide:sun`, `lucide:moon`,
  `lucide:volume-2`, `lucide:volume-x`, `lucide:arrow-left` (HTTP 200, `body` SVG
  récupéré le 2026-09-25) — qui interroge 200k+ icônes de 150+ collections
  open-source (backend **Iconify**). Intégration **inchangée** : `currentColor`,
  `.icon`, `--icon-color`, bascules CSS par thème/état, **aucun `style=`**, CSP
  stricte. **Attribution** (licence **ISC** de Lucide) : notice de copyright en
  **commentaire HTML** dans `public/ui/index.html`/`config.html` + **texte
  complet du ISC et provenance en §24.7**.

**Ce que « couleur par élément » permet concrètement** :

1. **Par contexte (héritage `currentColor`)** : une icône dans un libellé
   `--muted` prend la couleur du libellé ; dans un bouton accent, elle prend
   l'accent — sans rien écrire.
2. **Par conteneur (`--icon-color`)** : poser `--icon-color: var(--danger)` sur
   une carte colore TOUTES ses icônes (variable CSS héritée).
3. **Par icône** : les utilitaires `.icon--accent`/`.icon--muted`/`.icon--danger`
   posent `--icon-color` sur un seul SVG.

**Ce qu'il faudrait pour un réglage PAR L'UTILISATEUR** (proposé, NON ajouté) :
un **champ de configuration** ne peut PAS convenir tel quel — le schéma n'accepte
que `string|int|enum` (pas de booléen/flottant/couleur). Deux voies réalistes :

- **enum de couleurs sémantiques** (`ui.iconColor` : `auto|accent|muted|text`)
  mappé côté CSS sur `--icon-color` (le plus simple, cohérent avec les 10 thèmes) ;
- **chaîne de couleur libre** (`ui.iconColor: "#rrggbb"`) imposerait de POSER une
  variable CSS par élément via le CSSOM/`style=`, incompatible avec la CSP stricte
  (sauf `<style>` généré, refusé). La voie enum est retenue comme la seule propre
  sous CSP ; aucun champ n'est ajouté sans besoin explicite.

### 24.5 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **788 passed / 4 skipped** (baseline **790 / 4** ; **+5** au lot icônes/transitions, **−2** tests de transitions retirés) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check` (`config.js`, `theme.js`, `app.js`, `tts-preference.js`, `e2e-tts-ui.mjs`) | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **82/82** (avant retrait : **89/89** ; avant le lot : **80/80**) ; **0 violation CSP** ; **0 exception JS** |
| Vérifs E2E **conservées** | navigation clavier **d'origine** (flèche gauche → onglet précédent, focus + `hash`), couleur d'icône (`--icon-color` accent ≠ texte, `stroke=currentColor`, pilotée par `data-theme`, 0 `style`), et **toutes** les autres gardes (téléchargement, config moteur, CSP…) |
| Vérifs E2E **retirées** | glissement `forward`/`backward`, `Home`/`End` ajoutés, non-interception d'un champ, `hidden`=vérité pendant l'animation, clic=fondu, `prefers-reduced-motion` |
| Résidus (`git grep`) | `playTabTransition`, `clearTabTransition`, `config-panels--animating`, `data-transition`, `yuki-tab-`, `holdsArrowKeys`, `tabIndexOfActive` ⇒ **aucun** (hors historique docs et CSS vendorisé Holaf préexistant) |
| Captures | `_tools/shots/config-icons-*.png` (topbar recadrée : flèche accent + soleil/lune) ; PNG trackés régénérés restaurés (`git checkout --`) |

### 24.6 Non vérifié / incertain

- **Rendu des glyphes vs SVG selon la police** : le remplacement emoji→SVG est
  prouvé par l'E2E (l'icône est un `<svg>` avec `stroke="currentColor"`), mais
  l'aspect visuel exact (épaisseur) n'est pas comparable pixel à pixel.
- **C55 — `✕` de fermeture HolafModal** : reste un glyphe dans la brique
  VENDORISÉE (`public/ui/vendor/holaf/holaf-modal.js`), non modifiée (copie pinnée
  d'une version amont) ; elle suit `color` mais ne participe pas à `--icon-color`.
  À confirmer : aligner la brique amont (ou un correctif au prochain bump) sur le
  même système d'icônes.
- **C56 — `icons0.dev` agrège des licences HÉTÉROGÈNES.** Le site est un moteur
  de recherche sur 150+ collections open-source (backend Iconify) : à côté de
  collections **permissives** (MIT/Apache-2.0/CC0/ISC/Unlicense) cohabitent des
  licences **hors politique** — **GPL** (exception déjà assumée par l'utilisateur),
  **CC BY-NC 4.0 / CC BY-NC-SA 4.0** (**non commercial**) et **CC BY-SA**
  (**partage à l'identique**). Le code du site lui-même (`github.com/marcoripa96/i0`)
  est **MIT**, mais **la licence des icônes est celle de leur collection**. Toute
  icône future DOIT être tirée d'une collection permissive ; **retenue ici :
  Lucide (ISC)**. **À demander à l'utilisateur** avant toute icône issue d'une
  collection NC/SA/GPL.
- **Réglage utilisateur de la couleur** : proposé (enum), **non implémenté**
  (aucun besoin explicite).

### 24.7 Provenance et attribution des icônes (source `icons0.dev`)

**Nature du site** — `https://icons0.dev/` (HTTP **200**, `server: Vercel`)
se décrit comme *« the fastest icon search for you and your AI agent »* et
*« Search 200k+ icons from 150+ open-source collections »* : c'est un **moteur de
recherche d'icônes** (front Next.js) adossé au backend **Iconify** (mention
« powered by iconify » dans son pied de page), avec un **serveur MCP** (`/mcp`,
HTTP **401** ⇒ authentification) et un registre **shadcn** (`/r/<collection>.json`).

**Mode de récupération** — API JSON publique (aucune clé pour la recherche) :

| Requête | Résultat |
| --- | --- |
| `GET https://icons0.dev/api/icons?q=lucide:sun` | **200** — `{"results":[… "body":"<circle …/><path …/>" …]}` |
| `GET https://icons0.dev/api/icons?q=lucide:moon` | **200** |
| `GET https://icons0.dev/api/icons?q=lucide:volume-2` | **200** |
| `GET https://icons0.dev/api/icons?q=lucide:volume-x` | **200** |
| `GET https://icons0.dev/api/icons?q=lucide:arrow-left` | **200** |

Chaque résultat porte `fullName`, `name`, `prefix`, `collection`, `body` (SVG
**déjà en `currentColor`**), `width`/`height` (24×24). Les 5 icônes nécessaires
(soleil, lune, haut-parleur, haut-parleur barré, flèche gauche) sont **toutes
disponibles** — dans la collection **Lucide** notamment.

**Licence de la collection retenue** — **Lucide**, spdx **ISC** (permissive,
politique respectée ; source `https://api.iconify.design/collections` →
`lucide.license = {title: "ISC", spdx: "ISC"}`, LICENSE amont
`github.com/lucide-icons/lucide/blob/main/LICENSE`, HTTP 200).

**Où l'attribution est portée** :
1. **Commentaire HTML** dans `public/ui/index.html` et `public/ui/config.html`,
   au-dessus des SVG (notice de copyright) — la notice accompagne donc les copies.
2. **Le présent §24.7** (provenance + textes intégraux ci-dessous).

**Copyright** — Lucide : `Copyright (c) 2026 Lucide Icons and Contributors`
(ISC). Icônes dérivées de **Feather** (dont `moon`, `arrow-left`) :
`Copyright (c) 2013-present Cole Bemis` (MIT).

```
ISC License (Lucide)

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The MIT License (MIT) (pour les icônes dérivées de Feather, dont `moon` et
`arrow-left`) :

```
Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```


## 25. Interface de chat — volets 1 & 2 : convention du texte muet + filtrage

> **Périmètre du lot** : les **volets 1 (la convention)** et **2 (le filtrage
> serveur)** du chantier « interface de chat ». Les volets 3 (« rendu
> navigateur ») et 4 (« images ») viendront dans des lots suivants. Ce document
> est le plus pertinent (continuité `D##`/`C##` du chantier UI/TTS) : la section
> s'y ajoute après §24 (`D93`/`C56`), sans réutiliser de numéro.

### 25.1 La règle fondatrice

**Ce qui est dit doit se suffire à lui-même. Le visuel est muet mais affiché.**
Le TTS n'est **pas** un outil d'accessibilité : c'est une **conversation
naturelle**. Un humain qui montre un tableau ou une image **ne lit pas** le
contenu ni le texte alternatif — mais il **dit** ce qui compte.

### 25.2 La convention — deux niveaux de « muet »

| Construct | Lu ? | Traitement |
| --- | --- | --- |
| Paragraphes, **titres**, **listes**, **citations** | ✅ **lu** | marqueur retiré, texte conservé (déjà bon, inchangé) |
| **Blocs de code** (``` / ~~~) | ❌ muet | déjà ignorés par le filtre (`inFence`) — inchangé |
| **Tableaux** | ❌ muet | **nouveau** : ligne `|` + séparatrice `---` ignorées |
| **Images** `![alt](url)` | ❌ muet | **nouveau** : ignorées **entièrement** (plus d'`alt` lu) |
| **Bloc étiqueté ` ```muet `** | ❌ muet | **nouveau** : construct explicite de la convention |

**Repli défensif** : si le modèle ne respecte **pas** la convention, le
comportement reste celui d'avant — **on lit**. Jamais de silence surprise.

### 25.3 La constante unique (source unique) et la passe multilingue

- **`MUTE_BLOCK_LABELS`** — liste des étiquettes reconnues (`src/tts/mute.ts`),
  aujourd'hui `["muet"]`.
- **`MUTE_BLOCK_LABEL`** — étiquette canonique (premier élément).
- **`isMuteInfoString(info)`** — reconnaît le **premier mot** de l'info-string
  d'un bloc (casse ignorée).

**D1 — qui l'utilise** : le **filtre** (`src/tts/markdown.ts`, via
`isMuteInfoString`) **et** le **texte du prompt** (`src/llm/prompts.ts`, via
`MUTE_BLOCK_LABEL`). Un test de garde
(`tests/tts/markdown.test.ts`) vérifie que les deux lisent la **même** constante
et qu'aucune chaîne littérale `"muet"` n'est recopiée dans ces deux fichiers.

**Passe multilingue (préparée)** : `MUTE_BLOCK_LABELS` est une **liste**.
Ajouter une langue = ajouter son étiquette (ex. `"silent"`, `"mute"`) **ici** ;
le filtre et le prompt la reconnaissent automatiquement, aucun littéral à
répercuter ailleurs.

### 25.4 L'instruction du prompt (volet 1, partie « modèle »)

**État réel vérifié** : `appendSystemPromptOverride` renvoie `[]`
(`src/pi/sdk/session-factory.ts:38`) — aucun ajout automatique. Les prompts
viennent des fichiers `config/pi/system-prompt.md` / `-heavy.md` chargés dans
`prompts.light` / `prompts.heavy`.

**Mécanisme** : `appendVoiceInstruction(systemPrompt, voiceEnabled)`
(`src/llm/prompts.ts`), appelé **uniquement** pour le prompt **léger**
(`src/index.ts`, `createPiHost({ systemPrompt: … })`) avec
`voiceEnabled = isTtsEnabled(config)`.
- `tts.enabled === "on"` ⇒ le bloc est ajouté **après** le prompt utilisateur ;
- `tts.enabled !== "on"` ⇒ **aucun ajout**, le prompt est **inchangé à
  l'identité** (prouvé `tests/llm/prompts.test.ts`).

**Texte EXACT injecté** (`VOICE_SPEECH_INSTRUCTION`), mot pour mot :

```
## Réponse parlée

Ta réponse sera lue à voix haute : l'utilisateur l'écoute.
- Écris des phrases naturelles, comme à l'oral.
- Tout ce qui compte doit être dit avec des mots : un tableau ou une image est affiché mais jamais lu, alors commente-le naturellement.
- Ce qui ne doit pas être entendu (tableau, données brutes, code) va dans un bloc étiqueté « muet » : ouvre-le par ```muet.
```

La dernière ligne **interpole `MUTE_BLOCK_LABEL`** : le prompt ne peut pas
diverger du filtre.

### 25.5 Les trois ajouts au filtre (`src/tts/markdown.ts`)

1. **Tableaux ignorés** — `scanTableLine` (`src/tts/markdown.ts:320`) détecte une
   ligne contenant `|` suivie d'une **séparatrice** (`isTableSeparator`,
   `src/tts/markdown.ts:73`) et ignore toutes les lignes suivantes contenant
   `|`. Les **fragments à cheval** sont gérés : la séparatrice incomplète est
   **retenue** tant que son `\n` n'est pas arrivé (sinon il clôturerait le
   tableau à tort), et une ligne sans `|` clôt le tableau puis est **relue**.
   Titres/citations (`#`, `>`) ne sont jamais pris pour des en-têtes.
2. **Images ignorées entièrement** — `readLink` (`src/tts/markdown.ts:371`)
   renvoie un texte **vide** pour `![alt](url)` (l'`alt` n'est plus lu), quel que
   soit le découpage en deltas.
3. **Blocs ` ```muet ` ignorés** — l'info-string de la ligne d'ouverture est
   testée par `isMuteInfoString` ; le champ `fenceMuted` supprime l'annonce
   éventuelle (`codeAnnouncement` reste inchangé pour les **vrais** blocs de
   code, défaut `null`).

**Repli défensif prouvé** : `Vrai | Faux` (pas de séparatrice) est **lu tel
quel** ; un bloc de code ` ```js ` ordinaire est toujours ignoré comme avant.

**Correction nécessaire** — `flush()` renvoyait uniquement la sortie du
nettoyeur **final** et **perdait** la sortie du `push` résolu au flush
(`un [lien` → `"un "`). Elle est désormais recomposée
(`src/tts/markdown.ts:114`) : sans quoi la dernière ligne d'un tableau (ou un
lien non fermé) disparaîtrait en fin de flux.

### 25.6 Ce qui reste inchangé (prouvé par test)

- Lecture des **titres**, **listes**, **citations**, paragraphes
  (`tests/tts/markdown.test.ts`, garde anti-divergence) ;
- **ponctuation** de fin de phrase (le segmenteur en dépend) ;
- **incrémentalité** (marqueurs/fences/tableaux coupés entre deltas) ;
- **no-op** quand le TTS est désactivé (filtre non construit / prompt identité) ;
- `codeAnnouncement` (défaut `null`) ; le filtre reste le **point unique**.

### 25.7 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **814 passed / 4 skipped** (baseline **788 / 4** ; **+26**) |
| `npm run typecheck` / `npm run build` | verts |
| `node --check public/ui/config.js` | OK |
| E2E `_tools/e2e-tts-ui.mjs` | **82/82** ; **0 violation CSP** ; **0 exception JS** |
| Captures PNG régénérées | restaurées (`git checkout -- "Yuki and Libs/_tools/shots"`) + PNG non suivi supprimé |

### 25.8 Non vérifié / incertain

- **Rendu visuel exact** du bloc en lecture seule dans l'onglet Conversation :
  présence/classes/absence de `style=` prouvées par test statique et E2E (0
  violation CSP), pas de comparaison pixel.
- **Comportement du modèle réel** face à l'instruction : on ne peut pas prouver
  ici qu'un LLM respectera la convention `muet` — d'où le **repli défensif**
  (lecture) qui garantit l'absence de silence surprise.

### Décisions et points ouverts

- **D94 — Convention du texte muet en source unique + application au filtre.**
  L'étiquette `muet` vit dans `src/tts/mute.ts` (`MUTE_BLOCK_LABELS` /
  `MUTE_BLOCK_LABEL` / `isMuteInfoString`) et est consommée par le **filtre** et
  par le **prompt**. Le filtre ignore désormais tableaux, images (entièrement) et
  blocs `muet`, avec repli défensif (lecture). L'instruction n'est injectée dans
  le prompt **léger** que si `tts.enabled === "on"`, et reste **visible en
  lecture seule** dans l'onglet Conversation de `/config` (texte servi par
  `GET /api/config → voiceInstruction`).
- **C57 — Passe multilingue de l'étiquette muette.** `MUTE_BLOCK_LABELS` est
  prête (liste) mais ne contient que `"muet"`. À trancher plus tard : quelles
  étiquettes ajouter par langue (`"silent"`, `"mute"`, `"quiet"`…) et si le
  choix doit suivre `tts.language`. Non implémenté (aucun besoin explicite).

## 26. Interface de chat — volet 3 : rendu markdown incrémental (navigateur)

> **Périmètre du lot** : le **volet 3** du chantier « interface de chat » — le
> **rendu markdown dans le navigateur**. Le **volet 4** (« images ») viendra
> ensuite. Ce document est le plus pertinent (continuité `D##`/`C##`) : la
> section s'ajoute après §25 (`D94`/`C57`), **sans réutiliser de numéro**.

### 26.1 Objectif et règle fondatrice (rappel)

**Ce qui est dit doit se suffire à lui-même ; le visuel est muet mais affiché.**
Le rendu navigateur **affiche** tout (code, tableaux, images, blocs `muet`) ;
seul le TTS les ignore (volet 2, `src/tts/markdown.ts`). Le `muet` et les
constructs muets **ne changent donc pas l'affichage** : un tableau reste un
tableau, une image reste une image (ou son placeholder — voir §26.4).

### 26.2 Le filet de sécurité D'ABORD (E2E)

Avant d'injecter le moindre balisage, l'E2E devait savoir **envoyer un vrai
message** et **asserter ce qui est affiché** : jusqu'ici il ouvrait `/` sans
jamais écrire. Le serveur de test `_tools/e2e-tts-serve.ts` a été **étendu** :

- il câble le **même double** que les tests (`tests/pi/host-double.ts`,
  `FakePiHost`) sur un transport WebSocket **RÉEL** (`createWsTransport`) ;
- il rejoue, en deltas espacés (~1 400 caractères), une réponse markdown
  couvrant **tous** les constructs (titres, listes, citation, code, tableau,
  image `data:`, bloc `muet`, ~24 puces pour dépasser la hauteur visible).

L'E2E `_tools/e2e-tts-ui.mjs` envoie alors un message, laisse le flux arriver,
puis vérifie : structure rendue (`h1..h3`, `p`, `ul`/`ol`, `blockquote`,
`pre>code`, `code` inline, `a[href^=https]`, `table`+cellules, `img` avec `alt`),
**bloc muet marqué**, **aucun résidu** `.md-tail`, **0 style inline**,
**0 violation CSP** et **0 exception JS** (bilans globaux). Preuve réelle
(bilan E2E) : **92/92**, `0 CSP`, `0 exception` — dont
`{"headings":3,"paragraphs":3,"bullets":27,"ordered":2,"quote":1,"strong":1,"em":1}`,
`{"codeBlocks":2,"inlineCode":1}`, `{"tables":1,"tableCells":6}`,
`{"images":1,"imageAlt":"un chat","imageSrcPrefix":"data:image/"}`,
`{"muteBlocks":1,"muteBadge":"muet — non lu"}`.

### 26.3 Stratégie de rendu — blocs stabilisés, aucune injection

**Un bloc n'est rendu que lorsqu'il est COMPLET.** Tant qu'il est incomplet, il
reste affiché en **texte brut temporaire** (`.md-tail`) :

| Bloc | Devient « stable » quand… |
| --- | --- |
| Paragraphe / citation / liste | terminé par une ligne vide ou un autre bloc ; en flux, un résidu reste brut |
| Titre, règle `---` | sa ligne est terminée (`\n`) |
| Bloc de code / `muet` | la fence de clôture est présente **et** terminée |
| Tableau | confirmé par une séparatrice **et** terminé par une ligne non-`|` |
| Lien/image incomplet | reste brut : le paragraphe porteur attend d'être terminé |

**Fin incomplète** : au `run_finished`, un **flush** (`parseBlocks(text, true)`)
résout le dernier bloc — le résidu brut devient le bloc rendu. C'est ce que
prouve l'E2E (`.md-tail` = 0 après le run).

**Aucune injection HTML n'est possible** : le rendu construites nœuds
**programmatiquement** (`document.createElement` + `createTextNode` +
`textContent`). `public/ui/markdown.js` **ne contient AUCUN** `innerHTML` /
`insertAdjacentHTML` / `outerHTML` (garde de test statique). C'est la garantie
anti-injection **et** la seule voie compatible avec la CSP : `script-src 'self'`
interdit les gestionnaires en ligne, `style-src 'self'` interdit les styles en
ligne. Un construct impossible à rendre sans casser la CSP n'est **pas** forcé
(cas des images distantes : §26.4).

**Performance** : le flux delta n'exécute **aucun `await`** ; le rendu
incrémental ne ré-analyse **que le résidu** (`parseBlocks(text, false, from)`),
jamais la réponse entière — donc pas de O(n²) (test unitaire de non-régression
`tests/ui/chat-markdown.test.ts`). Le TTFT est inchangé (le premier delta suit
le même chemin `textContent`/ajout de nœud).

### 26.4 Constructs supportés et marque du bloc muet

| Construct | Rendu |
| --- | --- |
| Paragraphe, **titres** `#…######` | `p` / `h1`…`h6` (classe `md-heading`) |
| **Listes** à puces / numérotées | `ul.md-list` / `ol.md-list` + `li` |
| **Citations** | `blockquote.md-quote` |
| **Bloc de code** | `pre > code` (classe `language-x`), dans `.md-code-block` |
| **Code en ligne** | `code.md-code` |
| **Gras / italique / barré** | `strong` / `em` / `del` (imbricables) |
| **Liens** `[t](href)` | `a.md-link` — `href` seulement si `http(s)/mailto/relatif` (sinon texte) et `rel="noopener noreferrer"` |
| **Tableaux** | `table.md-table` (`thead`/`th`, `tbody`/`td`) |
| **Images** `![alt](src)` | `img.md-image` si `src` est `data:image/` ou de même origine ; **sinon placeholder** `span.md-image--placeholder` (rôle `img`, `aria-label`, alt affiché) |
| **Bloc ` ```muet `** | `.md-code-block--mute` : `pre>code` **affiché**, surmonté d'une marque discrète `.md-mute-badge` (« muet — non lu ») |

**Marque du bloc muet** : un simple libellé en majuscules discrètes (`--muted`),
**non replié** (décision validée : blocs affichés). Un tableau **muet** reste un
tableau ; une image **muette** reste une image : seul le TTS les ignore.

**Couleurs** : uniquement les **variables de thème** (`--text`, `--muted`,
`--accent`, `--panel-2`, `--border`) — les 5 familles × 2 modes suivent sans JS.
**Aucun style en ligne** n'est posé (CSP + test statique).

### 26.5 Cohérence affiché / parlé — cas PARTAGÉS

Deux parseurs coexistent désormais : le **client** (afficher) et le **filtre
serveur** (parler). Pour éviter la divergence, un corpus de **cas partagés**
(`tests/ui/chat-markdown.test.ts`) épingle, pour chaque message, la **structure
affichée** (blocs client) **et le texte parlé** (filtre serveur), et vérifie que
tout construct muet est **présent à l'écran** mais **absent du parlé** :

| Cas | Affiché (blocs) | Parlé |
| --- | --- | --- |
| `# Résumé` + gras/italique/code/lien | `heading, paragraph` | `Résumé\n\nUn point clé et de l'italique, du code et un lien.\n` |
| listes puces + numérotée | `list, list` | `un\ndeux\n\npremier\nsecond\n` |
| citation + ` ```js ` | `quote, code` | `Une citation\n\n` — `const secret = 1;` **absent** |
| tableau entre paragraphes | `paragraph, table, paragraph` | `Valeurs :\n\n\nFin.\n` — cellules **absentes** |
| image + ` ```muet ` | `paragraph, paragraph, mute, paragraph` | alt `un chat` **absent**, `secret brut 42` **absent** |

### 26.6 Miroir client ↔ serveur de la convention `muet`

Le client (JS vanilla) **ne peut pas importer du TS** : `public/ui/markdown.js`
**mirroite** `src/tts/mute.ts` (`MUTE_BLOCK_LABELS`, `MUTE_BLOCK_LABEL`,
`isMuteInfoString`), exactement comme `public/ui/tts-frames.js` miroite
`src/tts/framing.ts`. Un **test de non-divergence** importe les deux et vérifie
l'**égalité** de `MUTE_BLOCK_LABELS` **et** l'identité de comportement de
`isMuteInfoString` sur un corpus (`muet`, `MUET`, `muet json`, `json`, `…`).
Ajouter une langue au serveur sans la répercuter côté client **fait échouer** le
test.

### 26.7 Autoscroll — coller en bas SEULEMENT si on y est déjà

**Avant** : `els.conversation.scrollTop = els.conversation.scrollHeight` à
CHAQUE ajout/delta (`app.js`) — remonter dans l'historique était impossible.
**Après** : `isConversationPinned()` mesure (`scrollHeight - scrollTop -
clientHeight <= 24 px`) **AVANT** la mutation ; on ne colle en bas que si
l'utilisateur y était déjà. Chaque site (message, delta, transcript, fin de run)
capture son `pinned` **avant** d'ajouter du contenu. **Preuve E2E** : l'E2E
remonte (`scrollTop = 0`) pendant le flux et vérifie que le bas **n'est pas
recollé** (`stayedUp=true`, `streamingAfterScroll=true`).

### 26.8 Vérifications

| Vérification | Résultat |
| --- | --- |
| `npm test` | **847 passed / 4 skipped** (baseline **814 / 4** ; **+33**) |
| `npm run typecheck` | vert |
| `npm run build` | vert |
| `node --check` | `public/ui/app.js`, `public/ui/markdown.js`, `_tools/e2e-tts-ui.mjs` OK |
| E2E `_tools/e2e-tts-ui.mjs` | **92/92** (baseline **82/82**) ; **0 violation CSP** ; **0 exception JS** |
| Chat : remontée pendant le flux | bas **non recollé** (`stayedUp=true`) |
| Captures | `chat-markdown.png`, `chat-markdown-bas.png` **ajoutées** ; PNG trackés régénérés **restaurés** (`git checkout -- "Yuki and Libs/_tools/shots"`), `config-engine-incoherent.png` non suivi supprimé |

### 26.9 Non vérifié / incertain

- **Comportement d'un LLM réel** : on ne peut pas prouver ici qu'un modèle
  produira exactement ces constructs — d'où le **repli défensif** partout
  (marqueur non fermé = texte littéral ; construct non reconnu = texte).
- **Images distantes** : la CSP `img-src 'self' data:` **interdit** les images
  d'un domaine externe. Elles sont rendues en **placeholder** (alt affiché),
  **jamais** chargées — donc **aucune** violation CSP. Le **volet 4** tranchera
  (allowlist de domaines, `media-src`, etc.) — voir **C58**.
- **Comparaison pixel** : les captures prouvent la lisibilité, pas une
  conformité pixel à pixel.
- **TTS réel dans l'E2E** : le transport de test n'a **pas** de pipeline TTS
  (pas de son) ; l'E2E chat prouve le **rendu**, pas la synthèse (déjà couverte
  ailleurs). C'est pourquoi l'UI y affiche honnêtement « Aucun son reçu… ».

### Décisions et points ouverts

- **D95 — Rendu markdown par blocs STABILISÉS, nœuds DOM exclusivement.**
  Le chrome navigateur (`public/ui/markdown.js`) découpe le flux en blocs, ne
  rend qu'un bloc complet, garde le résidu en texte brut temporaire et le
  **flush** à la fin du run. Tout le balisage vient de `document.createElement` /
  `textContent` — **jamais** `innerHTML` (anti-injection + compatibilité CSP
  `script-src`/`style-src 'self'`). Le rendu incrémental ne ré-analyse que le
  résidu (pas de O(n²)). Couleurs **uniquement** par variables de thème.
- **D96 — Miroir client de la convention `muet` + autoscroll conditionnel +
  filet E2E d'abord.** Le client mirroite `src/tts/mute.ts` avec un **test de
  non-divergence**. L'autoscroll ne colle en bas que si l'utilisateur y était
  déjà. Le harnais E2E sait désormais **envoyer un message** et asserter le
  rendu (structure + 0 CSP + 0 exception) avant toute évolution du rendu.
- **C58 — Images : domaine externe et CSP.** `img-src 'self' data:` rend
  aujourd'hui toute image distante en **placeholder** (alt affiché, non chargée).
  À trancher au **volet 4** : ouvrir `img-src` à une **allowlist** de domaines ?
  un proxy d'image côté gateway ? que faire du texte alternatif (lu/affiché) ?
  Non implémenté (le placeholder est sûr et honnête).
