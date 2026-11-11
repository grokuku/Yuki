# Lot 35i — la mémoire par bot, et les conversations d'un bot supprimé

Décision utilisateur (2026-11-10 21:04) : « oui ». Les chemins de la mémoire
étaient déjà résolus par bot depuis le lot 35a ; ce lot **vérifie et verrouille**
que tout lit le bon store, **ordonnance** la consolidation pour N bots, et
**bouche le trou** des sessions Pi d'un bot supprimé.

## ① Isolation — un seul chemin de construction

| Où | Ce qui change |
|---|---|
| `src/memory/stores-bot.ts` (**nouveau**) | `envPourBot(envInstance, botId, mode)` : `Env` d'instance (mode `mono`) ou `pathsForBot` (mode `multi`). `ouvrirStoresMemoireBot({ env, botId })` : **seul** endroit qui ouvre `memory.jsonl` + `memory-index.sqlite`, et il n'ouvre qu'un `Env` **résolu pour un bot**. `FabriqueMemoireBots` : un jeu par bot, mis en cache (un seul rédacteur par fichier). |
| `src/bots/index.ts` | `ResultatPreparationBots.envInstance` : l'`Env` **non surchargé**. ⚠️ `pathsForBot` surcharge `piSessionsDir`, donc le réappliquer à un `Env` déjà résolu empilerait `<botId>/<botId>`. |
| `src/index.ts` | `ouvrirStoresMemoireBot(...)` remplace `MemoryStore.open(env.memoryStorePath)` / `new MemoryIndex(...)` ; tous les chemins mémoire passent par `storesMemoire.env` (store, index, consolidation, archive, héritage, conversations). |

Recherche faite (`fichier:ligne`) — **aucun accès hors résolution par bot** :

- `env.memoryStorePath` / `env.memoryIndexPath` : `src/memory/stores-bot.ts:103-104` seulement (avant : `src/index.ts:2332-2333`, où `env` était déjà l'`Env` du bot actif — pas un bug, mais contournable).
- `memory.jsonl` littéral : `src/bots/admin.ts:1004` (`compterLignes(join(racine, "memory.jsonl"))`, `racine = <state>/bots/<botId>`), `src/bots/admin.ts:192` (chemins RELATIFS de clone), `src/memory/consolidation-archive.ts:38` (nom de fichier **dans** l'archive du bot). Tout est relatif à la racine du bot.
- `heritageDir`, `conversationArchive*`, `memoryConsolidation*` : `src/index.ts` uniquement, via `storesMemoire.env`.

## ② Consolidation × N — ordonnancée

| Où | Ce qui change |
|---|---|
| `src/memory/consolidation-multi.ts` (**nouveau**) | `ConsolidationBots` : **une passe à la fois** (`await` entre chaque bot), **curseur persisté** `dernierBotConsolide` dans `state/memory-consolidation-bots.json`, **séquence persistée** (`ordre` + `faits`) reprise au tick suivant, verrou `enCours` persisté (orphelin après 6 h). |
| `src/index.ts` | `passeHebdo` du balayeur appelle l'**ordonnanceur**, plus la seule passe du bot actif. Un `ConsolidationHebdo` par bot (stores, archive et fichier d'état du bot ; extracteur/journal/contexte partagés). Le bot actif réutilise l'instance déjà construite (jamais deux écrivains). |

Règles :

- un bot aux **capacités vides** n'est pas mis dans la séquence (il ne mémorise rien) ;
- la consolidation peut être éteinte **pour un bot** (`memory.consolidation.enabled`,
  clé MIXTE lue par `config.snapshotPour(botId)`) ⇒ ce bot est sauté et journalisé ;
- **les réglages restent d'INSTANCE** : `cron`, `timeZone`, `budgetTokens`,
  `retention` — un seul calendrier, donc un seul rendez-vous ;
- un **échec** arrête la séquence et le bot est noté : la reprise au tick suivant
  traite les **suivants** (jamais deux fois de suite le même bot) ;
- rattrapage ≤ 24 h, au-delà sauté et journalisé (comportement du lot 29 conservé).

## ③ Sessions Pi d'un bot supprimé

`<pi>/agent/sessions/<id>` vit sur un **autre volume** que `state` : `rename`
échouerait (`EXDEV`).

| Où | Ce qui change |
|---|---|
| `src/bots/admin.ts` | `supprimerBot({ piSessionsDir })` **copie** les sessions dans `<archive>/sessions-pi/` puis les supprime ; `ResultatSessionsPi` = `deplace` / `absent` / `echec` / `inconnu`. Une copie qui échoue ne supprime **rien**, journalise `bot.sessions.echec`, écrit `sessions-pi-restantes.json` dans l'archive et remonte l'erreur. `purgerArchivesBots({ piSessionsDir })` efface `sessions-pi/` avec l'archive **et** les sessions restées en place (marqueur), à la même échéance. `compterSessionsPi` alimente la confirmation. |
| `src/gateway/routes/config.ts` | `DELETE /api/bots/<id>` renvoie `sessionsPi` et journalise `bot.supprime.sessions_conservees` en cas d'échec ; `GET /api/bots/<id>/donnees` ajoute `sessions` (`null` si le volume `pi` est inconnu — jamais un zéro trompeur). |
| `public/ui/config-pages.js` + `config.js` | la phrase de suppression nomme les sessions Pi et leur sort ; une alerte « Conversations conservées à part » s'affiche sur `sessionsPi.etat === "echec"`. |

## ④ Interface

Onglet **Mémoire** de `/bots` : les **8 clés `bot`** du schéma —
`memory.enabled`, `recall.{topK,budgetChars,timeoutMs}`, `extract.{maxItems,timeoutMs}`,
**`setAside.{maxChars,maxChunks}`** (ces deux dernières n'étaient réglables
nulle part) — plus l'interrupteur MIXTE `memory.consolidation.enabled`. Aucune
clé d'instance de la planification n'y fuit. Rendu vérifié sur le stub local :
9 lignes, 0 exception.

## Tests

| Fichier | Ce qu'il prouve |
|---|---|
| `tests/memory/stores-bot.test.ts` | mémoire de `yuki` **invisible** pour un autre bot (store, index, disque) ; chemins sous `<state>/bots/<id>` ; identifiant invalide refusé ; mode mono = chemins historiques ; garde de source (`MemoryStore.open` interdit ailleurs). |
| `tests/memory/consolidation-multi.test.ts` | passes sérialisées ; un tick pendant la séquence n'en démarre pas une autre ; curseur persisté et cycle suivant après le dernier bot ; reprise après échec et après redémarrage (verrou orphelin) ; capacités vides sautées ; calendrier d'instance. |
| `tests/bots/sessions-pi.test.ts` | sessions copiées puis retirées ; échec ⇒ origine intacte + journal + marqueur ; purge 90 j des deux ; marqueur incohérent inoffensif ; compteur. |
| `tests/gateway/config-bots-api.test.ts` | les 8 clés `bot` de la mémoire s'écrivent dans l'overlay du bot ; l'interrupteur de consolidation s'écrit des deux côtés. |
| `tests/ui/config-pages.test.ts` | les 8 clés + l'interrupteur dans l'onglet Mémoire ; phrase de suppression nommant les sessions. |

## Ce qui reste hors de ce lot

- Un `MemoryService` (rappel/extraction) reste construit pour le **bot actif**
  seulement : les autres bots sont consolidés, pas « interrogés ».
- Le dossier de sessions d'un bot est purgé avec son archive ; une session
  laissée par un déploiement qui a surchargé `YUKI_PI_SESSIONS_DIR` hors volume
  n'est pas suivie (aucun déplacement sauvage).
