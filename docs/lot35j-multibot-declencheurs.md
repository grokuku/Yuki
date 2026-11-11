# Lot 35j — déclencheurs, envois et pré-autorisations par bot

Décision utilisateur (2026-11-10 22:04) : « oui ». Le lot 35a avait déplacé les
**fichiers** par bot ; ce lot fait que **le jeton détermine le bot**, qu'un seul
balayeur sert tous les bots, et que les pré-autorisations ne se consomment plus
en travers d'un bot.

## ① Le problème : la résolution par le NOM était une collision

`POST /api/sources/<nom>/messages` authentifiait le `Bearer` contre le secret
`YUKI_SOURCE_<NOM>` (`sourceTokenName`, `src/sources/types.ts`). Ce nom ne disait
pas **à quel bot** appartenait le déclencheur : deux bots déclarant chacun `news`
écrivaient la **même** entrée de coffre, et le webhook réveillait **le premier bot
portant ce nom**, avec SA mémoire et SES outils. Le porteur du jeton du bot A
pouvait donc faire travailler le bot B.

**Règle du lot** — le jeton décide, le nom ne décide plus :

    jeton → entrée du coffre → botId PROPRIÉTAIRE → sources.json DE CE BOT → nom

| Où | Ce qui change |
|---|---|
| `src/sources/par-bot.ts` (**nouveau**) | `nomSecretSource(bot, nom)` = `YUKI_SOURCE_<BOT>__<NOM>` ; `nomsSecretsSource` ajoute l'ancien nom `YUKI_SOURCE_<NOM>` **pour `yuki` seulement** ; `SourcesParBot` (`resoudreJeton`, `recevoir`, `pourBot`, `depsPourBot`, `ciblesBalayage`, `bots`, `fermer`) ; `portPreAutorisations` ; `filtreAgentVisible`. |
| `src/sources/service.ts` | option `secretNames(nom)` + `nomsSecrets(nom)` ; `createToken` écrit le **premier** nom ; `hasToken` essaie **tous** les noms ; `receive(nom, jeton, corps, secret?)` revérifie le jeton contre l'entrée **désignée** par l'appelant (défense en profondeur — le `secret` ne vient jamais d'un client). |
| `src/gateway/routes/sources.ts` | deps `reception` / `pourBot` / `bots` ; `depsDe(input)` résout `?bot=<id>` **avant** toute lecture ou écriture ; `botConcerne` nomme le bot dans les réponses ; le webhook passe par `deps.reception.recevoir(...)` ; un `SourcesParBotError` devient 404 (bot inconnu/invalide) ou 503 (pile non construite). |

Refus **explicites** (jamais un réveil silencieux du mauvais bot) :

| Cas | Réponse |
|---|---|
| jeton d'un bot, nom inconnu **chez ce bot** | **404** `unknown_source` **qui nomme le bot** |
| jeton d'une **autre** source du même bot | 404 nommant le bot et la source **demandée** (jamais celle du jeton) |
| bot propriétaire **inactif** | **403** `bot_inactif` qui nomme le bot + `{ bot }` |
| jeton inconnu | 401 (aucun bot nommé : on ne révèle pas l'annuaire) |
| `?bot=` inconnu en administration | 404 `unknown_bot` **qui le nomme** (aucun repli sur le bot actif) |

Le mode **mono-bot historique** (`state/bots.json` absent) ne change pas : un bot
synthétique `yuki`, actif, toutes capacités.

## ② Un SEUL balayeur pour N bots

| Où | Ce qui change |
|---|---|
| `src/sources/scheduler.ts` | `BalayeurBots` (+ `BalayeurBotsPort`, `CibleBalayage`, `BalayeurBotsOptions`). Il possède **l'unique `setInterval`** (30 s ; injectable) et demande à chaque tick `bots.cibles()`. Chaque bot a son `DeclencheurBalayeur` **interne** — dont `start()` n'est **jamais** appelé : aucun minuteur par bot. `DeclencheurBalayeur` est **inchangé** (rattrapage, chevauchement, plafond, garde-fou quotidien, tâches ponctuelles). |
| `src/sources/par-bot.ts` | `ciblesBalayage()` : un bot **inactif** ou **sans capacité pertinente** (`workerLourdAutorise`) n'y figure pas ⇒ ses sources ne tirent pas, il ne pourrait rien en faire. Un seul avertissement `sources.balayeur.bots_sans_capacite` par tick. |
| `src/index.ts` | `new DeclencheurBalayeur({ store, run, envoisProgrammes })` → `new BalayeurBots({ bots: { cibles: () => sourcesParBot.ciblesBalayage() }, passeHebdo, archivesBots, logger, now })`. Les **envois programmés** passent désormais par la cible du bot (`CibleBalayage.envoisProgrammes`) : chaque bot a SON `envois-programmes.json`. Les rendez-vous **d'instance** (consolidation hebdo, rétention des archives) restent **une fois par tick**, jamais une par bot. |

## ③ Pré-autorisations : la clé `(bot, déclencheur)` est STRUCTURELLE

Le fichier est déjà par bot (`preautorisations.json` sous `<state>/bots/<id>/`).
`PreAutorisationStore` reçoit `botId` (journal + messages) et `agentAutorise`
(portée agent filtrée par `AgentRecord.bots`) : un agent que **ce bot** ne voit
pas ne consomme pas, même si l'autorisation porte son `agentId`.

`portPreAutorisations(sourcesParBot, botDuRun)` ne consulte que la pile du bot
**du run** (`src/agents/execution.ts`) : le bot ne vient **jamais** d'un paramètre
client. Conséquence testable : consommer pour A ne touche jamais le fichier de B.

## ④ Un défaut PRÉ-EXISTANT découvert en chemin : le routeur perdait la requête

`normalizePath` (`src/gateway/app.ts`) rend le **chemin** — donc sans la chaîne de
requête — et c'est ce chemin qui était passé à `handleSourcesRequest`. En
production, **aucun** paramètre n'arrivait aux routes des sources : `?bot=<id>` ne
pouvait pas fonctionner, `?expression=` de l'aperçu cron répondait
`expression_absente`, et `?limite=` du journal retombait sur 50. Les tests
unitaires ne le voyaient pas : ils appellent le gestionnaire avec l'URL complète.

Correctif : `chaineDeRequete(req.url)` (nouvelle fonction) et
`path: ${path}${chaineDeRequete(req.url)}` pour les **seules** routes des sources
(le reste du routeur est inchangé). Constaté sur une instance réelle
(`YUKI_MOUNT_STATE=/tmp/…`, port 18096) : `?bot=yuki` rend `bot:{id,nom}` +
`bots:[…]`, `?bot=inconnu` rend **404 `unknown_bot`**, l'aperçu rend ses
`passages`, le journal respecte `limite`.

## ⑤ Câblage et interface

| Où | Ce qui change |
|---|---|
| `src/index.ts` | `botsAdmin` (registre **vivant**) + `sourcesParBot` déplacés **avant** le bloc SOURCES ; `envPourBot(envInstance, botId, mode)` pour résoudre l'`Env` d'un bot (⚠️ `pathsForBot` n'est **pas** idempotent sur `piSessionsDir`). **Fabrique de piles** unique : le bot **actif réutilise** `sourcesStore`/`sourcesInbox`/`declencheursJournal`/`preAutorisationsStore`/`sourcesService`/`envoisProgrammes` (jamais deux écrivains) ; les autres bots ouvrent les leurs sous leur racine. `setPileActive` / `setOuvrir` ; branchement **tardif** (host Pi + ports de délégation) appliqué aux piles ouvertes après `host.start()` ; `sourcesParBot.fermer()` à l'arrêt gracieux. Deps gateway : `bots: botsAdmin`, `reception`, `pourBot`, `bots`. |
| `public/ui/sources-panel.js` | option `botId` : toutes les routes d'administration portent `?bot=<id>` (`urlApi`), et un bandeau **nomme le bot concerné** (et signale un bot **inactif**). |
| `public/ui/config.js` | le panneau est monté pour **tout bot affiché** (pas seulement l'actif) : ses routes sont par bot, il n'a plus besoin d'être le bot actif pour être juste. |

## Tests

| Fichier | Ce qu'il prouve |
|---|---|
| `tests/sources/par-bot.test.ts` | nom de secret **unique par bot** (`__`, slug de bot impossible à confondre) ; ancien nom accepté **pour `yuki` seulement** ; ⚠️ **le jeton du bot A ne réveille jamais la source du bot B** (même nom, deux jetons, deux boîtes) ; fichiers touchés = ceux du propriétaire ; **403 nommant le bot** si inactif ; **404 nommant le bot** si nom inconnu chez lui ; 401 sans nommer personne ; `?bot=` inconnu ⇒ 404 ; pile non construite ⇒ 503 ; cibles = bots actifs **et** capables ; **aucune consommation croisée** de pré-autorisation ; portée agent filtrée par `AgentRecord.bots`. |
| `tests/sources/balayeur-bots.test.ts` | **un seul `setInterval`** quel que soit N (y compris le **vrai** `setInterval`) ; `start()` idempotent ; un tick balaie chaque bot une fois ; `stop()` rend l'intervalle ; un bot hors cibles n'est plus balayé ; un bot en erreur ne prive pas les autres ; consolidation hebdo et purge des archives **une fois par tick**. |
| `tests/gateway/sources-api.test.ts` (ajout lot 35j) | à travers le **ROUTEUR** (`createApp`, pas le gestionnaire seul) : `?bot=<inconnu>` ⇒ 404 `unknown_bot` qui le nomme ; `?bot=<connu>` ⇒ 200 avec `bot:{id,nom}` ; `?expression=` de l'aperçu rend ses `passages`. |

**Preuve d'échec sur l'origine** : `par-bot.ts` neutralisé (absent) et les cinq
fichiers porteurs du lot remis à leur état d'origine ⇒ `Cannot find module
'src/sources/par-bot.js'` (fichier entier en échec) et `BalayeurBots is not a
constructor` (10 tests en échec). Le défaut de routeur (`?bot=` perdu) est prouvé
par neutralisation **hunk par hunk** de `src/gateway/app.ts` (ce fichier était
déjà modifié avant ce lot, donc `HEAD` n'en est pas l'origine) : les 3 tests
`?bot=`/`?expression=` échouent alors (3 échecs / 35 succès). L'arbre étant **sale** au départ (lots 35g/35h/35i
non commités), la neutralisation a été faite depuis `git show HEAD:<fichier>`,
après vérification par `/tmp/preuve-lot35j/git-status-avant.txt` que ces cinq
fichiers étaient **intacts** avant ce lot (donc `HEAD` = origine pour eux).

## Ce qui reste hors de ce lot

- Une **cible LOCALE** d'envoi programmé d'un bot **non actif** n'est pas ouverte
  par le host Pi courant : l'envoi est marqué **ÉCHOUÉ avec sa raison** (aucune
  publication dans un autre fil). Les cibles de **canal** passent, elles, par le
  même chemin de publication que le bot actif.
- Le **host Pi** reste celui du bot actif : un déclencheur d'un autre bot ouvre
  ses tours sur ce host, avec SES `sources.json`, SA boîte et SES outils, mais la
  session Pi est celle du dossier de sessions de l'instance.
- Aucun **migration de coffre** : les anciens jetons `YUKI_SOURCE_<NOM>` restent
  la propriété de `yuki` ; un autre bot doit recevoir un **nouveau** jeton.
