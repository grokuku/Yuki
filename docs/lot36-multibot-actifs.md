# Lot 36 — multi-bot : quels bots TOURNENT (L1 → L10)

Approche **B** (décision utilisateur) : **un seul processus**, N `PiHost`.
Ce document couvre L1 (résolution au démarrage), L2 (on/off réel), **L3-a**
(la configuration par bot), **L3-b** (mémoire, archive, avatar, personnalité,
règles, épingles, réactions par bot), **L3-c** (sources, envois et
pré-autorisations par bot), **L3-d** (`PiHost` par bot), **L4** (transport WS
multi-host : un second bot est JOIGNABLE), **L5** (canaux et publication par
bot), **L6** (agents multi-bot), **L7** (worker lourd par bot), **L8** (état
réel + démarrage/arrêt par bot), **L9** (arrêt ciblé) et **L10** (jetons et
adaptateurs de plateforme par bot) ; les limites connues sont listées en fin.

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

⚠️ La Map **n'était pas encore branchée sur les piles** à L3-a (elle l'est depuis
L3-d, qui l'a branchée sur les hosts). Deux règles actées pour la suite :

1. **un seul rédacteur par overlay** — écrire l'overlay d'un bot passe par SON
   runtime (`update()`), jamais par `updatePour(botId)` depuis un autre runtime
   (le disque changerait, le cache mémoire du premier non) ;
2. **un seul pont `process.env`** — seul le runtime de la pile appelle
   `bridgeSecrets()` (`process.env` est global au processus).

⚠️ Limite connue : le **store commun** est chargé une fois par runtime. Une
écriture d'INSTANCE faite par un runtime n'est pas répercutée dans le cache des
autres ; seule la pile écrit l'instance aujourd'hui (`PUT /api/config`), donc
rien n'est observable — reste à traiter quand les routes par bot (`/api/bots/<id>/config`)
seront servies par le runtime du bot (L4 et suite).

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

⚠️ La Map **n'était pas branchée** à L3-b (c'est L3-d qui l'a fait) : elle est
construite pour les bots à démarrer **et** le bot de la pile, **jamais** pour
ceux que le plafond a refusés.

⚠️ Effet de bord assumé : les stores de mémoire des bots à démarrer sont ouverts
(fichier + index), l'archive/avatar/personnalité/règles/épingles/réactions étant
seulement **construits** (aucun `ensureLayout`, aucun `read`). En mode mono-bot ou
à un seul bot actif, la Map ne contient que la pile et **réutilise ses objets** :
zéro écriture supplémentaire.

### L3-c — SOURCES / ENVOIS / PRÉ-AUTORISATIONS PAR BOT (livré)

`src/sources/pile-bot.ts` (nouveau) — la fabrique qui manquait : jusqu'ici
l'ouverture d'une pile vivait dans une fermeture de `main()` et ne connaissait ni
la configuration du bot (L3-a) ni ses outils (L3-b).

| Symbole | Rôle |
|---|---|
| `creerResolveurEnvBot({envInstance, mode, pile, envPile})` (`:84`) | résout l'`Env` d'un bot **UNE seule fois** et rend le **même objet** ensuite ; la pile est semée avec l'`Env` du démarrage (`preparerMultiBot`), donc jamais recalculée |
| `FabriquePilesSources` (`:167`) : `ouvrir(botId)` / `get` / `ouvertes()` | une pile par bot, **idempotent** ; la pile du bot de la PILE rend les objets de `main()` **par identité** (`existantsPile`) |
| `ObjetsPileSources` (`:115`) | `store` (`sources.json`), `inbox`, `journal`, `preAutorisations`, `service`, `envois` — tous résolus sous `<state>/bots/<id>/` |
| `ContextePileBot` (`:126`) | ce qu'un constructeur reçoit pour UN bot : `botId`, `envBot`, `config` (L3-a), `outils` (L3-b) |

Dans `main()` (`src/index.ts:1911`) : `envsBots` (le résolveur mémoïsé) est
**partagé** par la fabrique de piles et par `creerOutilsBots({resoudreEnvBot})`
(`src/index.ts:2874`) — un seul `Env` par bot, jamais deux. `fabriquePiles` reçoit
`configPour: configsBots.get` et `outilsPour: outilsBotsParId.get` (relais
`let`, car la Map des outils naît **après** la pile active) ; `construire` ouvre
les objets d'un autre bot et applique **ses** bornes (`configBot.getNumber(
"sources.promptTotalChars"`, `files.maxFileBytes`) — un bot sans runtime de
configuration (créé APRÈS le démarrage) est signalé (`sources.pile.config_absente`)
et retombe sur celles de la pile. Journal d'ouverture : `sources.pile.ouverte`
(des chemins, jamais un contenu).

`PileSourcesBot` gagne deux champs **optionnels** (aucune rupture pour les
constructeurs de tests) : `config` (L3-a) et `outils` — ce dernier est un
**getter** parce que la Map L3-b est construite après la pile ; c'est le point
d'accroche de L3-d. `SourcesParBot.piles()` expose les piles déjà ouvertes.

⚠️ **Ce que le balayeur voit** : `SourcesParBot` reçoit la décision de démarrage
(L1, `demarrage: () => ({aDemarrer, refuses})`, `src/index.ts:1160`).
`ciblesBalayage()` rend **UNE cible par bot à démarrer** (encore `actif: true`
dans le registre), plus une par bot du **registre** : un bot `actif: true` mais
**refusé par le plafond** n'a **ni pile ni déclencheur** — `pourBot` lève
`SourcesParBotError("bot_refuse")`, et ses fichiers ne sont pas ouverts. Sans
`demarrage` (mode mono, tests), la règle du lot 35j s'applique inchangée.

⚠️ Le bot de la pile garde **exactement** le comportement d'avant : mêmes objets
(`===`), même `Env`, mêmes chemins, même `envois` ; `construire` n'est jamais
appelé pour lui (test à `throw`).

### L3-d — LE `PiHost` PAR BOT (livré, **dernier morceau de L3**)

`src/bots/hosts.ts` (nouveau) — la Map des hosts, et les trois règles qui la
rendent sûre.

| Symbole | Rôle |
|---|---|
| `HostsBots<THost>` (`:269`) | construit **un host par bot à DÉMARRER** (L1) plus le **principal** ; `principal` est construit avec `optionsPile` **tel quel** (objet d'options passé par identité) ; `pourDemarre(botId)` ne rend que les hosts qui ont **démarré** |
| `portsHostBot(contexte)` (`:120`) | les ports **d'un** bot : `sessionsDir` = `env.piSessionsDir` du bot, `systemPrompt` = `appendVoiceInstruction(prompts.light de SON overlay, tts.enabled de SON overlay)`, plus `sources`/`envoisProgrammes`/`planifierTache` de **sa pile** (L3-c) et `personality`/`rules`/`reactions`/`conversationArchive`/`heritage` de **ses outils** (L3-b) |
| `optionsHostBot(botId, optionsPile, ports)` (`:187`) | copie **surface** des options du principal + remplacement des ports du bot ; un port **absent** est **retiré** (`delete`), jamais hérité |

Dans `main()` : les options du host du principal sont désormais un **objet
nommé** (`const optionsHostPile: PiHostOptions`, `src/index.ts:3132`) — **contenu
inchangé** — passé à `HostsBots({pile, bots: aDemarrer, optionsPile, creer:
createPiHost, contexte})` (`:3266`), puis `host = hostsBots.principal` (`:3297`).
Les hosts secondaires démarrent **après** le principal (`await
hostsBots.demarrerAutres()`, `:3373`) et s'arrêtent avec lui (`await
hostsBots?.arreter()`, arrêt gracieux) : un échec de `start()` est journalisé
(`bots.host.start.failed`) et n'empêche ni le principal de servir ni les autres
bots de démarrer.

⚠️ **Ce qui ne change PAS** : routes d'instance, `getSubsystems` (`:3740`) et
transport WS gardent `host` **le principal** — aucun appelant ne change, et un
seul bot actif donne **le host d'aujourd'hui** (mêmes `sessionsDir`,
`systemPrompt` et ports, par identité). **Aucun message n'est routé** vers un host
secondaire : c'est L4.

⚠️ **La mémoire n'est pas encore un port par bot** : `PiHostOptions.memory` est
un **service** (`MemoryPort`), pas un store — L3-b fournit les **stores** d'un
bot. Le host d'un bot secondaire n'a donc **pas** de port `memory` (il lirait
sinon la mémoire du principal) : c'est **retiré** et **dit** au journal
(`bots.host.port_absent`). Même règle pour tout port propre au principal.

⚠️ **Gardes de construction** : deux hosts sur le même `sessionsDir` sont
**refusés** (`bots.host.sessions_dir_partage` — deux `SessionManager` sur un
fichier corrompraient les JSONL) ; un bot **sans configuration** n'a pas de host
(`bots.host.config_absente` — emprunter le prompt du principal ferait parler un
bot avec le texte d'un autre) ; un bot **refusé par le plafond** n'est pas dans
`aDemarrer`, donc son contexte n'est **même pas demandé**.

⚠️ **Réveils** : chaque service de sources reçoit le host **de son bot** quand il a
démarré (`hostsBots.pourDemarre(botId)`), sinon celui de l'instance (repli
d'avant L3-d) — `src/index.ts:3444`. Journal : `bots.hosts` (nombre + ids,
**jamais un contenu**), `bots.host.construit`, `bots.hosts.demarres`
(démarrés/échecs), `bots.hosts.arretes`, et `sources.bots.prets` porte en plus
`hosts` / `hosts_demarres` / `hosts_echecs`.

### L4 — transport WS multi-host (un second bot JOIGNABLE)

| Symbole | Rôle |
|---|---|
| `ClientMessage` (`src/gateway/ws/protocol.ts:43,44`) | `hello` et `resume` portent un `botId?` **optionnel** (`BotTargeted`, `:37`) — **absent = principal** |
| `parseBotId` (`:730`) | `undefined` = absent (principal) ; valeur nettoyée ; **vide ⇒ `invalid_bot_id`** (jamais le principal par défaut) |
| `welcome.bot` (`:280`) | le bot qui répond — **émis UNIQUEMENT** si le client en a demandé un (trame identique à avant L4 sinon) |
| `BotHostsPort` (`src/gateway/ws/server.ts:236`) | `principal` + `pourDemarre(botId)` (+ `ids?()`) : le **seul** chemin vers un host secondaire |
| `hostFor` (`:609`) / `hostPourBot` (`:619`) | host du client (principal si aucun `botId`) / host d'un bot **démarré**, sinon `undefined` |
| `storeForHost` (`:630`) / `storeFor` (`:646`) | **un `SessionStreamStore` PAR BOT** — celui du principal est **le même objet qu'avant L4** (`===`) |
| `subscribeHost` (`:696`) / `onHostEvent` (`:711`) | un abonnement **par bus** ; un événement entre dans le registre du bus **émetteur** |
| `rattacherBot` (`:1439`) | résout `botId` **avant tout traitement** (`hello`/`resume`) ; inconnu/arrêté ⇒ trame `error` `bot_inconnu` **nommant le bot**, aucun service rendu |
| `resoudreBotDeRequete` (`:2573`) / `onUpgrade` (`:2636`) | `?bot=<id>` sur `/ws` : la connexion est rattachée **avant** la première trame ; bot inconnu ⇒ **404**, pas de connexion |
| `?bot=` côté UI | `public/ui/bot-conversation.js` (`botDeLaPage:26`, `champBot:38`, `texteBot:52`) · `public/ui/app.js:179,2786,2796` (`?b=<slug>` → `botId` de `hello`/`resume`) · badge `#bot-name` (`public/ui/index.html`) · lien `/bots` → `/?b=<slug>` (`config.js:249,1729`) |

⚠️ **La convention `?bot=` existait déjà** sur les routes des sources et des
déclencheurs (lot 35j, `GET/PUT /api/sources/…?bot=<id>`) : c'est la même règle
qui est reprise ici, avec **défaut = principal**.

⚠️ **`?bot=` sur les routes HTTP de sessions : il n'y en a PAS.** Les sessions
n'ont aucune route HTTP (`/api/sessions` n'existe pas : la liste vient de la
trame WS `sessions`, cf. `src/gateway/app.ts` — le seul chemin HTTP lié à une
session est `?session=` de `/api/files`). Le « `?bot=` » demandé est donc porté
par (a) le **champ de trame** `botId` et (b) **l'URL du WebSocket**
(`/ws?bot=<id>`) — les deux sont testés, défaut = principal dans les deux cas.

⚠️ **Garde de non-régression** : sans `botId` **ni** `?bot=`, le comportement est
**exactement** celui d'avant L4 — `client.host` reste `undefined`, donc
`hostFor(client) === host` (le principal), `storeFor(client) === streams` (le
même `SessionStreamStore`, `===`), et `welcome` ne porte **aucun** champ `bot`.

⚠️ **Isolation** : deux bots qui porteraient le **même** identifiant de session ne
partagent ni compteur `seq`, ni tampon de rejeu, ni snapshot, ni liste. Un flux
de `kohai` n'est **jamais** lisible par `yuki` (test central).

⚠️ **TTS / instrumentations** : `routeTtsEvent(source, event)` compare la session
émise à la session focalisée **du bot émetteur** ; `recordRunStage` /
`recordRunTtsMetrics` s'adressent au host qui **possède** la session
(`hostForSession`, `:657`). Canaux (L5) et agents (L6) **non touchés**.

### L5 — CANAUX ET PUBLICATION PAR BOT (livré)

`src/chat/canaux-bot.ts` (nouveau) — la correction de la **fuite** : jusqu'à L4,
`canaux()` du port de publication lisait le miroir de l'**INSTANCE** pour tous
les bots.

| Symbole | Rôle |
|---|---|
| `ProprietairesCanaux` (`:96`) | propriété PERSISTÉE `conversationId → botId` (`state/chat-canaux-proprietaires.json`, écriture atomique **0600**). `revendiquer` (`:170`) rend `{ok, nouveau}`, ou un REFUS qui NOMME le propriétaire |
| `messageCanalAutreBot` (`:65`) | le message de refus : canal, canal nommé, bot propriétaire, et la règle (« un canal n'a qu'un seul bot, sinon deux réponses ») |
| `CanauxBots` (`:253`) | `canaux(botId)` = **son** miroir (`chatMirrorPath`/`chatMirrorDir` sont des chemins PAR BOT), moins les canaux d'un AUTRE bot ; `revendiquerEtAutoriser(botId, canal)` = appartenance AVANT publication (le premier envoi revendique) ; `oublier(botId)` (arrêt ciblé) |

`ChannelPostPortOptions.autoriser` (`src/chat/reply/channel-post.ts:105`) : appelé
**juste après la résolution du canal**, avant le fil, les bornes et tout appel
réseau — un refus ne publie **rien**.

Dans `main()` : `canauxBots` (`src/index.ts:1740`) est rempli après le résolveur
d'`Env` des bots (`:2003`) ; le bot de la PILE réutilise `chatMirror` par
**identité**, un autre ouvre SON miroir à la première demande (mémorisé).
`portDePublication(…, botId)` lit `canauxBots.canaux(botId)` et pose
`autoriser: revendiquerEtAutoriser` ; `publierEnvoiProgramme(input, botId)`
publie avec `hostDuBot(botId)` (aucun repli vers le principal) ; les `canaux()`
des envois programmés (instance et par bot) viennent aussi de `canauxBots`.
Le bot d'un run de canal est le **propriétaire** du canal où le run est né
(`proprietairesCanaux.proprietaire(conversationId) ?? botDePile`).

### L6 — AGENTS MULTI-BOT (livré)

`src/agents/executions-bots.ts` (nouveau) — **un `AgentExecutionService` par
bot**, avec `botCourant: () => botId` (la visibilité `AgentRecord.bots` suit le
bot du run, plus une constante figée au démarrage).

| Ce qui est PARTAGÉ (et doit l'être) | Ce qui est PAR BOT |
|---|---|
| `AgentStore` (un `agents.jsonl`), `AgentHub` (une connexion mTLS par agent), `AuditLog`, `ApprovalRegistry`, serveur TLS **9443** | le service d'exécution (`ExecutionsAgentsBots`, `:57`), donc la **visibilité** |

`pourChacun` (`:97`) diffuse les branchements tardifs (`setWaker`,
`setPreAutorisations`) à **tous** les bots : sans cela, un bot secondaire
n'aurait jamais de réveil de fin de commande. Dans `main()` :
`executionsAgents` (`src/index.ts:790`), `agentExecution` = `principal` (même
objet qu'avant), `executionDuBot(botId)` sert le worker lourd (L7) et le port
`execution` d'un host (`src/bots/hosts.ts` : port **retiré** si absent, jamais
emprunté au principal). Le contrôle `AgentRecord.bots` reste **PAR COMMANDE**
(`src/agents/execution.ts:1368`, inchangé).

### L7 — WORKER LOURD + RAM (livré)

`src/bots/workers.ts` (nouveau) — `WorkersLourdsBots` (`:85`) :

- **PARESSEUX** : le constructeur ne construit RIEN (seul le worker du principal,
  déjà construit par `main()`, est semé par identité) ; `pour(botId)` construit à
  la première demande ;
- **STRUCTUREL** : un bot sans `execution`/`delegation` n'a pas de worker — la
  fabrique n'est **même pas appelée** (`workerLourdAutorise`) ;
- **PLAFONNÉ** : `normaliserPlafondWorkers` (défaut 3) ; au-delà, refus journalisé
  (`bots.worker.plafond`) nommant le plafond et les workers existants ;
- **MESURÉ** : `rss_mb` au journal à chaque construction (`bots.worker.construit`)
  et à la demande (`bots.workers.rss`), au démarrage **et** à l'arrêt.

Dans `main()` : la fabrique `creerWorkerLourd(botId)` (`src/index.ts:2680`) est
celle du principal pour `botId = botDePile` (mêmes options par identité de
valeurs) ; prompt LOURD, capacité et borne d'images lus dans la configuration
**du bot**.

### L8 — `/bots` = ÉTAT RÉEL (livré)

`src/bots/execution.ts` (nouveau) — `ExecutionBots` (`:104`) :

| Rôle | Détail |
|---|---|
| `etat(botId)` (`:113`) | `{demarre, erreur?, sessions, workers}` **depuis l'exécution** (`hosts.estDemarre`, compteur de sessions, registre des workers) — le champ `actif` **mentait** |
| `demarrer(botId)` (`:129`) | ouvre la pile (idempotent) **PUIS** démarre le host, **créé au besoin** (`HostsBots.demarrerBot`, `src/bots/hosts.ts:450`) |
| `arreter(botId)` (`:175`) | arrête et **détruit** host + pile (`HostsBots.arreterBot`, `:495`), étapes de L9 |

Routes (`src/gateway/routes/config.ts`) : `GET /api/bots` joint `execution` à
chaque bot ; `PATCH /api/bots/<id>/actif` **applique immédiatement**
(`applique: {ok, inchange, raison?}`, `redemarrageRequis: false` si appliqué) et
retombe sur le comportement de L2 (`redemarrageRequis: true`) si l'instance n'a
pas de port d'exécution. `SourcesParBot.autoriser/oublier` lèvent le refus
`bot_refuse` d'un bot démarré à la main et oublient sa pile à l'arrêt.

UI (`public/ui/config.js`) : section « Exécution » (Démarrage, Sessions, Worker
lourd, dernière erreur) + boutons **Démarrer / Arrêter** (désactivés quand ils
seraient sans effet), la réponse du serveur faisant foi.

### L9 — ARRÊT CIBLÉ (livré)

`src/bots/arret.ts` (nouveau) — `arreterBotProprement` (`:93`), ordre de
fermeture sûre : `run → sources → host → mémoire → pile → tts → plateforme`.
**Idempotent** (`dejaArrete` ⇒ aucune étape), **isolé** (seules les étapes de CE
bot), **un échec n'arrête pas les autres** (bilan nommé). Câblage :
`ExecutionBots.arreter` → `hosts.arreterBot` (host), `fabriquePiles.fermerBot`
(pile + `sourcesParBot.oublier` + miroir + worker), `fabriqueMemoireBots.fermerBot`
(index mémoire), `adaptateursChat.deconnecterBot` (plateforme). Le bot
**principal** est refusé (il s'arrête avec le gateway).

### L10 — JETONS ET ADAPTATEURS PAR BOT (livré)

`src/chat/jetons-bot.ts` (nouveau) — `YUKI_CHAT_<BOT>__<PLATEFORME>` (même
convention que `YUKI_SOURCE_<BOT>__<NOM>`) ; `nomsSecretsChat` (`:66`) accepte en
plus l'ancien nom (`YUKI_CHAT_MATTERMOST`) pour `yuki` **seulement** —
aucune réinstallation n'est nécessaire. `resoudreJetonsChatBots` (`:128`) détecte
le **conflit sur la VALEUR** (deux bots, un jeton) et **écarte les deux** avec un
message qui les nomme (`messageJetonPartage`, `:100`). `botDuJetonChat` (`:197`)
résout le bot **par le jeton reçu**, sans jamais garder la valeur en mémoire.

`src/chat/adaptateurs-bots.ts` (nouveau) — `AdaptateursChatBots` (`:72`) : un
adaptateur par `(bot, plateforme)`, chacun avec **SON** jeton et **SON** miroir
(et son cache de pièces jointes, donc son client REST) ; `connecterTout` /
`connecterBot` / `deconnecterBot` / `deconnecterTout` par bot ; le bot de la pile
garde l'adaptateur d'avant (**identité**).

Dans `main()` : résolution des jetons (`:2660`), fabrique d'adaptateur par bot
(`creerAdaptateurChat`), connexion du principal (condition élargie au nom par
bot) puis des autres (`connecterTout({sansPile: true})`), déconnexion ciblée à
l'arrêt d'un bot et globale au shutdown. `envoyerDansCanal(..., botId)` publie
avec l'adaptateur du bot. `chat.mode` reste une clé `bot` : chaque bot choisit sa
plateforme ; **un bot sans jeton reste en local** (aucun adaptateur construit).
`/config → Conversation` reçoit `jetonsBots` (nom du secret + posé/absent,
jamais une valeur) et l'affiche.

## Ce qui reste à faire (limites connues, dites)

| Limite | Pourquoi |
|---|---|
| Le **service de délégation** (jobs) reste celui du principal : `WorkersLourdsBots` construit le worker d'un bot **à la demande**, mais aucune file de jobs n'est encore instanciée par bot | un `JobStore` + `JobQueue` + `DelegationService` par bot est un lot à part entière ; le worker d'un bot secondaire n'est donc créé que si un appelant le demande explicitement (`pour(botId)`) |
| Un bot secondaire n'a **pas de port `memory`** (service) : L3-b fournit ses **stores**, L9 ferme son **index** | construire un `MemoryService` par bot (extraction, consolidation, drain) reste à faire ; le port est **retiré**, jamais emprunté au principal |
| **TTS** et la file de téléchargement sont des objets d'INSTANCE : l'arrêt d'un bot ne les ferme pas | la synthèse vocale n'est pas encore instanciée par bot |
| Le host d'un bot secondaire hérite des **outils et de la délégation** du principal (L3-d) | la politique d'outils par bot (capacités) est appliquée au **worker** et aux runs de canal, pas encore au host local |
| `/api/bots/<id>/actif` n'expose pas de route « Démarrer » distincte | c'est le MÊME état que `actif` (une seule vérité, deux commandes) |

Ce qui **reste vrai** : les **routes d'instance** et `getSubsystems` gardent le
host du **principal** (`pile` = principal s'il tourne, sinon premier actif) — une
trame **sans** `botId` et une page **sans** `?b=` se comportent donc exactement
comme avant L4. Ce qui **change** : une trame (ou une connexion `/ws?bot=`) qui
nomme un bot est servie par **SON** host, avec **son** registre de flux.
⚠️ Depuis **L8**, allumer ou éteindre un bot s'**applique immédiatement**
(`redemarrageRequis: false`) : le drapeau `actif` n'est plus une simple intention.

Découpage livré (chaque morceau est vert et démarrable) :

| Morceau | Contenu |
|---|---|
| **L3-a** ✅ | la **configuration** par bot (`src/config/bots.ts`) |
| **L3-b** ✅ | **mémoire, archive, avatar, personnalité, règles, épingles, réactions** par bot (`src/bots/outils.ts`) |
| **L3-c** ✅ | **sources / envois / pré-autos** par bot (`src/sources/pile-bot.ts`) |
| **L3-d** ✅ | le **`PiHost` par bot** (`src/bots/hosts.ts`) |
| **L4** ✅ | le **transport WS multi-host** |
| **L5** ✅ | **canaux et publication par bot** (`src/chat/canaux-bot.ts`) |
| **L6** ✅ | **agents multi-bot** (`src/agents/executions-bots.ts`) |
| **L7** ✅ | **worker lourd par bot** (`src/bots/workers.ts`) |
| **L8** ✅ | **état réel + démarrer/arrêter** (`src/bots/execution.ts`) |
| **L9** ✅ | **arrêt ciblé** (`src/bots/arret.ts`) |
| **L10** ✅ | **jetons et adaptateurs de plateforme par bot** (`src/chat/jetons-bot.ts`, `src/chat/adaptateurs-bots.ts`) |

## Tests

| Fichier | Contenu |
|---|---|
| `tests/bots/actifs.test.ts` (12) | plafond (normalisation, lecture env/store), liste triée, **principal ≠ doit tourner**, plafond nommant le refus, **non-régression 1 bot**, tous éteints ⇒ refus |
| `tests/bots/actif.test.ts` (13) | `definirActif` (écriture, `inchange`, plafond, dernier actif, types) + route (403 sans en-tête, registre mémoire, 409, 405/404/400, mode mono) |
| `tests/config/schema-scope.test.ts` | compteur 89 → **90** clés et 66 → **67** `instance`, avec la clé nommée (l'ajout est **délibéré**) |
| `tests/config/config-bots.test.ts` (8, **L3-a**) | deux bots ⇒ deux runtimes/overlays/valeurs · identifiant invalide refusé · **non-régression 1 bot actif : instantané COMPLET identique** (10 clés nommées + `snapshot()` des 90) · la Map couvre `aDemarrer` et **pas** les refusés du plafond · bot de pile toujours présent · écrire l'overlay d'un bot ne touche pas le principal |
| `tests/sources/piles-par-bot.test.ts` (12, **L3-c**) | **pile du principal identique** (objets `===`, `Env` du démarrage, chemins historiques, `construire` jamais appelé) · `config`/`outils` par identité · deux bots ⇒ deux `Env`/stores/journal/pré-autos/envois/config, fichiers isolés · `envPourBot` **une seule fois** par bot et **même `Env`** que les outils L3-b · une **cible par bot à démarrer** (bot éteint ou sans capacité exclu) · bot **refusé par le plafond** : pas de pile, pas de cible, aucun fichier ouvert · **mode mono-bot** (registre absent, `aDemarrer` vide) : `yuki` reste balayé |
| `tests/bots/hosts.test.ts` (11, **L3-d**) | **host du principal identique** (l'objet d'options passé à `creer` est `optionsPile` **par identité** ; `sessionsDir`, `systemPrompt` et chaque port `===`) · deux bots ⇒ **deux hosts**, `sessionsDir` distincts et `systemPrompt` du **bon** `configBot` · les ports de la pile/outils du bot (`===`) et **délégation** à son service · la **mémoire est retirée** au bot secondaire (`port_absent`) · un bot **sans configuration** n'a pas de host · deux hosts ne partagent **jamais** `sessionsDir` · un host secondaire qui échoue au `start()` **n'empêche pas** les autres · **refusé par le plafond** ⇒ pas de host et **contexte jamais demandé** · cycle `demarrerAutres`/`arreter` (le principal n'est ni démarré ni arrêté par la fabrique) · garde statique : `host = hostsBots.principal`, `getSubsystems` **ne lit pas** la Map, et `createWsTransport` reçoit `host` (principal) **et** `hosts: hostsBots` (L4) |
| `tests/gateway/ws/multibot.test.ts` (13, **L4**) | sans `botId` ⇒ **principal** (`welcome` sans champ `bot`, aucun échec de non-régression) · `botId=kohai` ⇒ **SON** host répond (sa liste, son run ; le principal n'est **pas** sollicité) · bot **inconnu** ⇒ `bot_inconnu` **nommant le bot**, aucune trame `welcome`/`sessions` · bot **arrêté** ⇒ idem · `resume` porte le `botId` · **une session de `kohai` n'est jamais lisible par `yuki`** (rejeu et snapshot, avec le **même** identifiant de session chez les deux) · conversation privée de `kohai` introuvable (`session_inconnue`) et absente de la liste du principal · `?bot=` sur l'URL du WS (rattachement, **404** si inconnu, principal sans `?bot=`) · validation du champ (`invalid_bot_id`, valeur nettoyée, **aucun** champ quand absent) |
| `tests/ui/bot-conversation.test.ts` (7, **L4**) | `?b=` absent/vide ⇒ **aucune** clé `botId` (trame d'avant L4) · `botId` joint sinon · badge : le **serveur** fait foi (`welcome.bot`), un bot non confirmé s'affiche « bot principal », rien demandé ⇒ aucun badge |
| `tests/bots/outils.test.ts` (11, **L3-b**) | **non-régression : les 7 chemins du principal identiques** en mono (`<state>/…`) et en multi (`<state>/bots/<id>/…`) · les objets de `main()` **réutilisés** (`===`) et **adoptés** par la fabrique · deux bots ⇒ deux `MemoryStore`/`avatarDir`/`personalityPath` · **isolation de construction** (souvenir d'un bot absent du store, de l'index et du fichier de l'autre) · `envPourBot` **une seule fois** par bot (aucun `<bot>/<bot>`, `Env` doublement dérivé **refusé**) · identifiant invalide refusé · Map = `aDemarrer` + pile, **jamais** les refusés du plafond |

| `tests/chat/canaux-bot.test.ts` (19, **L5**) | **un bot ne voit JAMAIS le miroir d'un autre** (central) · un canal d'un autre bot n'est pas proposé, même présent dans son miroir · un bot sans miroir ne propose **rien** · revendication persistée (0600) et relue · refus NOMMANT le propriétaire, sans écriture · le port refuse **AVANT** l'envoi · gardes statiques sur `main()` (`canauxBots.canaux(botId)`, `revendiquerEtAutoriser`, `hostDuBot`) |
| `tests/agents/executions-bots.test.ts` (10, **L6**) | **TEST CENTRAL : deux bots, un agent partagé ⇒ la commande du bot non autorisé est refusée (`agent_not_allowed`), celle du bot autorisé passe** · le MÊME service refuse puis accepte selon l'agent (contrôle PAR COMMANDE) · un agent autorisé pour deux bots passe des deux côtés · un bot non démarré n'a **aucun** service · `pourChacun` couvre tous les bots (réveil, pré-autos) · `botDuRun` (absent ⇒ pile) |
| `tests/bots/workers.test.ts` (11, **L7**) | **paresseux** (aucune fabrique au démarrage ; principal semé par identité) · **pas de worker sans capacité** (fabrique non appelée) · un bot muet ne coûte rien · plafond nommant plafond + bots · RSS journalisé (construction et relevé) · `oublier` · un refus dit **une fois** |
| `tests/bots/arret.test.ts` (7, **L9**) | ordre des étapes (`run → sources → host → mémoire → pile → tts → plateforme`) · **idempotent** (déjà arrêté ⇒ aucune étape) · **isolé** (aucune étape d'un autre bot) · un échec n'interrompt pas les suivantes et le bilan le nomme |
| `tests/bots/execution-bots.test.ts` (14, **L8/L9**) | l'état vient de l'**exécution** (`demarre`, `sessions`, `workers`), pas du registre · **DÉMARRER ouvre la pile PUIS démarre le host** · **ARRÊTER détruit host + pile** et exécute les étapes · arrêt **idempotent** · arrêter un bot **ne touche pas** les autres · principal refusé · erreur de démarrage **mémorisée et affichée** · plateformes reconnectées au démarrage |
| `tests/bots/bots-etat-reel.test.ts` (6, **L8, à la ROUTE**) | `GET /api/bots` joint `execution` · un bot `actif: true` non démarré est dit **arrêté** · `PATCH actif:true` **démarre** (pile puis host) sans redémarrage requis · `PATCH actif:false` **arrête et détruit** · dernier bot actif toujours refusé (`409`) · sans port d'exécution, retour au comportement de L2 |
| `tests/chat/jetons-adaptateurs-bots.test.ts` (15, **L10**) | noms `YUKI_CHAT_<BOT>__<PLATEFORME>` (+ ancien nom pour `yuki`) · **deux bots ⇒ deux jetons** · **même jeton ⇒ refus nommant les deux**, aucune connexion · un bot `mattermost` et un bot `local` coexistent · un adaptateur par paire, connexion/déconnexion **par bot** · échec d'un bot n'empêche pas les autres · **résolution du bot par le jeton** |

Preuve d'échec **L5 → L10** : arbre **propre** au départ (`git status` **vide**,
HEAD `c2f6592` — les commits externes « Update N files across… » restent
**signalés, non défaits**), gelé **avant toute écriture** dans
`/tmp/preuve-lot36-L5/arbre-avant.tar.gz` (contenu vérifié : **`src/` présent**,
**330** entrées ; les **sept** modules du lot **absents** : `chat/canaux-bot.ts`,
`agents/executions-bots.ts`, `bots/workers.ts`, `bots/execution.ts`,
`bots/arret.ts`, `chat/jetons-bot.ts`, `chat/adaptateurs-bots.ts`). Sur l'origine
(`/tmp/preuve-lot36-L5/origine`) : **7/7** fichiers de tests en échec (**10**
tests) — six échouent à l'import (module absent) et
`tests/agents/executions-bots.test.ts` échoue **comportementalement**
(`ExecutionsAgentsBots` absent de `src/agents/index.ts` : les 10 tests tombent).

Preuve d'échec **L4** : arbre **propre** au départ (`b094c61`, `git status`
**vide**), gelé **avant toute écriture** dans
`/tmp/preuve-lot36-L4/arbre-avant.tar.gz` (contenu vérifié : **330** entrées
`src/`, les fichiers du lot **absents** — `BotHostsPort` 0 occurrence,
`botId` 0 occurrence dans `protocol.ts`, `public/ui/bot-conversation.js`
inexistant). Sur l'origine (extrait dans `/tmp/preuve-lot36-L4/origine`, mêmes
fichiers de test et même harnais copiés), **9/13** tests de
`multibot.test.ts` **échouent** — les 4 restants sont les **gardes de
non-régression** (sans `botId`, tout se comporte comme avant : c'est voulu).

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

Preuve L3-c : arbre **propre** au départ (`git status` vide, HEAD `c0b0d75` —
commits externes réguliers « Update N files across… », **signalés, non défaits**),
gelé **avant toute écriture** dans `/tmp/preuve-lot36l3c/arbre-avant.tar.gz`
(vérifié : **`src/` présent**, 328 entrées ; `src/sources/pile-bot.ts` et
`tests/sources/piles-par-bot.test.ts` **absents**). Sur l'origine, le fichier de
tests échoue à l'import (`src/sources/pile-bot.ts` absent) ; la preuve
**comportementale** est faite à part, sur `/tmp/preuve-lot36l3c/origine`, avec un
test qui n'utilise QUE l'API de HEAD : avec `aDemarrer = [yuki, second]` et
`refuses = [troisieme]`, l'origine rend `['yuki','second','troisieme']` (le bot
refusé par le plafond est balayé) au lieu de `['yuki','second']` — et
`pourBot("troisieme")` lui ouvre une pile au lieu de lever.

Preuve L3-d : arbre **propre** au départ (`git status` vide, HEAD `3ad0e07` —
commits externes « Update N files across… » **signalés, non défaits**), gelé
**avant toute écriture** dans `/tmp/preuve-lot36l3d/arbre-avant.tar.gz` (vérifié :
**`src/` présent**, 833 entrées ; `src/bots/hosts.ts` et
`tests/bots/hosts.test.ts` **absents**, et `PiHostOptions` **sans** `botId`). Sur
l'origine (`/tmp/preuve-lot36l3d/arbre-avant`), la suite échoue à l'import
(`Cannot find module '../../src/bots/hosts.js'`) — **11/11** tests non lancés,
donc en échec.

`tsc` vert sur **les deux** projets. Campagne **complète** (fin de L3) :
`npm test` **4499/4504** (401 fichiers : 398 verts, 3 ignorés ; 5 tests ignorés),
et les **11 E2E** : `e2e-sources` 43/43, `e2e-chat-sessions` 36/36,
`e2e-tts-ui` 116/116, `e2e-memory` 23/23, `e2e-files` 71/71, `e2e-image` 124/124,
`e2e-timestamp` 49/49, `e2e-mobile-ui` 40/40, `e2e-pins-agents` 59/59,
`e2e-ack` 44/44, `e2e-secret` 28/28 — **CSP 0 / connexion 0 / exceptions 0**
partout. Les **36 PNG suivis** réécrits par les harnais ont été restaurés **un par
un** (`git show "HEAD:<chemin>" > <chemin>`), sans aucune remise globale :
`git status` est identique avant/après (5 modifiés, 2 ajoutés).

**Instance RÉELLE** (port libre, volumes temporaires, `bots.json` à 2 bots
actifs) : `bots.config` (yuki,kohai) · `bots.outils` (yuki,kohai) · `bots.hosts`
(**nombre 2**, `ids: yuki,kohai`) · `bots.host.construit` (kohai,
`sessions_dir: …/sessions/kohai`) · **deux** `pi.ready` (`bot: yuki` /
`bot: kohai`, deux `sessions_dir` distincts) · `bots.hosts.demarres` (kohai) ·
`sources.bots.prets` (`piles: 2`, `hosts: yuki,kohai`) ·
`sources.balayeur.started` (`bots: 2`) · `gateway.listening` (`pi: "ready"`) ·
`bots.hosts.arretes` (kohai) · **0 ligne `error`**. Contrôle de non-régression :
la même instance avec **un** bot actif donne `bots.hosts` **nombre 1**, **un
seul** `pi.ready` et `sources.balayeur.started` **bots 1** — 0 erreur.

### Campagne L5 → L10 (mesurée)

- `tsc` vert sur **les deux** projets (`tsconfig.json` **et** `tsconfig.test.json`).
- `npm test` **complet** : **407** fichiers verts (+ 3 ignorés), **4 601** tests
  verts, **5** ignorés, **0** échec (410 fichiers au total).
- **11 E2E** verts, CSP **0**, connexion **0**, exceptions **0** :
  `e2e-sources` 43/43, `e2e-chat-sessions` 36/36, `e2e-tts-ui` 116/116,
  `e2e-memory` 23/23, `e2e-files` 71/71, `e2e-image` 124/124, `e2e-timestamp`
  49/49, `e2e-mobile-ui` 40/40, `e2e-pins-agents` 59/59, `e2e-ack` 44/44,
  `e2e-secret` 28/28. Les **36 PNG** suivis réécrits ont été restaurés **un par
  un** (`git show "HEAD:<chemin>" > <chemin>`) : `git status` final **identique**
  au départ, hors fichiers du lot (**aucun PNG**).
- **Garde de test CHANGÉE (nommée)** : `tests/bots/profils.test.ts` (L7 — la
  garde vérifie désormais
  `construireWorkerLourdSiAutorise(capacitesDuBot(botId), …)` : le worker est par
  bot) et `tests/config/schema-files.test.ts` (L7 — la borne d'images est lue
  dans la configuration **du bot** pour le worker lourd ; toujours **deux**
  branchements). Aucune autre garde n'a été retirée.

**Instance RÉELLE à deux bots** (`bots.json` : `yuki` + `kohai` actifs, port
libre, volumes temporaires) — mesuré :

| Mesure | Résultat |
|---|---|
| démarrage | `bots.demarrage` (`a_demarrer: yuki,kohai`) · `agents.executions.bots` **2** · `bots.workers.rss` (**1** worker semé, plafond 3, 219 Mo) · `bots.hosts` nombre **2** · `bots.execution.pret` · `chat.adaptateurs.bots` (2 paires = la pile) · **0 ligne `error`** |
| `GET /api/bots` | `execution` joint : `yuki {demarre:true, sessions:1, workers:1}`, `kohai {demarre:true, sessions:0, workers:0}` |
| **Arrêter** `kohai` (L8/L9) | `applique {ok:true}` · `redemarrageRequis:false` · `execution {demarre:false}` · journal `bots.host.detruit` (kohai), `sources.pile.fermee` (kohai), **`bots.arret` étapes `host,memory,pile,plateforme`, 0 échec** · `yuki` **intact** (`demarre:true, sessions:1`) · **aucune écriture** dans `state/bots/kohai/` après l'arrêt (mtime stable 6 s) |
| re-`PATCH actif:false` | `inchange:true`, `applique: null` (idempotent) |
| **Démarrer** `kohai` | pile rouverte (`sources.pile.ouverte` kohai) puis host **reconstruit** (`bots.host.construit`, nouveau `pi.ready bot: kohai`) · `bots.demarrage {inchange:false}` · `execution.demarre:true` |
| WS (L4 non-régression) | `/ws` sans `?bot=` ⇒ `welcome` **sans** champ `bot` ; `/ws?bot=kohai` ⇒ `welcome.bot = "kohai"` |
| arrêt gracieux | `gateway.shutdown` → `bots.hosts.arretes (kohai)` → `bots.workers.rss` **final** → `gateway.stopped exitCode 0`, **0 erreur** |
| rendu `/bots?b=kohai` | section « Exécution » (Démarrage « démarré », Sessions, Worker lourd) + boutons **Démarrer** (désactivé) / **Arrêter** — mise en page intacte, aucun style en ligne |

### Campagne L4 (mesurée)

- `npm test` **complet** : 400 fichiers, **4519** tests verts, 5 ignorés, 0 échec.
- **11 E2E** verts, CSP **0**, connexion **0**, exceptions **0** : `e2e-sources`
  43/43, `e2e-chat-sessions` 36/36, `e2e-tts-ui` 116/116, `e2e-memory` 23/23,
  `e2e-files` 71/71, `e2e-image` 124/124, `e2e-timestamp` 49/49,
  `e2e-mobile-ui` 40/40, `e2e-pins-agents` 59/59, `e2e-ack` 44/44,
  `e2e-secret` 28/28. Les **36 PNG** suivis touchés par deux d'entre eux ont été
  restaurés **un par un** (`git show HEAD:<chemin>`), `git status` final
  **identique** à celui du départ (hors fichiers du lot).
- **Instance RÉELLE à deux bots** (`bots.json` : `yuki` + `kohai` actifs) :
  **15/15** mesures — trame **sans** `botId` ⇒ `welcome` sans champ `bot` (compat) ;
  `botId=kohai` ⇒ `welcome.bot = "kohai"`, **sa** conversation créée, **son** host
  répond à un message (`LLM_UNAVAILABLE` : l'instance n'a pas de clé — c'est bien
  KHOHAI qui a répondu, `yuki` n'a jamais été sollicité) ; la conversation de
  `kohai` **n'apparaît pas** dans la liste de `yuki` et son ouverture est refusée
  (`session_inconnue`) ; `botId=yuki` (le lien `/bots?b=yuki`) ⇒ host du **principal**,
  sa liste, jamais celle de `kohai` ; bot inconnu ⇒ `bot_inconnu` nommant
  `fantome`, **aucune** trame `sessions` ; `?bot=kohai` sur `/ws` rattache la
  connexion ; journal :
  `bot: yuki` et `bot: kohai` (deux `sessions_dir` distincts), `bots.hosts`
  `nombre: 2`, `bots.hosts.demarres` (kohai), `bots.hosts.arretes`, **0 ligne
  `error`**. Vérifié aussi au **rendu** : `/?b=kohai` affiche le badge `kohai`
  dans l'en-tête (mise en page intacte) et `/bots?b=kohai` propose le lien
  « Conversation ».

⚠️ **Invérifiable en test unitaire** : `main()` n'est jamais exécuté par la suite
(`src/index.ts` lance `main()` au chargement). Le câblage de `main()` n'est donc
couvert que par (a) la **garde statique** de `tests/bots/hosts.test.ts` et de
`tests/pi/sdk-host-programmer-envoi.test.ts`, et (b) la campagne **E2E** +
l'instance réelle ci-dessus.

### Ce qui reste INVÉRIFIABLE ici (dit précisément)

- **Une vraie plateforme distante** (Mattermost/Discord) : l'instance de
  vérification n'a aucun jeton. Le code L10 est couvert par des **fixtures**
  d'adaptateurs et par la résolution de jetons ; une connexion réelle, un envoi
  réel et un conflit de jeton réel ne peuvent pas être prouvés sans deux
  applications créées côté plateforme (ce que seul l'utilisateur peut faire).
  ⚠️ Ce n'est PAS du code à écrire : tout le code est écrit et testé.
- **La publication dans un canal** (`canaux()` d'un bot, revendication et refus
  « canal déjà possédé ») n'est pas déclenchable sans plateforme : elle est
  prouvée en unitaire (`tests/chat/canaux-bot.test.ts`, 19 tests) et par gardes
  statiques sur `main()`. Aucun miroir ni fichier de propriété n'est donc créé
  dans l'instance de vérification (vérifié : `chat-canaux-proprietaires.json`
  et `chat-mirror.json` **absents** — rien n'a été publié).
- `main()` n'est **jamais** exécuté par la suite de tests (`src/index.ts` lance
  `main()` au chargement) : le câblage est couvert par les **gardes statiques**,
  les **11 E2E** et l'**instance réelle** ci-dessus.

