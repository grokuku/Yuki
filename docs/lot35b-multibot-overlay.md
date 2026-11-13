# Lot 35b — multi-bot, étape 2 : OVERLAY de configuration + verrou de classification

> Sous-lots livrés : **1b-1** (overlay) et **1b-2** (verrou). Rien de VISIBLE :
> ni page, ni route, ni écran de bot (ce sera 1b-3/1b-4). Le produit se comporte
> **exactement** comme avant ; seuls le lieu d'écriture et la lecture changent.

## 1. Deux stores, jamais imbriqués

| Store | Fichier | Portée | Format |
| --- | --- | --- | --- |
| commun | `<state>/config.json` (`env.configStorePath`) | l'INSTANCE | `{ schemaVersion, values }` |
| overlay | `<state>/bots/<id>/config.overlay.json` | le BOT ACTIF | **plat** `{ "clé": valeur }` |

- Écriture **atomique** (`tmp` + `rename`) en **0600** pour les deux, par la
  MÊME fonction (`writeFileAtomic0600`, `src/config/store.ts:93`) : une seule
  mécanique d'écriture, donc une seule erreur possible
  (`ConfigStoreWriteError`, cause système traduite).
- L'overlay est **plat** et volontairement sans enveloppe : il se lit à l'œil
  (`cat`), et supprimer l'overlay d'un bot ne touche aucun réglage d'instance.
- Chemin résolu par `resolveConfigOverlayPath` (`src/config/paths.ts:60`), avec
  la convention de dossier du lot 35a (`bots/<id>`, `src/bots/paths.ts:21`).
  Le bot actif vient de `preparerMultiBot` (`src/index.ts:277`) ;
  `BOT_ID_DEFAUT = "yuki"` (`src/config/overlay.ts:37`) est le repli en mode
  mono-bot historique — un test verrouille `BOT_ID_DEFAUT === BOT_YUKI`.
- Fichier absent ⇒ aucune surcharge. Fichier **illisible** ⇒ aucune surcharge,
  fichier **conservé tel quel** et **avertissement** (jamais d'écrasement de ce
  qu'on n'a pas su lire). Une entrée `instance` trouvée dans l'overlay est
  **ignorée** et **dite**.

## 2. Merge : un seul chemin de lecture

`ConfigRuntime.get()` (`src/config/runtime.ts:307`) est le **seul** point de
lecture de la configuration. Vérifié, puis **verrouillé par un test**
(`tests/config/schema-scope.test.ts`, § « le merge est le chemin de lecture
unique ») : `new ConfigStore(` n'existe QUE dans `src/config/runtime.ts:191`,
et aucun fichier hors `src/config/` ne cite `CONFIG_SCHEMA`, `descriptorOf` ou
`configStorePath` (commentaires exclus). Un second store ouvert ailleurs lirait
`config.json` sans l'overlay et ignorerait la configuration du bot **en
silence** : c'est précisément ce que ce garde-fou interdit.

Précédence : **`env` > overlay du bot > store commun > défaut**.

| `scope` | Règle |
| --- | --- |
| `instance` | store commun, puis défaut. L'overlay n'est **jamais** lu. |
| `bot` | overlay s'il a la clé, sinon store commun (valeur de **repli**, cas des installations d'avant le lot), sinon défaut. |
| `mixte` + `surcharge` | idem `bot` : l'overlay **remplace** la valeur commune. |
| `mixte` + `et` | **conjonction** : le côté explicitement renseigné doit valoir `on`. Instance `off` ⇒ `off` même si le bot est `on` ; un côté **absent** n'impose rien (neutre = `on`) ; **les deux** absents ⇒ **défaut du schéma**. |

⚠️ **Pourquoi le neutre pour un côté absent** : sans lui, une clé jamais réglée
serait `off` par accident, et « Activer la voix » depuis `/config` n'aurait plus
aucun effet (le côté instance restant au défaut `off`). C'est le seul choix qui
laisse le comportement observable **identique** — vérifié par
`tests/config/overlay-bot.test.ts` (« activer la voix depuis la page reste
effectif ») et par `e2e-tts-ui`.

`originOf()` compte une valeur d'overlay comme `store` : l'UI ne change pas.

## 3. Écriture : aiguillage par portée

`update(patch, { portee })` (`src/config/runtime.ts:467`) :

| `portee` | `scope: instance` | `scope: bot`/`mixte` |
| --- | --- | --- |
| `auto` (défaut) | store commun | **overlay du bot actif** |
| `instance` | store commun | store commun (seul moyen d'écrire le côté « instance » d'une clé mixte) |
| `bot` | store commun (une clé d'instance n'a pas d'équivalent par bot) | overlay |

- Chaque fichier n'est réécrit **que s'il a changé** : un patch de clés de bot
  ne fait pas clignoter `config.json`, et réciproquement. **Aucune clé de bot
  n'est jamais écrite dans `config.json`.**
- `null` (« Réinitialiser au défaut ») efface la clé de sa cible **et** du store
  commun quand elle y traînait : le DÉFAUT revient vraiment (sinon une valeur
  héritée d'avant le lot, ou le côté instance d'une clé mixte, continuerait de
  s'appliquer et le bouton semblerait sans effet).
- Le journal d'audit (`changes`) et `applied.hot`/`restart` sont **inchangés**.

## 4. Verrou de classification (`src/config/schema.ts:75-127`)

`FieldDescriptor` est désormais une **union discriminée par `scope`** :

- `scope` est **obligatoire** sur les 89 clés : **66 `instance` / 18 `bot` /
  5 `mixte`** ;
- `env` est **interdit** dès que `scope !== "instance"` — c'est le
  **compilateur** qui le dit (`env?: never` sur `BotFieldDescriptor` et
  `MixteFieldDescriptor`), et `tests/config/schema-scope.test.ts` le
  revérifie sur la donnée ;
- `mixte` ⇒ `mixteMerge` **déclaré** (`surcharge` | `et`), jamais deviné ;
  `et` n'est utilisé que sur des enums `off|on` (la conjonction n'a pas d'autre
  sens) ;
- les 19 clés `bot` : `chat.mode`, `chat.mattermost.enabled`,
  `chat.mattermost.url` (ajoutée le 2026-11-13 : SURCHARGE par bot de l'ancien
  paramètre `chat-mirror.json` → `baseUrl`, Mattermost étant auto-hébergé), `chat.discord.enabled`, `chat.remoteAgents`,
  `chat.remoteTools`, `chat.discord.guildId`, `chat.discord.maxUploadBytes`,
  `tts.voice`,
  `tts.emotion`, `tts.speed`, `tts.exaggeration`, `tts.cfg`, `memory.enabled`,
  `memory.recall.{topK,budgetChars,timeoutMs}`,
  `memory.extract.{maxItems,timeoutMs}`,
  `memory.setAside.{maxChars,maxChunks}` ;
- les 5 clés `mixte` : `tts.enabled`, `memory.consolidation.enabled`,
  `push.enabled` (`et`) ; `prompts.light`, `prompts.heavy` (`surcharge`).

### Les 8 cas douteux (classés `instance`, signalés dans la table)

`tts.volume`, `tts.prefetchDepth`, `tts.minSentenceChars`,
`tts.maxSentenceChars`, `recap.timeoutMs`, `sources.promptTotalChars`,
`memory.consolidation.cron`, `memory.consolidation.timeZone`.
Raison : ce sont des réglages de **pipeline** (segmentation, budget, cadence de
la passe d'archive), pas des traits de personnalité du bot. `tts.voice` et la
palette d'émotion sont, elles, des traits **du bot**.

## 5. ⚠️ Rupture de déploiement ASSUMÉE : 21 variables d'environnement retirées

Une variable d'environnement est une valeur d'**installation** : elle ne peut
pas désigner « le bot actif ». Les 21 variables des clés `bot`/`mixte` sont donc
**retirées** et **annoncées** au démarrage si un déploiement les définit encore
(`ConfigRuntime.warnings`, message « variable d'environnement RETIRÉE ») — une
variable qui n'agit plus doit être dite, jamais supprimée en silence.

Liste complète — table `VARIABLES_ENV_RETIREES` (`src/config/schema.ts:1234`),
avec la clé de configuration correspondante (⚠️ pour POUVOIR migrer sans
deviner : l'utilisateur de cette installation ne les employait pas, un futur
lecteur de la doc doit pouvoir retrouver l'équivalent) :

| Variable retirée | Clé équivalente | Portée |
| --- | --- | --- |
| `YUKI_TTS_ENABLED` | `tts.enabled` | `mixte` + `et` |
| `YUKI_TTS_VOICE` | `tts.voice` | `bot` |
| `YUKI_TTS_EMOTION` | `tts.emotion` | `bot` |
| `YUKI_TTS_SPEED` | `tts.speed` | `bot` |
| `YUKI_TTS_EXAGGERATION` | `tts.exaggeration` | `bot` |
| `YUKI_TTS_CFG` | `tts.cfg` | `bot` |
| `YUKI_MEMORY_ENABLED` | `memory.enabled` | `bot` |
| `YUKI_MEMORY_TOP_K` | `memory.recall.topK` | `bot` |
| `YUKI_MEMORY_BUDGET_CHARS` | `memory.recall.budgetChars` | `bot` |
| `YUKI_MEMORY_TIMEOUT_MS` | `memory.recall.timeoutMs` | `bot` |
| `YUKI_MEMORY_MAX_ITEMS` | `memory.extract.maxItems` | `bot` |
| `YUKI_MEMORY_EXTRACT_TIMEOUT_MS` | `memory.extract.timeoutMs` | `bot` |
| `YUKI_MEMORY_SET_ASIDE_MAX_CHARS` | `memory.setAside.maxChars` | `bot` |
| `YUKI_MEMORY_SET_ASIDE_MAX_CHUNKS` | `memory.setAside.maxChunks` | `bot` |
| `YUKI_MEMORY_CONSOLIDATION_ENABLED` | `memory.consolidation.enabled` | `mixte` + `et` |
| `YUKI_CHAT_MODE` | `chat.mode` | `bot` |
| `YUKI_CHAT_REMOTE_AGENTS` | `chat.remoteAgents` | `bot` |
| `YUKI_CHAT_REMOTE_TOOLS` | `chat.remoteTools` | `bot` |
| `YUKI_CHAT_DISCORD_GUILD_ID` | `chat.discord.guildId` | `bot` |
| `YUKI_CHAT_DISCORD_MAX_UPLOAD_BYTES` | `chat.discord.maxUploadBytes` | `bot` |
| `YUKI_PUSH_ENABLED` | `push.enabled` | `mixte` + `et` |

Comment migrer : écrire la valeur dans `config.overlay.json` du bot (fichier
plat, mêmes clés que ci-dessus) ou la saisir sur `/config`. Les clés d'instance
(`YUKI_LLM_*`, `YUKI_HEAVY_*`, `YUKI_TTS_ENGINE`, `YUKI_FILES_*`… et les secrets)
gardent leur variable : **rien à migrer** pour elles, et le verrou
d'environnement (`locked_by_env`) reste entier pour ces clés-là.

Docs corrigées : `docs/lot7.md` (§9.1, colonne `Env` des six champs `tts.*`),
`docs/lot8.md` (C28 : `YUKI_TTS_SPEED`). `docs/lot11.md` **n'est pas concerné**
(vérifié : il ne cite aucune des 21 variables).

## 6. Preuves

- `tests/config/overlay-bot.test.ts` (20 tests) : overlay absent ⇒ comportement
  identique ; aiguillage ; flat + 0600 ; relecture au redémarrage ; précédence ;
  `et` ; `surcharge` ; réinitialisation ; audit.
- `tests/config/schema-scope.test.ts` (14 tests) : 89 clés, `scope` valide,
  66/18/5, `env` interdit hors instance, 21 variables réellement inactives,
  `mixteMerge` déclaré, `BOT_ID_DEFAUT === BOT_YUKI`, chemin de lecture unique.
- **Échec sur l'origine constaté** : l'arbre de travail d'origine a été copié
  dans `/tmp/preuve-1b` (avant toute modification) et les deux fichiers de test
  y ont été exécutés : `overlay-bot` **9 échecs / 11 succès**, `schema-scope`
  **6 échecs / 7 succès** (copie dite « neutralisée » : l'import de
  `src/config/overlay.js`, qui n'existe pas à l'origine, y est retiré).
  L'arbre git étant **propre** au départ (`HEAD = e34b0cb`), `HEAD` _est_
  l'origine ; la copie `/tmp` évite tout aller-retour sur l'arbre de travail.
- Campagne : `npm test` complet — **380 fichiers (377 ✅, 3 ignorés) /
  4192 tests (4187 ✅, 5 ignorés)** ; `tsc` sur **les deux** projets
  (`tsconfig.json` et `tsconfig.test.json`) ; 11 E2E : `e2e-sources` 41/41,
  `e2e-memory` 23/23, `e2e-chat-sessions` 36/36, `e2e-files` 71/71,
  `e2e-image` 124/124, `e2e-timestamp` 49/49, `e2e-mobile-ui` 40/40,
  `e2e-pins-agents` 59/59, `e2e-tts-ui` 108/108, `e2e-ack` 44/44,
  `e2e-secret` 28/28 — **CSP 0, connexion 0, exceptions 0** partout.
  36 PNG suivis réécrits par les harnais ont été restaurés **un par un**
  (`git show "HEAD:<chemin>" > <chemin>`).

## 7. Ce qui n'est PAS livré (assumé)

- Aucune route, aucune page, aucun écran de bot : le choix du bot actif d'UI est
  le lot **1b-4**.
- Le côté « bot » des clés `mixte` n'est écrit que par `portee: "bot"`
  (couture prête pour 1b-4) ; à ce stade, la page `/config` écrit la portée par
  défaut (`auto`).
- `config.overlay.json` n'est pas déplacé par la migration du lot 35a : le
  fichier n'existe pas encore chez personne.
