# Lot 36 — multi-bot : quels bots TOURNENT (L1 + L2 + L3-a + L3-b)

Approche **B** (décision utilisateur) : **un seul processus**, N `PiHost`.
Ce document couvre L1 (résolution au démarrage), L2 (on/off réel), **L3-a**
(la configuration par bot) et **L3-b** (mémoire, archive, avatar, personnalité,
règles, épingles, réactions par bot) ; les morceaux suivants sont listés en fin,
avec ce qui reste à faire.

## Ce qui est livré

### L1 — Résolution au démarrage

`src/bots/actifs.ts` (nouveau, pur : aucune écriture, aucun démarrage) :

| Symbole | Rôle |
|---|---|
| `botsAActiver(registre)` (`:84`) | tous les bots `actif: true`, triés `ordre` puis `id` (ordre déterministe) |
| `resoudreDemarrageBots(registre, {maxActifs})` (`:109`) | rend `{principal, aDemarrer, refuses, plafond}` |
| `normaliserPlafond(valeur)` (`:50`) | entier borné `[1, MAX_BOTS]`, défaut 3, jamais `NaN` |
| `lirePlafondActifs(env, processEnv)` (`:72`) | précédence `défaut (3) < store < environnement` |
| `messageRefusPlafond(bot, plafond)` (`:124`) | message français nommant le bot refusé |

⚠️ **« Principal » ≠ « doit tourner ».** `principal` vient de `botActif`
(`src/bots/registry.ts:297`) qui privilégie **toujours** `yuki` ; `aDemarrer` ne
contient que les `actif: true`. Éteindre `yuki` ne change donc pas l'identité de
l'instance, seulement ce qui tourne.

`preparerMultiBot` (`src/bots/index.ts:235`) rend désormais `principal`,
`aDemarrer`, `refusesActifs`, `plafondActifs` :

- plafond dépassé ⇒ les bots en trop **ne démarrent pas** et sont nommés un par
  un dans `avertissements` (journalisés `bots.avertissement`) ;
- **aucun** bot actif ⇒ `DemarrageRefuseError("AUCUN_BOT_ACTIF")` ;
- principal éteint ⇒ la pile construite est celle du **premier bot actif**, et
  c'est dit (`avertissements`) ;
- **garde de non-régression** : un seul bot actif (`yuki`) ⇒ `bot`, `env` et
  chemins **identiques** à avant (test dédié).

Réglage : `bots.maxActifs` (`src/config/schema.ts:813`), portée `instance`,
`int` 1..6, défaut **3**, `apply: restart`, surchargeable par
`YUKI_BOTS_MAX_ACTIFS`. Lecture au démarrage via `lireValeurInstance`
(`src/config/runtime.ts`), pour ne pas créer un second lecteur du store commun
(`ConfigStore` reste la propriété de `src/config/`, verrouillé par
`tests/config/schema-scope.test.ts`).

Journal de démarrage : `bots.demarrage` (`src/index.ts:341`) →
`{mode, principal, pile, a_demarrer, refuses, plafond}`.

### L2 — On/off réel du bot

`definirActif` (`src/bots/admin.ts:635`) : **première** écriture du drapeau
`actif` (jusque-là posé seulement à la création et à la promotion après
suppression).

| Cas | Effet |
|---|---|
| déjà dans l'état demandé | `inchange: true`, **aucune écriture** |
| allumer sous le plafond | écrit `actif: true`, `demarrageRequis: true` |
| allumer au-delà du plafond | `409 plafond_actifs` — message nommant le plafond **et** les bots allumés |
| éteindre s'il reste ≥ 2 actifs | écrit `actif: false`, `arretRequis: true` |
| éteindre le **dernier** actif | `409 dernier_bot_actif` (sinon plus de démarrage possible) |
| `actif` non booléen | `400 actif_invalide` |
| bot inconnu | `404 bot_inconnu` |

Route : `PATCH /api/bots/<id>/actif`, corps `{ actif: boolean }`
(`src/gateway/routes/config.ts:1035`). Exige `X-Yuki-Config: 1` + même origine
(`guardWrite`), met à jour le registre **en mémoire** (sinon `GET /api/bots`
mentirait), journalise `bot.actif` et répond
`{bot, bots, actif, inchange, actifs, plafond, redemarrageRequis}`.

⚠️ **L'effet est au redémarrage** (`redemarrageRequis: true`) : le processus en
cours a résolu ses bots au démarrage. Le drapeau décrit ce qui **doit** tourner,
pas ce qui tourne déjà — c'est exactement ce que L8 rendra observable.

## L3 — composition par bot

### L3-a — LA CONFIGURATION PAR BOT (livré)

`src/config/bots.ts` (nouveau) :

| Symbole | Rôle |
|---|---|
| `creerConfigBot(botId, options)` (`:84`) | `ConfigRuntime` **lié à ce bot** : même store commun (`config.json` = l'INSTANCE, `configStorePath` non déplacé par `pathsForBot`), overlay PROPRE (`<state>/bots/<id>/config.overlay.json`), mêmes défauts de prompts livrés |
| `creerConfigsBots({env, bots, pile, …})` (`:118`) | `Map<botId, ConfigRuntime>` = bots **à démarrer** (L1 : `aDemarrer`) **+ le bot de la pile** (toujours, mode mono inclus). Un identifiant répété n'est construit qu'une fois |
| `BotIdInvalideError` (`:53`) | identifiant refusé par `estIdBot` (`src/bots/registry.ts:55`) : il devient un **nom de dossier**, jamais une valeur libre |

Dans `main()` (`src/index.ts:288`) : `configsBots` est construite une fois, et
`config` **est** l'entrée de cette Map pour le bot de la pile
(`configBotPrincipal`, `src/index.ts:313`) : jamais un second runtime pour le même
`botId` (deux caches d'overlay divergeraient). Les ~225 références existantes
(`routes/config.ts`, `getSubsystems`, `src/index.ts`) ne changent pas : elles
continuent d'utiliser **le principal**. Journal : `bots.config` (bots couverts) +
`config.bot.fallback` (replis des bots autres que la pile, un par un).

⚠️ La Map **n'est pas encore branchée sur les piles** (L3-b/L3-d). Deux règles
actées pour la suite :

1. **un seul rédacteur par overlay** — écrire l'overlay d'un bot passe par SON
   runtime (`update()`), jamais par `updatePour(botId)` depuis un autre runtime
   (le disque changerait, le cache mémoire du premier non) ;
2. **un seul pont `process.env`** — seul le runtime de la pile appelle
   `bridgeSecrets()` (`process.env` est global au processus).

⚠️ Limite connue : le **store commun** est chargé une fois par runtime. Une
écriture d'INSTANCE faite par un runtime n'est pas répercutée dans le cache des
autres ; seule la pile écrit l'instance aujourd'hui (`PUT /api/config`), donc
rien n'est observable — ce sera à traiter quand L3-d branchera les routes par bot.

### L3-b — MÉMOIRE, ARCHIVE, AVATAR, PERSONNALITÉ, RÈGLES, PINS, RÉACTIONS (livré)

`src/bots/outils.ts` (nouveau) — même principe que L3-a : une Map **à côté** des
singletons, **aucun appelant changé**, le principal **= les mêmes objets**.

| Symbole | Rôle |
|---|---|
| `creerOutilsBot({botId, envBot, configBot, …})` (`:201`) | les 7 objets d'UN bot : `memoire` (`StoresMemoireBot`), `archive` (`ConversationArchiveStore`), `avatar`, `personnalite`, `regles`, `pins`, `reactions` + ses 7 chemins |
| `creerOutilsBots({envInstance, mode, bots, pile, fabrique, existantsPile})` (`:358`) | `Map<botId, OutilsBot>` = bots **à démarrer** (L1) **+ le bot de la pile**, un identifiant répété construit **une** fois |
| `cheminsOutils(env)` (`:103`) | les **sept** chemins d'un `Env` (garde de non-régression : ce sont ceux que `main()` lisait) |
| `OutilsBotError` (`:74`) | `bot_invalide` · `env_double_resolution` · `env_incoherent` |
| `FabriqueMemoireBots.estOuvert/adopter` (`src/memory/stores-bot.ts:187`/`:202`) | la fabrique des stores (35i) **adopte** ceux que `main()` a ouverts pour la pile : une passe de consolidation ne peut plus rouvrir un second `MemoryStore` |

Dans `main()` : `fabriqueMemoireBots.adopter(storesMemoire)` (`src/index.ts:2727`,
les stores du bot de la pile étaient ouverts **avant** la fabrique) ; la Map est
construite **dans la porte GPU** (`src/index.ts:2841`), juste après l'archive des
conversations, avec `existantsPile` = les objets déjà construits ; `pins` vient
désormais de la Map (`src/index.ts:3557`), plus d'un `SessionPinStore.open` local.
Journaux : `bots.outils` (bots couverts) puis `bots.outils.bot` par bot **autre
que la pile** — des **chemins** seulement, jamais un contenu.

⚠️ **`envPourBot` n'est PAS idempotent** (`pathsForBot` surcharge `piSessionsDir`
en `<pi>/sessions/<botId>` ; le réappliquer empile `<bot>/<bot>`). La base est
TOUJOURS `bots.envInstance`, la résolution a lieu une seule fois par bot
(`creerOutilsBots`, ou reprise de l'`Env` des stores déjà ouverts) et
`creerOutilsBot` **refuse** un `Env` dérivé deux fois.

⚠️ La Map **n'est pas branchée sur les piles** (c'est L3-d) : elle est
journalisée et disponible. Elle est construite pour les bots à démarrer **et**
le bot de la pile, **jamais** pour ceux que le plafond a refusés.

⚠️ Effet de bord assumé : les stores de mémoire des bots à démarrer sont ouverts
(fichier + index), l'archive/avatar/personnalité/règles/épingles/réactions étant
seulement **construits** (aucun `ensureLayout`, aucun `read`). En mode mono-bot ou
à un seul bot actif, la Map ne contient que la pile et **réutilise ses objets** :
zéro écriture supplémentaire.

## Ce qui n'est PAS livré (et pourquoi)

**L3-c → L10 ne sont pas commencés.** L3-a (configuration) et L3-b (mémoire,
archive, avatar, personnalité, règles, épingles, réactions) sont livrés, mais
`creerPileBot(botId)` reste à extraire de `main()` (`src/index.ts:278-3890`).
~1 100 lignes de câblage imbriqué (`if (gate.passed)` ligne 2419 → 3518) où le
`PiHost`, la mémoire, les envois, la bibliothèque, les jobs et les canaux partagent
des fermetures et des `let` lus plus tard par les routes (`getSubsystems`,
`src/index.ts:3575`). Un lot commencé sans être fini laisserait l'UI et le
runtime à moitié recâblés — c'est précisément l'état interdit.

Découpage retenu (chaque morceau vert et démarrable) :

| Morceau | Contenu |
|---|---|
| **L3-a** ✅ | la **configuration** par bot (`src/config/bots.ts`, Map construite dans `main()`) |
| **L3-b** ✅ | la **mémoire**, l'archive, l'avatar, la personnalité, les règles, les pins et les réactions par bot (`src/bots/outils.ts`) |
| L3-c | les **sources / envois / pré-autos** par bot |
| L3-d | le **`PiHost` par bot** + `getSubsystems` (+ routes `/api/bots/<id>/config` servies par le runtime du bot) |

Ce qui **reste vrai** en l'état : une seule pile est construite (`pile` =
principal s'il tourne, sinon premier actif). Allumer un second bot écrit le
registre et le journal, sans construire sa pile.

## Tests

| Fichier | Contenu |
|---|---|
| `tests/bots/actifs.test.ts` (12) | plafond (normalisation, lecture env/store), liste triée, **principal ≠ doit tourner**, plafond nommant le refus, **non-régression 1 bot**, tous éteints ⇒ refus |
| `tests/bots/actif.test.ts` (13) | `definirActif` (écriture, `inchange`, plafond, dernier actif, types) + route (403 sans en-tête, registre mémoire, 409, 405/404/400, mode mono) |
| `tests/config/schema-scope.test.ts` | compteur 89 → **90** clés et 66 → **67** `instance`, avec la clé nommée (l'ajout est **délibéré**) |
| `tests/config/config-bots.test.ts` (8, **L3-a**) | deux bots ⇒ deux runtimes/overlays/valeurs · identifiant invalide refusé · **non-régression 1 bot actif : instantané COMPLET identique** (10 clés nommées + `snapshot()` des 90) · la Map couvre `aDemarrer` et **pas** les refusés du plafond · bot de pile toujours présent · écrire l'overlay d'un bot ne touche pas le principal |
| `tests/bots/outils.test.ts` (11, **L3-b**) | **non-régression : les 7 chemins du principal identiques** en mono (`<state>/…`) et en multi (`<state>/bots/<id>/…`) · les objets de `main()` **réutilisés** (`===`) et **adoptés** par la fabrique · deux bots ⇒ deux `MemoryStore`/`avatarDir`/`personalityPath` · **isolation de construction** (souvenir d'un bot absent du store, de l'index et du fichier de l'autre) · `envPourBot` **une seule fois** par bot (aucun `<bot>/<bot>`, `Env` doublement dérivé **refusé**) · identifiant invalide refusé · Map = `aDemarrer` + pile, **jamais** les refusés du plafond |

Preuve d'échec sur l'origine (arbre gelé `14f77dd`, `/tmp/preuve-lot36/origine`,
contenu `src/` vérifié : 325 entrées, `tests/` : 451) : **12/12** et **13/13**
tests en échec. Les autres suites (`tests/bots`, `tests/config`, `tests/gateway`,
`tests/ui`, `tests/sources`, `tests/agents`, `tests/integration`) restent vertes.

Preuve L3-a : arbre **propre** au départ (`3b25c58`), gelé **avant** toute écriture
dans `/tmp/preuve-lot36-l3a/origine-3b25c58.tar.gz` (contenu vérifié : **326**
entrées `src/`, **453** `tests/`, 0 fichier du lot). Sur l'origine, le fichier de
tests échoue à l'import (`src/config/bots.ts` absent) ; avec une fabrique
**naïve** (un runtime unique, ce que fait l'origine), **5/8** tests échouent
(`expected 'yuki' to be 'kohai'`, `expected true to be false`…) — les 3 restants
sont la garde de non-régression et deux invariants de la Map.

`tsc` vert sur **les deux** projets (`tsconfig.json` et `tsconfig.test.json`).
Suites de campagne : `tests/config` + `tests/bots` **257/257**, `tests/gateway` +
`tests/integration` **658/658** (5 ignorés). `git status` : `src/index.ts` modifié,
2 fichiers ajoutés — **aucun PNG touché**.

Preuve L3-b : arbre de départ **sale** (L3-a non commité) ⇒ pas de gel « propre » :
l'arbre a été gelé quand même **avant toute écriture** dans
`/tmp/preuve-lot36-l3b/arbre-avant.tar.gz` (vérifié : **`src/` présent**, 327
entrées ; `src/bots/outils.ts` et `tests/bots/outils.test.ts` **absents**), et la
preuve est faite par **neutralisation** sur `/tmp/preuve-lot36-l3b/origine` :
(a) sans le module, le fichier de tests échoue à l'import ; (b) avec une fabrique
**naïve** (le comportement d'origine : un seul jeu d'objets, aux chemins de
l'instance, sans réutilisation), **8/11** tests échouent — les 3 restants sont la
garde mono-bot et deux invariants structurels de la Map que l'ancien code
respectait déjà.

`tsc` vert sur **les deux** projets après L3-b. Suites de campagne L3-b :
`tests/memory` + `tests/pi` + `tests/bots` **795/795** (93 fichiers),
`tests/config` + `tests/gateway` + `tests/integration` **819/819** (5 ignorés).
`git status` : `src/index.ts`, `src/memory/stores-bot.ts` et
docs modifiés, `src/bots/outils.ts` + `tests/bots/outils.test.ts` ajoutés —
**aucun PNG touché**.

