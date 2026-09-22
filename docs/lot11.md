# Lot 11 — Paramétrage par l'interface web

> Implémentation du **Lot 11 : paramétrage par l'interface web**. Ce document
> résume la spécification validée, les décisions et les invariants. Il complète
> [`docs/architecture.md`](architecture.md) et [`docs/runbook.md`](runbook.md).

## Objectif

Réduire le `.env` (et le bloc `environment:` des composes) à **5 variables** et
rendre **tout le reste configurable depuis une page `/config`**, **y compris les
deux clés LLM** — l'utilisateur peut changer de fournisseur/modèle/clé **sans
terminal sur le serveur**.

`.env` cible (racine et `deploy/server/`) :

```dotenv
YUKI_UID=1000
YUKI_GID=1000
YUKI_VERSION=test
YUKI_GATEWAY_PORT=8083
YUKI_LOG_LEVEL=info
```

## Trois invariants non négociables

1. **Le paramétrage ne dépend jamais du fonctionnement applicatif.** La page
   `/config` et l'API de configuration sont servies par `node:http`
   **indépendamment** de la porte GPU, du `PiHost` et des clés LLM : aucune clé →
   `/health/ready` = **503** → saisie des clés dans la page → `/health/ready` =
   **200**. La page reste pleinement utilisable en mode dégradé.
2. **Précédence explicite et visible** : `défauts (code) < store (page web) <
   environnement`. L'environnement ne participe **que s'il est défini et non
   vide** ; quand il l'est, le champ est **verrouillé** (`origin: "env"`, badge
   avec le nom de la variable) et un `PUT` le visant est **refusé** avec le code
   `locked_by_env` — **jamais de no-op silencieux**. Comme les composes sont
   vidés de toute variable configurable, aucun champ n'est verrouillé en
   déploiement normal.
3. **Les secrets ne sortent jamais en clair.** Le store les contient (réseau
   privé), le fichier est en **`0600`**, les logs les masquent, et l'API ne
   renvoie **jamais** la valeur d'une clé (uniquement `configured` + `masked`).

## Domaine `src/config/`

| Fichier | Rôle |
| --- | --- |
| `schema.ts` | **Table unique** de descripteurs `{ type, default, enum?, min?, max?, apply, secret?, env? }` + validation (~40 lignes). Source unique des bornes/énumérations, réutilisée par `env.ts` (surcharges) et l'API (patch). |
| `store.ts` | `ConfigStore` : lecture/écriture **atomique** (`tmp` + `rename`), **`0600`**, JSON **sparse**, `schemaVersion`. Repli **sans jamais écraser** (fichier absent → défauts ; JSON invalide / `schemaVersion` inconnue → défauts + log, fichier conservé). Une **écriture** impossible lève une `ConfigStoreWriteError` (cause système traduite : `EACCES`, `EROFS`, `ENOSPC`…) → réponse HTTP **exploitable** (`500 config_store_unwritable` + message), jamais un 500 muet. |
| `runtime.ts` | `ConfigRuntime` : combine store + env + défauts (`get`/`update`/`subscribe`), **pont des clés** vers `process.env`, valeurs à masquer pour le logger, import unique de `models.json`. |
| `env.ts` | **Câblage** uniquement (ports, chemins, montages, identité, GPU source, chemins Pi/jobs/store) + `readConfigEnvOverrides` (surcharges env des champs du store). |
| `paths.ts` | `resolveConfigStorePath` (volume `state`, surcharge `YUKI_CONFIG_STORE_PATH`). |

**Aucun import du SDK Pi ni de `typebox`** dans `src/config/**` — garanti par le
test de frontière (`tests/pi/boundary.test.ts`).

## Champs exposés par la page (et défauts)

- **LLM léger** : `api` (`openai-completions`), `baseUrl` (`https://ollama.com/v1`),
  `model` (`gemma4:31b`), `thinking` (`off`), **`apiKey`** (vide) — `apiKey` est
  **à chaud**, le reste **au redémarrage**.
- **LLM lourd** : idem, `model` (`deepseek-v4.1-flash`), `thinking` (`high`).
- **`llm.missingKeyMode`** : `degrade` (défaut) | `refuse` — redémarrage.
- **Délégation** : `defaultDeadlineMs` (1500, bornes 200–60000, **à chaud**),
  `maxConcurrent` (3), `maxQueue` (10), `idleTimeoutMs` (120000),
  `totalTimeoutMs` (1200000) — redémarrage.
- **GPU** : `compatMode` (`strict`), `profile` (vide = auto), `minDriver` (580).
- **Prompts système** : léger + lourd, défaut = **contenu des fichiers livrés**
  (`config/pi/system-prompt.md`, `config/pi/system-prompt-heavy.md`).
- **Transport** : `replayBuffer` (1000), `replayBytes` (5000000).

**Restent hors store (câblage, env uniquement)** : `YUKI_UID`, `YUKI_GID`,
`YUKI_VERSION`, `YUKI_GATEWAY_PORT`, `YUKI_LOG_LEVEL`, `YUKI_GATEWAY_HOST`,
`YUKI_CONFIG_DIR`, `YUKI_MOUNT_*`, les `YUKI_PI_*_DIR`/`HOME`/`YUKI_PI_CWD`/
`YUKI_PI_SYSTEM_PROMPT`/`YUKI_PI_HEAVY_SYSTEM_PROMPT`/`YUKI_PI_SETTINGS_SEED`,
`YUKI_JOBS_STORE_PATH`, `YUKI_CONFIG_STORE_PATH`, `YUKI_GPU_CMD`,
`YUKI_GPU_FIXTURE`.

> ⚠️ Parmi ces variables, celles qui ne définissent qu'un **chemin INTERNE au
> conteneur** (`YUKI_MOUNT_*`, `YUKI_TTS_CONFIG_DIR`/`YUKI_TTS_ENGINE_*_DIR`,
> `YUKI_PI_*`, `YUKI_CONFIG_DIR`, `HOME`, `PI_CODING_AGENT_*`, `YUKI_VOICES_DIR`,
> `YUKI_*_STORE_PATH`) sont des **défauts du code**
> (`src/config/container-paths.ts`), **jamais** renseignées dans les composes : le
> compose n'explicite que ses montages (`volumes: … target:`). La surcharge reste
> **lue** (rétro-compatibilité) — voir `docs/lot9.md` (**D61**).

> **Catalogue complet = la page `/config`.** Le `.env` ne documente que le
> câblage. Les variables de surcharge d'environnement (`YUKI_LLM_*`,
> `YUKI_HEAVY_*`, `YUKI_COMPAT_MODE`, `YUKI_PROFILE`, `YUKI_MIN_DRIVER`,
> `YUKI_WS_REPLAY_*`, `YUKI_LLM_MISSING_KEY_MODE`) existent toujours mais
> **verrouillent** le champ visé : à n'utiliser que sciemment.

## Ordre d'initialisation (critique)

1. charger la configuration (store + env + défauts) ;
2. **pont des clés → `process.env`** ;
3. **puis** créer le logger (sa redaction capte les clés du store) ;
4. **en plus**, passer explicitement les clés du store au logger.

Sans cet ordre, une clé issue du store **fuiterait dans les logs**.

## API de configuration (`src/gateway/routes/config.ts`)

- **`GET /api/config`** → `200` **même sans aucune clé** et en mode dégradé.
  Chaque feuille : `{ value, origin, apply, lockedByEnv? }`. Pour chaque **clé** :
  **uniquement** `{ configured, source, masked, lockedByEnv? }` (`masked` = 4
  derniers caractères précédés de `••••`, ex. `••••c0de`). La valeur complète
  n'est **jamais** sérialisée (testé sur le corps brut).
- **`PUT /api/config`** → patch **partiel fusionnant** : champ omis = conserver,
  chaîne non vide = remplacer, `null` = effacer, chaîne vide/espaces = **erreur**
  (`empty_api_key`). Réponse = `GET` + `applied: { hot, restart }`. Erreurs :
  `400 { error, fields: [{ path, code, message }] }` (messages français
  exploitables). Champ verrouillé → `400` + `code: "locked_by_env"` + variable.
- **`POST /api/config/llm/test`** → `{ role, apiKey? }`, test via **`fetch`
  natif** sur `GET {baseUrl}/models` (compatible OpenAI), timeout ~5 s, **hors
  SDK**. `{ ok, status?, models?, error? }` — permet de tester **avant**
  d'enregistrer (précieux au premier démarrage).
- **`POST /api/admin/restart`** (redémarrage) → mêmes garde-fous que les
  écritures (`X-Yuki-Config` + `Origin`/`Host`). Journalise
  (`admin.restart_requested`), répond **`200 { ok: true, restarting: true }`**,
  puis **planifie l'arrêt gracieux** (~300 ms plus tard) via le chemin de
  `installGracefulShutdown` (fermeture des sockets WS puis `server.close()`) —
  jamais `process.exit()` brutal, jamais le socket Docker. Ce chemin est le
  **seul** à sortir avec le code **`75`** (`EX_TEMPFAIL`) : le **superviseur
  interne à l'image** (`infra/gateway/supervisor.mjs`, `ENTRYPOINT`) relance
  alors `dist/index.js` **dans le conteneur**, qui **reste en place**. Les
  autres sorties (erreur fatale, refus de démarrage, `SIGTERM`) gardent leur
  code — une vraie panne est **propagée**, jamais masquée. La fonction d'arrêt,
  le planificateur ET la fonction de sortie sont **injectables** : les tests
  vérifient « 200 + demande d'arrêt » et le code émis sans tuer le processus de
  test.

Les routes existantes (`/health*`, `/version`, `/ui/**`, `HEAD`, `405`) restent
inchangées.

### Précautions minimales (le durcissement complet est au Lot 9)

- **En-tête personnalisé** `X-Yuki-Config: 1` exigé sur `PUT`/`POST`.
- **Contrôle `Origin`/`Host`** : si un `Origin` est présent, il doit correspondre
  au `Host` (même origine).
- **Journal d'audit** : chaque modification est journalisée (`config.changed` :
  chemin, `from`→`to` **sans valeur de secret**, horodatage).

## Page `/config` (`public/ui/config.html` + `config.js`)

- Route `/config` servie par `static.ts` (mêmes en-têtes de sécurité), lien
  depuis `index.html`. Vanilla, `type="module"`, **aucune chaîne de build**.
- **Retour explicite** vers la conversation : bouton/lien « **← Retour à la
  discussion** » (`href="/"`) dans l'en-tête — le lien implicite du titre n'était
  pas trouvé. Le retour fonctionne dans les deux sens (accueil ⇄ configuration).
- **Redémarrer** : bouton dans une section dédiée (sous « Résultat de
  l'enregistrement »), avec avertissement (interruption du travail en cours),
  confirmation, état de progression (poll `/health/live` puis rechargement) et
  message d'échec. Le texte annonce un **redémarrage interne** : Yuki relance son
  programme **dans le conteneur** (superviseur), **le conteneur reste en place**
  — plus de dépendance à la politique de redémarrage Docker pour ce bouton.
- **Pleine largeur** : l'interface (`.conversation`, `.thinking-indicator`,
  `.config`) n'a **plus de colonne centrée** ; les bulles de message restent
  seulement **plafonnées** (`min(78%, 900px)`) pour la lisibilité. Aucun layout
  complexe : uniquement du CSS.
- **Secrets** : champ `type="password"`, **vide même si une clé existe**. Si
  `configured=true` : « Clé configurée (••••c0de) » + boutons **Remplacer** /
  **Effacer**. La valeur saisie n'est **jamais** re-remplie dans le DOM après
  enregistrement.
- Validation légère côté client (types, bornes `input[type=number]`, `select`
  pour les énumérations) mais **le serveur reste autoritaire** : erreurs
  `fields[]` affichées **sous le champ**.
- Après enregistrement : deux listes explicites « **Appliqué sans redémarrage** »
  et « **Prendra effet au prochain redémarrage** ». Chaque champ porte un badge
  `à chaud` / `redémarrage`. Champs `origin:"env"` → **désactivés** + badge
  « Verrouillé par l'environnement (`NOM_VAR`) ».
- Affiche l'état réel (`status.lightKey/heavyKey/ready`, complété par un poll de
  `/health/ready`) et, s'il n'y a pas de clé, « **la conversation est
  indisponible — saisissez une clé** ».

## À chaud vs redémarrage

- **À CHAUD** : les **clés LLM** (besoin explicite). La disponibilité = **présence
  de clé** (aucun réseau) : la bascule `/health/ready` 503 → 200 est
  **immédiate**, sans redémarrage. `llmAvailable` est devenu une **fonction** lue
  en direct, et les clés sont poussées dans `process.env`.
  `delegation.defaultDeadlineMs` est aussi à chaud.
- **REDÉMARRAGE** : tout le reste — `baseUrl`/`api`/`model`/`thinking` (implique
  de régénérer `models.json` et de recréer le runtime de modèles), les prompts,
  `llmMissingKeyMode`, les tailles de file et timeouts, le GPU, le transport. La
  valeur est **persistée** mais **pas** appliquée au runtime courant ; la réponse
  le **signale**. **Aucune reconstruction à chaud du `PiHost`** (Lots ultérieurs).

## `models.json` devient GÉNÉRÉ (le point structurant)

Avant : `sdk-host.ts` **seedait** `models.json` (copie-si-absent depuis
`config/pi/models.json`, jamais écrasé) — changer de provider imposait d'**éditer
un fichier dans un volume**. Désormais :

1. `src/llm/models.ts` expose un générateur **pur** `buildModelsConfigFrom(configEffective)`
   (testable) ; `src/index.ts` génère l'objet et le confie au host ;
2. `src/pi/config.ts` : `seedModelsFile` **remplacé** par `writeModelsFile(paths, json)`
   (écriture **atomique**, **toujours réécrite**) ; `settings.json` **conserve**
   son seed ;
3. le **seed de `models.json` est supprimé** (`YUKI_PI_MODELS_SEED` retiré des
   composes et d'`env.ts`) ;
4. `config/pi/models.json` **reste** la référence par défaut : il doit rester
   **égal** à `buildModelsConfigFrom(défauts)` — le test
   « le code ne dérive pas du fichier » teste désormais le générateur ;
5. **aucune clé en clair** : le générateur conserve la référence
   `apiKey: "$YUKI_LLM_LIGHT_API_KEY"` (la vraie clé passe par le pont
   `process.env`) ;
6. **import unique** : si le store est **vide** et qu'un `models.json` existe sur
   le volume, `baseUrl`/`api`/modèle sont importés **au mieux** par provider
   (try/catch, journalisé), puis le fichier est régénéré — aucune config manuelle
   existante n'est perdue.

## Sécurisation — préparée, PAS implémentée (Lot 9)

Ce lot **ne code aucune authentification**. Il **prépare** le Lot 9 :

- **Authentification** : toute la surface de configuration passe par un module
  unique (`routes/config.ts`) et un runtime unique (`ConfigRuntime`) —
  l'ajout d'un middleware d'authentification (a minima sur `/api/config`) ne
  touche que ce point d'entrée. La page reste **utilisable au premier
  démarrage** malgré l'auth à venir : l'auth devra prévoir un amorçage (token
  initial) sans dépendre de l'état applicatif.
- **Secrets au repos** : les secrets sont **isolés dans un fichier unique**
  (`/data/state/config.json`, `0600`, volume `state`), hors de `models.json` et
  des logs. Le chiffrement/dispensation du Lot 9 peut se faire **sans refonte**
  (le store est la seule source des secrets).
- **Audit** : un journal `config.changed` existe déjà (chemin, from→to sans
  valeur de secret, horodatage) ; le Lot 9 le complètera (acteur, IP).
- **Réseau/TLS** : le test LLM est la **seule sortie réseau** du domaine config
  (requête utilisateur, `fetch` natif, timeout court, hors SDK) ; le Lot 9
  ajoutera limitation/allowlist et TLS.

## Critères d'acceptation (vérifiés localement)

Tests vitest (`tests/config/**`, `tests/gateway/config-api.test.ts`,
`tests/llm/tool-policy.test.ts`, `tests/pi/boundary.test.ts`) :

- écriture **atomique**/`0600`/sparse/`schemaVersion` ;
- fichier absent → défauts ; **JSON invalide → défauts + fichier conservé** ;
- précédence `défauts < store < env` et **verrou `locked_by_env`** ;
- `GET /api/config` **sans clé en clair** et fonctionne **sans aucune clé** ;
- `PUT` : validation, remplacement/effacement (`null`), `empty_api_key`,
  `applied.hot` vs `applied.restart` cohérents ;
- `buildModelsConfigFrom(défauts)` **égale** `config/pi/models.json` et **aucune
  clé en clair** ;
- frontière : `src/config/**` n'importe **ni SDK ni typebox** ;
- page `/config` servie avec en-têtes sûrs.

**Par le smoke test conteneur (CI, fixture GPU)** — voir
`scripts/ci-smoke.sh` : démarrage **sans aucune clé** → `/health/ready` = **503**
et `GET /api/config` = **200** (`lightKey=false`) ; puis `PUT` avec des clés
**fictives** → `GET` renvoie `configured=true` **sans jamais** exposer la valeur
et **`/health/ready` passe à 200** (aucun réseau requis) ; conteneur **non-root /
rootfs read-only** ; `models.json` **généré** dans le volume `pi` et store dans
`state`.

**Sur le serveur (non vérifiable en local)** : vraie clé + conversation de bout
en bout ; persistance après redémarrage ; profil GPU forcé depuis la page ;
changement de modèle effectif après redémarrage.

## Périmètre exclu

Aucune authentification (Lot 9) ; aucun chiffrement au repos ; aucune
reconstruction à chaud du `PiHost` ; aucune nouvelle dépendance ; aucune chaîne
de build front ; aucun framework de configuration ; aucune édition depuis la
page des manifests (`gpu-profiles.json`, `compat-manifest.json`) ni des réglages
du SDK (`settings.json`).
