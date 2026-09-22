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
> **poursuit** celle des lots précédents : décisions **D46 → D58**, points
> ouverts **C30 → C36** (dernier `D45` : `docs/lot8.md:645` ; dernier `C29` :
> `docs/lot8.md:662`).

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
conçus pour s'y brancher (`/models-dl/downloads/`).

**Décisions produit intégrées** : le TTS doit rester testable/réglable **sans
terminal** ; toute action impossible depuis l'UI est **documentée honnêtement** ;
le **socket Docker reste refusé**.

---

## 1. Objet et périmètre

### Ce que fait le Lot 9, étape 1

1. **Montages** (M1/M2/M3, §3) : le gateway reçoit un **2ᵉ montage `rw`** du
   dossier des modèles (`/models-dl`, réservé aux téléchargements futurs) et le
   dossier de config du moteur (`/data/tts-config`) ; le moteur garde son
   dossier de config en **`ro`** (`/config`) et sa commande **inchangée**.
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
| Le moteur lit **un fichier** `server.json` **à son démarrage** | `command: ["server", "--config", "/config/server.json"]` (`docker-compose.yml:202`) |
| Un `rename` est **impossible** sur un fichier **bind-monté** ⇒ il faut monter un **dossier** | `docs/lot7.md` (approvisionnement) ; conception M2 §3 |
| Le gateway **n'a aucun accès Docker** (pas de socket) | `docker-compose.yml` (aucun `/var/run/docker.sock`), `docs/lot8.md` §2.1 |
| Le gateway tourne **non-root** (uid/gid `1000`) | `docker-compose.yml:84` (`user: "${YUKI_UID:-1000}:${YUKI_GID:-1000}"`), `infra/gateway/Dockerfile:49-50` |
| Le vocabulaire de tâche canonique est **`clon`** (jamais `clone`) | `src/tts/engine-config.ts:63-78`, `docs/lot8.md` §11.11 (`parse_voice_task_kind`) |
| `chatterbox`/`cosyvoice3` n'acceptent que **`offline`** | `src/tts/engine-config.ts:106`, `docs/lot8.md` §13.3 |
| Les 5 moteurs connus de Yuki | `src/tts/engine-config.ts:97-103` |

---

## 3. Montages M1 / M2 / M3

Trois montages, **un seul invariant à ne jamais violer** : **aucun montage du
moteur n'est `rw`** (le moteur ne fait que **lire** son environnement).

| # | Service | Hôte / volume | Cible conteneur | Mode | Rôle |
| --- | --- | --- | --- | --- | --- |
| **M1** | `gateway` | **même** dossier/volume modèles | `/models-dl` | **`rw`** | écriture **future** des téléchargements (`/models-dl/downloads/`) |
| — | `gateway` | dossier/volume modèles | `/models` | **`ro`** | lecture (invariant **conservé**) |
| **M2** | `gateway` | dossier de config du moteur | `/data/tts-config` | **`rw`** | écriture **atomique** de `server.json` |
| **M3** | `tts` | **même** dossier de config | `/config` | **`ro`** | lecture par le moteur à son démarrage |
| — | `tts` | dossier/volume modèles | `/models` | **`ro`** | lecture des GGUF (invariant **conservé**) |

**Preuves.** Compose de base (volumes nommés) : `docker-compose.yml:108-118`
(M1/M2), `:212-214` (M3, `read_only: true`), `:264-266` (volume
`yuki-tts-config`). Surcharge bind : `compose.bind.example.yml:48-56` (M1/M2),
`:69-72` (M3). Variante serveur autonome : `deploy/server/docker-compose.yml:60-63,117-118`
(gateway), `:205,212-214` (moteur).

**Justifications.**

- **M1** — le **même** dossier est monté **deux fois** dans le gateway : une fois
  `ro` (`/models`) pour la lecture/diagnostic, une fois `rw` (`/models-dl`) pour
  l'écriture **cloisonnée** au sous-dossier `downloads/` (`src/tts/engine-config.ts:31`
  `MODELS_DOWNLOADS_SUBDIR`). Le montage du **moteur** reste `ro`.
- **M2** — on monte un **dossier**, pas un fichier : l'écriture atomique
  (`tmp` + `rename`, `src/tts/engine-config.ts:257-263`) est **impossible** sur un
  fichier bind-monté. C'est la raison d'être de M2.
- **M3** — le moteur monte le **même dossier hôte** en `ro` sur `/config` ; la
  commande reste `server --config /config/server.json`. **Aucun** montage `rw`
  n'est ajouté au moteur.

**Préparation hôte (bind).** Les dossiers manquants sont créés par Docker en
`root:root` ; le conteneur (uid 1000) ne pourrait pas écrire. Sur l'hôte :

```bash
mkdir -p .local/tts-config .local/models
chown -R 1000:1000 .local/tts-config .local/models
```

**Volumes nommés.** Aucune préparation n'est nécessaire **si** le répertoire
existe déjà **dans l'image** avec le bon propriétaire : `infra/gateway/Dockerfile:73-74`
crée **et** `chown` `/models-dl` et `/data/tts-config` (patron de `/voices`).
Sans cela, Docker initialise le volume en `root:root` et le gateway **ne peut pas
écrire**. Preuve : `infra/gateway/Dockerfile:73` (`mkdir -p … /models-dl … /data/tts-config`),
`:74` (`chown -R "${YUKI_UID}:${YUKI_GID}" …`).

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
- **Corps** : `EngineConfigReport` (`src/tts/engine-config.ts:211-240`) —
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
  Erreurs portées par `EngineConfigError` (`src/tts/engine-config.ts:144-152`),
  mappées par `engineConfigErrorResponse` (`src/gateway/routes/tts.ts:959-975`).

### 4.3 `POST /api/tts/engine-config/revert`

- **Garde-fous** : `requireWriteGuards` (**requis**, y compris en l'absence de
  `.bak`). Preuve : test `tests/integration/tts-engine-config.test.ts:280-303`.
- **Réponses** : `200` (restauré), `404 no_backup`, `422 backup_invalid`,
  `500 backup_unreadable`/`config_write_failed`, `503` non câblé.
- **Sémantique** : `server.json.bak` → `server.json`, **atomiquement** ;
  le `.bak` **n'est pas** supprimé (`src/tts/engine-config.ts:975-1018`).

### 4.4 `GET /api/tts/capabilities`

- **Garde-fous** : aucun (lecture) ; ne fait qu'une **sonde** (§8).
- **Réponse** : **`200` toujours**, même moteur injoignable
  (`unloadModels: null`). Preuve : test
  `tests/integration/tts-engine-config.test.ts:334-346`.

**Traduction des chemins.** Le `path` **stocké** est **toujours** le chemin **vu
par le moteur** (`/models/…`). Le gateway accepte en écriture un chemin vu par
lui (`/models` **ou** `/models-dl`) et le **traduit**
(`EngineConfigStore.toEnginePath`, `src/tts/engine-config.ts:607-629`).

---

## 5. Listes fermées et validations (preuves)

| Champ | Valeurs autorisées | Comportement | Preuve |
| --- | --- | --- | --- |
| `task` | jetons canoniques `vad\|asr\|diar\|sep\|gen\|tts\|clon\|vc\|s2s\|align\|vdes\|spk\|svc\|midi` | `clone` **refusé** avec un message nommant `clon` | `src/tts/engine-config.ts:63-78`, `:384-394` ; `public/ui/engine-config-patch.js:16-32` |
| `mode` | `offline\|streaming` | `offline` **obligatoire** pour `chatterbox`/`cosyvoice3` | `src/tts/engine-config.ts:81`, `:106`, `:396-411` |
| `family` | `chatterbox\|qwen3-tts\|cosyvoice3\|kokoro\|sanotts` | hors liste ⇒ `400` | `src/tts/engine-config.ts:84-90` |
| `id` | les **5** valeurs de `tts.engine` | hors liste ⇒ **accepté mais signalé** (`report.warnings`) | `src/tts/engine-config.ts:97-103`, `:730-734` |
| `path` | un `.gguf` **présent** dans les montages | hors montages ⇒ refusé ; `..` interdit ; absolu requis | `src/tts/engine-config.ts:414-438`, `:909-917` |

**Idempotence UI** : les mêmes listes sont appliquées **côté navigateur** (avant
envoi) pour un retour immédiat (`validateModelDraft`,
`public/ui/engine-config-patch.js:96-140`), et **revalidées côté serveur** — on
ne fait pas confiance au client.

**`clone` au lieu de `clon`** : la saisie est impossible via l'UI (le `task` est
un `<select>` alimenté par la liste), et un envoi direct est refusé **`400`**
avec `models[0].task` dans `fields[]` (test
`tests/integration/tts-engine-config.test.ts:242-254`).

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
  `src/tts/engine-config.ts:840-945`, tests
  `tests/tts/engine-config.test.ts` (« préserve les clés inconnues… »,
  « conserve les clés inconnues d'une entrée réécrite »).
- **Écriture atomique.** `tmp` + `rename` dans le **même** dossier (M2), mode
  `0o644`, aucun fichier `.tmp-*` résiduel. Preuve :
  `src/tts/engine-config.ts:257-263`, test « écrit de façon ATOMIQUE ».
- **Sauvegarde unique.** Avant chaque écriture, l'ancien contenu devient
  `server.json.bak` (**une** version précédente). Preuve :
  `src/tts/engine-config.ts:947-973`, test « conserve UNE sauvegarde ».
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
  `tests/integration/tts-engine-config.test.ts:179-186`.
- **Écriture** : `PUT` répond `503 config_dir_not_mounted` — **jamais** `500`.
  Preuve : test `tests/integration/tts-engine-config.test.ts:256-265`.
- **Lecture disque** : `report()` n'appelle `probeWritable` que si le dossier
  **existe** ⇒ aucune création de dossier par une lecture (rootfs gateway
  `read_only: true`). Preuves : `src/tts/engine-config.ts:638-666`, test « ne crée
  jamais le dossier de config lors d'une lecture ».

---

## 8. Sonde de capacités (sans effet de bord)

On ne veut **jamais** décharger un modèle réellement utilisé en « testant » une
route. La sonde envoie donc un **id sentinelle** qui ne peut correspondre à
aucun modèle : `__yuki_capability_probe__`
(`src/tts/engine-config.ts:1049`, `:1119`).

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

Les montages et chemins sont **prêts** : `M1` (`/models-dl`, `rw`) et le
sous-dossier `downloads/` (`MODELS_DOWNLOADS_SUBDIR`,
`src/tts/engine-config.ts:31`). Le **code de téléchargement est absent** :
aujourd'hui, le bloc « Ce qui reste à faire à la main » de l'assistant **conserve**
donc l'action « déposer le fichier du modèle »
(`public/ui/tts-assistant.js:1535-1590`) — elle est **encore nécessaire**, et le
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
   mkdir -p <hôte>/tts-config <hôte>/models
   chown -R 1000:1000 <hôte>/tts-config          # le conteneur écrit ici
   # <hôte>/models : lecture seule côté moteur, mais le gateway écrit dans
   # /models-dl (mêmes permissions 1000:1000 nécessaires pour l'étape 2).
   ```

   Pour des **volumes nommés**, cette étape est inutile : le Dockerfile crée et
   `chown` déjà `/models-dl` et `/data/tts-config`
   (`infra/gateway/Dockerfile:73-74`).

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
| `npm test` | **626 passed / 4 skipped** (dont +2 : `tests/ui/ui-modules-defined.test.ts`) — avant ce lot : `624 passed / 4 skipped` |
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
| **D46** | **M1 — second montage `rw` du dossier modèles** sur un chemin **distinct** (`/models-dl`), `/models` **reste `ro`** ; écriture future **cloisonnée** à `/models-dl/downloads/`. | `docker-compose.yml:108-111`, `compose.bind.example.yml:44-49`, `src/tts/engine-config.ts:31` |
| **D47** | **M2 — le gateway monte le DOSSIER de config du moteur en `rw`** (`/data/tts-config`) : nécessaire à l'écriture **atomique** (`rename` impossible sur un fichier bind-monté). | `docker-compose.yml:112-118`, `src/tts/engine-config.ts:257-263` |
| **D48** | **M3 — le moteur monte le dossier de config en `ro`** sur `/config` ; **commande inchangée** (`server --config /config/server.json`) ; **aucun** montage moteur `rw`. | `docker-compose.yml:202,212-214`, `deploy/server/docker-compose.yml:205,212-214` |
| **D49** | **Listes fermées** : `task` canonique (`clon`, **jamais** `clone`), `mode` `offline\|streaming`, `family` fermée — validation **client ET serveur**. | `src/tts/engine-config.ts:63-90`, `public/ui/engine-config-patch.js:16-59` |
| **D50** | **`offline` obligatoire** pour `chatterbox`/`cosyvoice3` (tout autre mode refusé, `mode_not_supported`). | `src/tts/engine-config.ts:106,396-411` |
| **D51** | **`id` = les 5 valeurs de `tts.engine`** ; un id hors liste est **accepté mais signalé** (le moteur le charge, Yuki ne saura pas le sélectionner). | `src/tts/engine-config.ts:97-103,730-734` |
| **D52** | **`path` choisi parmi les `.gguf` présents** ; chemin **stocké = vue moteur** ; traduction gateway↔moteur explicite ; hors montages refusé. | `src/tts/engine-config.ts:607-629,909-917` |
| **D53** | **Préservation fidèle** des clés inconnues (top-level et par entrée de même `id`) lors du patch. | `src/tts/engine-config.ts:840-945` |
| **D54** | **Écriture atomique** (`tmp`+`rename`) + **`server.json.bak`** (une version) + **route de restauration**. | `src/tts/engine-config.ts:257-263,947-1018`, `src/gateway/routes/tts.ts:999-1008` |
| **D55** | **Rétro-compatibilité** : sans M2, `GET` `200` avec `mounted:false` et `PUT` `503 config_dir_not_mounted` ; **rien ne casse**. | `src/gateway/routes/tts.ts:952-956`, `tests/integration/tts-engine-config.test.ts:179-186,256-265` |
| **D56** | **Sonde de capacités sans effet de bord** (id sentinelle) ; la fonction n'est montrée que si la route est **confirmée**. | `src/tts/engine-config.ts:1047-1161`, `public/ui/engine-config-patch.js:394-405` |
| **D57** | **Socket Docker refusé** ; l'UI ne prétend jamais redémarrer un conteneur : elle décrit le chemin « redémarrer `tts` depuis votre UI Docker ». | `public/ui/engine-config-patch.js:235-248`, `docs/lot8.md` §2.1 |
| **D58** | **UI vanilla sans build, CSP stricte, thèmes 5×2, réutilisation de l'existant**, plus un **garde-fou statique anti-symbole-non-défini** (auto-testé). | `public/ui/tts-assistant.js:28-41`, `tests/ui/ui-modules-defined.test.ts` |

### À confirmer

| # | Point ouvert | Impact |
| --- | --- | --- |
| **C30** | Le **chemin `/config/server.json`** est un **choix Yuki** (le WORKDIR de l'image `audio.cpp` n'est **pas attesté**) ; le chemin d'origine `/app/server.json` reste possible via `YUKI_TTS_ENGINE_CONFIG_DIR`. **À confirmer** en réel sur le conteneur. | M3 / déploiement |
| **C31** | **Écriture réelle** du gateway dans le dossier monté `rw` : confirmer les permissions bind (`chown 1000:1000`) sur l'hôte Unraid (et non seulement les volumes nommés, préparés par l'image). | M2 / runbook §11 |
| **C32** | **Pré-déclaration des modèles** : pré-remplir `models[]` depuis les `.gguf` présents (`report.diskModels`) ? Aujourd'hui, non. | UX §10.2 |
| **C33** | **Existence réelle de `POST /v1/tasks/unload_models`** : la sonde la **teste** sans effet de bord, mais le lot ne **re-vérifie pas** son contrat (corps/statuts exacts). | §8 |
| **C34** | **Ordre et format** du JSON après aller-retour : les clés inconnues sont **conservées**, mais l'ordre/indentation sont **réécrits** par `JSON.stringify(…, 2)`. Acceptable ? | §6 |
| **C35** | **Téléchargement (étape 2)** : source des URLs, vérification d'intégrité (hash), reprise après interruption, garde de taille. | §10.1 |
| **C36** | **`max_loaded_models` / éviction LRU** : le comportement réel du moteur (défaut `0` = illimité) n'est **pas re-vérifié ici**. | §5 / `docs/lot8.md` D45 |

---

## 14. Renvois

- [`docs/lot7.md`](lot7.md) — spécification de référence du TTS (transport, voix, émotion).
- [`docs/lot8.md`](lot8.md) — assistant de mise en route, `server.json` attesté (`§11`), CosyVoice 3 (`§13`).
- [`docs/architecture.md`](architecture.md) — vue d'ensemble, carte des lots.
- [`deploy/server/README.md`](../deploy/server/README.md) — runbook de déploiement (bind `tts-config`).
