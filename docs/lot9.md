# Lot 9 — Configuration structurée du moteur TTS + montages `rw`

> **Spécification du Lot 9, étape 1 :** permettre d'**éditer la configuration du
> moteur `audio.cpp` (`server.json`) depuis l'interface Yuki**, sans terminal et
> **sans jamais envoyer de JSON brut** au navigateur. Ce document **complète**
> [`docs/lot7.md`](lot7.md) (spécification de référence du TTS) et
> [`docs/lot8.md`](lot8.md) (assistant de mise en route). Il **ne refait pas**
> les lots précédents : il ajoute les **montages `rw`** nécessaires et un
> **contrat de routes** structuré.
>
> **Date.** 2026-09-22. Écrit après livraison de l'étape 1.
>
> **Style.** Sections numérotées ; tableaux de décisions **« Acté »** (`D##`) et
> **« À confirmer »** (`C##`) ; chaque affirmation est adossée à une preuve
> `fichier:ligne` ou explicitement marquée **non attestée**. La numérotation
> **poursuit** celle des lots précédents : décisions **D46 → D65**, points
> ouverts **C30 → C40** (dernier `D45` : `docs/lot8.md:645` ; dernier `C29` :
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

- **Télécharger** un modèle depuis l'interface (montages prêts, **code absent**).
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
| `family` | `chatterbox\|qwen3-tts\|cosyvoice3\|kokoro\|sanotts` | hors liste ⇒ `400` | `src/tts/engine-config.ts:94-100` |
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

### 10.1 Étape 2 — téléchargement des modèles (hors de ce lot)

Les montages et chemins sont **prêts** : `M1` (`/models`, `rw`) et
`MODELS_DOWNLOADS_SUBDIR` (`src/tts/engine-config.ts:63`), à partir duquel le code
**dérive** le chemin d'écriture `<models>/downloads` (plus de variable dédiée).
Le **code de téléchargement est absent** :
aujourd'hui, le bloc « Ce qui reste à faire à la main » de l'assistant **conserve**
donc l'action « déposer le fichier du modèle »
(`public/ui/tts-assistant.js:1535-1591`) — elle est **encore nécessaire**, et le
message le dit explicitement. Quand l'étape 2 sera livrée, cette action
**disparaîtra** (au moins pour la variante qui télécharge).

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

## 15. Renvois

- [`docs/lot7.md`](lot7.md) — spécification de référence du TTS (transport, voix, émotion).
- [`docs/lot8.md`](lot8.md) — assistant de mise en route, `server.json` attesté (`§11`), CosyVoice 3 (`§13`).
- [`docs/architecture.md`](architecture.md) — vue d'ensemble, carte des lots.
- [`deploy/server/README.md`](../deploy/server/README.md) — runbook de déploiement (bind `tts-config`).
