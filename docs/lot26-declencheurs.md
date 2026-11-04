# Lot 26 — Déclencheurs (1/4 sortie silencieuse · 2/4 moteur horloge · 3/4 page de gestion · 4/4 pré-autorisations)

Un **déclencheur** est un programme extérieur (veille, CI, messagerie…) qui
réveille Yuki par `POST /api/sources/<nom>/messages`, authentifié par le jeton de
la source (coffre `YUKI_SOURCE_<NOM>`). Ce lot pose le **socle v2** et rend la
sortie **silencieuse par défaut**.

## 1. Modèle v2 (`src/sources/types.ts`, `sources.json` `schemaVersion: 2`)

| Champ | Valeur | Rôle en L1 |
|---|---|---|
| `nom` | `^[a-z0-9_-]{1,32}$` | clé de la source |
| `declencheur` | `{ type: "webhook" }` ou `{ type: "planning", expression, fuseau }` | `planning` = moteur horloge (lot 2, §8) |
| `consigne` | texte ≤ 2 000 | oriente la décision de Yuki |
| `visibilite` | `silencieux` \| `visible` — **défaut `silencieux`** | réglage central |
| `destination` | `aucune` \| `source` \| `nouvelle` \| `courante` \| id de conversation | **utilisée SEULEMENT si `visible`** |
| `tour` | `lancer` \| `stocker` | **utilisé SEULEMENT si `visible`** |
| `notifier` | booléen — **forcé `false` si `silencieux`** | Web Push |
| `preAutorisations` | liste — **`[]` jusqu'au lot 4** | colonne « pré-autorisations actives » de la page de gestion (lot 3) |
| `chevauchement`, `rattrapage`, `plafondMs`, `maxToursParJour`, `actif`, `etat` | — | **câblés au lot 2** (voir §8) |

Créer une source en fournissant un réglage du modèle v1 (`tour`, `destination`,
`notifier`) sans dire la visibilité ⇒ la source reste `visible` (on ne change
jamais un comportement sans le dire).

## 2. Migration v1 → v2 (`src/sources/store.ts`)

*Lecture* : `schemaVersion: 1` ⇒ conversion **en mémoire** puis réécriture.
Tout enregistrement v1 (`tour`/`conversation`/`notifier`) devient
`visibilite: "visible"` ; `conversation` devient `destination` ; `notifier` est
conservé.
*Filet* : le texte d'origine est copié **avant** dans `sources.json.v1.bak`
(0600, **jamais écrasé** s'il existe). Si la sauvegarde échoue, on ne réécrit
rien.
*Aucune perte* : un enregistrement inexploitable (sans `nom`) est conservé
**verbatim** sous `invalides` et journalisé (`sources.store.migrate.*`) ; un nom
hors forme est conservé tel quel + journalisé.
*Idempotence* : un fichier déjà en v2 n'est **jamais réécrit** à la lecture.

## 3. Sortie silencieuse (`src/sources/service.ts`)

1. Réception : **aucune entrée** dans la boîte « Notifications », aucun Web Push,
   aucune pastille. Le contenu reçu n'existe que dans le journal.
2. Le bloc `<sources>` encadré (`src/sources/frame.ts`) porte en plus le rappel
   `SOURCES_SILENCE_REMINDER` : *« si tu n'as rien à dire, réponds exactement
   RIEN »*. Le bloc reste retirable du transcript (`stripSourcesBlock`).
3. Tour dans l'unique fil **« Déclencheurs »** ; le message est injecté avec
   l'origine `source` (aucune bulle du contenu reçu).
4. `run_finished` :
   - réponse normalisée `RIEN` (casse, guillemets, ponctuation) ⇒ **rien n'est
     publié** (journal `silence`) ;
   - sinon ⇒ le fil devient **« Déclencheurs »** et le résultat y est publié
     (journal `publie`).
   - tour arrêté/en erreur ⇒ journal `echec` avec la raison exacte.

## 4. Le fil « Déclencheurs »

Un **seul** fil, partagé par tous les déclencheurs silencieux. Il n'est créé
qu'au **premier résultat non vide** : tant qu'un tour répond `RIEN`, le fil
candidat est **supprimé** (`deleteSession`) pour qu'aucun fil vide n'apparaisse.
Son identifiant est persisté dans `sources.json` (`declencheurs.sessionId`) ; s'il
a été supprimé par l'utilisateur, il est **oublié puis recréé** au résultat
suivant (aucune sortie perdue). Le focus n'est jamais volé (mécanique
`restoreFocus` : `newSession()` le prend, on le rend).

## 5. Journal (`src/sources/journal.ts`)

`declencheurs-journal.jsonl` (volume `state`, 0600), **append-only**, jamais
affiché dans l'interface de conversation. Événements `recu` (instant, nom, taille,
contenu **borné à 8 000 caractères**, troncature dite), `silence`, `publie`
(résultat), `echec` (raison), puis (lot 2) `saut`, `plafond`, `desactive`,
`refus`, et (réservé lot 4) `preautorisation` — outil pré-autorisé consommé, porté
par le champ `preAutorisation`. Purge à **30 jours** (réécriture atomique ; une
ligne illisible est conservée).

Lecture **gardée** et **bornée** (lot 3) :
`GET /api/sources/journal?limite=N&type=echec,saut&source=<nom>` → `{ evenements,
limite, types, filtre }`. `limite` est plafonnée à **200**. ⚠️ Le filtre est
appliqué **avant** la borne (`recent(50, {types:["echec"]})` rend les 50 derniers
échecs, pas les échecs des 50 dernières lignes) ; un type inconnu est **refusé**
(400 `invalid_journal_type`) — un filtre muet ferait croire à un journal vide.

## 6. Pastille

`nonLus` ne compte plus que les **échecs** et les **alertes** non lus
(`SourcesInbox.alertCount`) : une réception ne fait plus monter la pastille. La
section Notifications porte un lien vers la page de gestion : `/config#declencheurs`
(lot 3). L'ancienne ancre `#sources` reste acceptée (`ANCRES_PROFONDES`), mais
n'est plus celle qu'on affiche.

## 7. UI (`public/ui/sources-panel.js`)

Nouveau réglage **Visibilité** avec un texte explicite ; en `silencieux`, les
réglages de destination, de tour et de notification sont **masqués ET
désactivés**. Depuis le lot 3, la page de gestion (onglet **Déclencheurs**) est
décrite au §10.

## 8. MOTEUR HORLOGE (lot 2/4)

### 8.1 Évaluateur cron (maison, 5 champs, zéro dépendance) — `src/sources/cron.ts`

Format `minute heure jour-du-mois mois jour-de-semaine`. Supporté : `*`, `a`,
`a-b`, `a-b/n`, `*/n`, listes `a,b,c`. **Refus explicite** (le message rappelle la
syntaxe supportée) : `L`, `#`, `?`, `@reboot`, noms de mois/jours, pas seuls
(`5/10`), plages inversées, valeurs hors bornes (`cron.ts:135-160`).

- ⚠️ **jour-du-mois ET jour-de-semaine ENSEMBLE ⇒ OR** (sémantique cron) :
  `0 0 1 * 1` tire le 1er du mois **et** chaque lundi ; dès qu'un des deux champs
  est un joker, c'est un ET (`cron.ts:jourCorrespond`).
- ⚠️ **Fuseau PAR DÉCLENCHEUR** (`fuseau`, `Europe/Paris` par défaut), évalué via
  `Intl.DateTimeFormat` — **jamais le fuseau du process** (en conteneur, UTC :
  `0 9 * * *` tirerait à 9 h UTC).
- ⚠️ **DST** : on itère sur des minutes **locales**, jamais UTC ⇒ une heure locale
  répétée (retour à l'hiver) ne tire **qu'une fois**, une heure locale supprimée
  (passage à l'été) est sautée.
- `prochainPassage` est **borné à 5 ans** puis **échoue explicitement**
  (`aucune_occurrence`) : `0 0 31 2 *` n'existe jamais.

### 8.2 Balayeur — `src/sources/scheduler.ts`

Un **seul** `setInterval` de 30 s, **horloge et timers injectables**. À chaque
balayage : armer (`prochainPassage`), ou constater le retard. ⚠️ Le réarmement est
**persisté AVANT** de lancer le travail (un plantage ne double pas un tir).

- **État persisté** (`sources.json`) : `prochainPassage`, `dernierPassage`,
  `actif`, `etat`, `raisonInactive`, `toursDuJour` ⇒ **reprise après
  redémarrage** : au premier balayage, un passage dépassé est traité par la règle
  de rattrapage.
- **Rattrapage** : **une seule fois** si le retard est **< 1 h**
  (`RATTRAPAGE_MAX_MS`), au-delà **sauté** et journalisé (`saut`). Politique
  `rattrapage: "sauter"` ⇒ aucun rattrapage.
- **Chevauchement** : défaut **`sauter`** (journalisé) ; `remplacer` **annule** la
  tâche en cours (`cancelJob`) au profit de la nouvelle.
- **Plafond d'exécution** `plafondMs` : défaut **10 min**, borné **60 s – 2 h** ⇒
  la tâche est **ANNULÉE** et journalisée (`plafond`). ⚠️ C'est lui qui protège
  des blocages, pas le chevauchement.
- **`maxToursParJour`** (défaut **200**, jour **local** du déclencheur) : au-delà,
  `actif = false` + `raisonInactive` visible dans `/config` + journal `desactive`.

### 8.3 ⚠️ Le déclencheur lance **directement un JOB LOURD**

```
déclencheur → JOB LOURD (a déjà tous les outils) → résultat publié dans « Déclencheurs »
```

- Le rôle léger n'a **aucun outil d'action** (`execution: []`,
  `src/llm/tool-policy.ts`) : agir exigerait une délégation. Pour des **tâches de
  fond**, la lenteur du worker lourd n'est pas un problème (plus lent, plus
  fiable) ⇒ le détour par le léger est **supprimé** : le service appelle
  `delegate` **programmatiquement** (`src/sources/service.ts`, port
  `DeclencheurJobsPort`), avec l'origine `declencheur`
  (`src/sources/frame.ts:ORIGIN_DECLENCHEUR`).
- La tâche transmise porte : la **consigne** de l'utilisateur, le **contenu
  encadré** (`src/sources/frame.ts`), la règle **`RIEN`**, la règle
  **`DÉSACTIVER`**, et ⚠️ la limite des **approbations** (voir 8.5).
- **Résultat** : à la fin de la tâche, le texte est **publié dans le fil local
  « Déclencheurs »** (`PiHost.publierMessage`, message assistant persisté **sans
  tour de modèle** ; `src/pi/sdk-host.ts`). L'invariant « un seul rédacteur »
  concerne les **canaux** : ici on écrit dans un fil local.
  - `RIEN` ⇒ rien n'est publié (journal `silence`, fil candidat supprimé) ;
  - `DÉSACTIVER` en **dernière ligne** ⇒ `actif = false`, raison persistée,
    marqueur **retiré du texte publié** ;
  - échec/annulation de la tâche ⇒ rien n'est publié, journal `echec`.
- **Canaux distants (Mattermost/Discord)** : **inchangé** — le rapport d'un job
  réveille Yuki, qui publie (`src/chat/wake/channel-waker.ts`).
- ⚠️ **Anti-enchaînement** : un job ne peut pas créer de déclencheur (le worker
  lourd n'a aucun outil pour cela) et `SourcesService.declencher` **refuse** toute
  origine autre que l'horloge (journal `refus`).

### 8.4 Configuration et interface

- Champs câblés : `declencheur:{type:"planning", expression, fuseau}`,
  `chevauchement`, `rattrapage`, `plafondMs`, `maxToursParJour`, `actif`.
- `/config` → Sources : **type** de déclencheur, **expression**, **fuseau** et
  ⚠️ **aperçu du prochain passage** (`GET /api/sources/apercu`, lecture gardée) :
  une expression fausse se voit tout de suite, avec la raison.
- **Validation explicite** à la création/modification : expression invalide ou
  fuseau inconnu ⇒ **400** avec le message (`SourceValidationError`), rien n'est
  enregistré.

### 8.5 ⚠️ Approbations : ce que fait une tâche de fond (résolu au §11)

Établi : `run_command` **ne bloque pas**. Quand le niveau de garde-fou de l'agent
exige une validation humaine, l'exécution renvoie **immédiatement**
`awaiting_validation` — la commande n'est **pas** exécutée
(`src/agents/execution.ts:672-687`) ; la demande expire après
`APPROVAL_TTL_MS` = **5 min** (`src/agents/approvals.ts:86`). Verrouillé par
`tests/agents/execution.test.ts:205-214`.

⇒ Sans **pré-autorisation** (lot 4), une tâche de fond qui exige une approbation
**échoue proprement** : elle ne reste pas bloquée, mais l'action n'a pas lieu. La
tâche du déclencheur le DIT au modèle (« une action qui exige une APPROBATION
humaine ne peut pas en obtenir une depuis une tâche de fond : dis-le clairement »),
pour qu'il ne tourne pas en boucle. Un test le verrouille
(`tests/sources/balayeur.test.ts`, « approbations »).

## 9. Lots suivants

- **Lot 4 (livré, §11)** : les **pré-autorisations** — une tâche de fond peut
  exécuter une commande déclarée à l'avance, sans humain.
- Restent hors périmètre : d'autres types de déclencheur, et une autorisation
  « à budget » (N exécutions) : le modèle actuel est **une consommation = une
  exécution**.

## 10. PAGE DE GESTION (lot 3/4)

**Où** : onglet **dédié** `/config#declencheurs` (`public/ui/config.html`,
`#panel-declencheurs`), avec le groupe `sources` (borne d'injection du bloc
`<sources>`) et `#sources-root`. Le panneau vivait en bas de « Conversation »
(~4 écrans de défilement) : il était introuvable. Le nombre d'onglets passe à
**10** (verrou de `tests/integration/static-ui.test.ts` mis à jour).

Ancres profondes (`ANCRES_PROFONDES`, `public/ui/config.js`) : `#declencheurs`,
`#sources` (ancien lien, conservé) et `#journal-declencheurs` (volet journal, visé
par la colonne « dernier résultat »).

**Les règles vivent dans `public/ui/declencheurs-vue.js`** (fonctions pures, sans
DOM, testées sans navigateur) ; `sources-panel.js` ne fait que rendre.

### 10.1 Trois sections

| Section | Contenu |
|---|---|
| **Permanents** | `webhook` (toujours), `planning` dont la date revient indéfiniment |
| **Temporaires** | `planning` **ponctuel** (jour-du-mois **et** mois fixes : `0 9 3 5 *`), ou **auto-terminant** (`actif: false` par `DÉSACTIVER`, `maxToursParJour` atteint) |
| **En sommeil** | `actif: false` — la raison est affichée (`raisonInactive`) : `DÉSACTIVER`, garde-fou, destination supprimée… |

⚠️ **Aucune disparition silencieuse** : les trois sections sont toujours rendues
(même vides) et un déclencheur éteint reste listé. ⚠️ Un **temporaire éteint**
reste 7 jours dans « Temporaires » avec sa date d'extinction
(`JOURS_VISIBILITE_TEMPORAIRE`, `desactiveLe`) — sinon on ne sait plus qu'il a
existé — puis il rejoint « En sommeil ». Une date d'extinction illisible ne cache
rien (on garde).

### 10.2 Colonnes

`Nom` (avec visibilité + destination en note) · `Quand` (expression, fuseau,
**prochain passage**) · ⚠️ **`Dernier passage`** · `Dernier résultat` (résumé du
dernier événement de journal + lien `journal`) · `État` · `Pré-autorisations
actives` · `Tours aujourd'hui / plafond` · `Jetons cumulés` · `Actions`.

⚠️ **« Dernier passage » est la raison d'être de la page** : sans elle, une source
muette depuis trois jours est **indistinguable** d'une source qui travaille. Elle
affiche `dernierPassage` (tir planifié) ou `dernierAppel` (message reçu), et
**« jamais »** quand aucun des deux n'existe.

`Jetons cumulés` = somme des `usage` rapportés par les jobs
(`SourceRecord.jetonsCumules`, `SourcesStore.cumulerJetons`, alimenté dans
`SourcesService.recevoirResultat`) ; **« — »** quand aucun tour n'a rien rapporté
(aucun zéro inventé).

`Dernier résultat` vient de `GET /api/sources` → `dernierEvenement` par source
(lecture **bornée** du journal, contenu réduit à 200 caractères).

### 10.3 Le journal (4ᵉ volet, replié)

`<details id="journal-declencheurs">` replié par défaut. Filtres : **type**
(`#journal-type`, tous les événements connus, `preautorisation` inclus) et
**déclencheur** (`#journal-source`). Le contenu affiché est borné à 400
caractères (8 000 côté journal, troncature **dite**). « Charger plus » augmente
la borne par pas de 50, **plafonnée à 200** : le journal n'est jamais chargé en
entier.

### 10.4 Tests

`tests/ui/declencheurs-page.test.ts` (règles : sections, dernier passage, prochain
passage cohérent avec `apercuCron`, pré-autorisations, journal borné/filtrable,
fenêtre de 7 jours, ancre et lien de pastille) et
`tests/sources/declencheurs-gestion.test.ts` (jetons cumulés, `desactiveLe`,
filtre du journal avant la borne, route `?type=&source=` + 400, `dernierEvenement`).

## Invérifiable en L1

- Le fil candidat est supprimé **après** le tour : entre sa création et la
  suppression, la liste des conversations peut l'afficher quelques secondes
  (fenêtre de rafraîchissement de l'interface).
- La publication du résultat repose sur le message **assistant** du tour dans le
  fil (aucune copie supplémentaire) : un client qui ne relit pas la conversation
  ne verra le résultat qu'à sa prochaine ouverture.

## Invérifiable / limites du lot 2

- ⚠️ La publication d'un résultat de déclencheur écrit un message assistant
  **sans tour de modèle** : le marqueur `DÉSACTIVER` est retiré du texte publié
  par le service (journal `publie`, message persisté), mais un texte écrit
  **avant** ce filtrage par un autre chemin n'existe pas — il n'y a pas de
  réécriture d'un message déjà publié.
- Le plafond `plafondMs` annule la tâche (`cancelJob`) : si le worker lourd était
  déjà en train d'exécuter une commande sur une machine appairée, cette commande
  peut se terminer côté agent (l'annulation n'atteint pas toujours l'agent).
- L'aperçu du prochain passage est calculé avec l'horloge du serveur : il ne
  prouve pas qu'un déclenchement aura lieu si le processus est arrêté à ce
  moment-là.
- Les approbations non répondables depuis une tâche de fond (8.5) sont un
  **constat** : la pré-autorisation est le lot 4.

## Invérifiable / limites du lot 3

- Les colonnes « pré-autorisations actives » et « jetons cumulés » sont
  **structurellement présentes**, mais au lot 3 le moteur ne consomme aucune
  pré-autorisation (`preAutorisations` reste `[]`) et un `usage` n'est compté que
  si le job le rapporte : la page affiche alors « aucune » et « — », ce qui n'est
  pas la preuve qu'aucun jeton n'a été consommé.
- « Dernier passage » pour un `webhook` s'appuie sur `dernierAppel`, écrit à la
  **réception** — pas à la fin du tour : un message reçu mais dont le tour a
  échoué apparaît comme un passage (le résultat, lui, dit l'échec).
- `desactiveLe` est écrit par `setActif` (mise en veille décidée par Yuki ou par
  l'interface) : une source rendue `actif: false` par une **écriture directe** de
  `sources.json` n'a pas de date (la fenêtre de 7 jours n'est alors pas datable,
  et le temporaire reste listé).
- Le rendu réel (mise en page, débordements) n'est pas prouvé par les tests
  unitaires : seul `_tools/e2e-sources.mjs` (navigué sur `/config#declencheurs`)
  le vérifie, au dernier lot.

## 11. PRÉ-AUTORISATIONS (lot 4/4) — agir SANS humain, quand c'est AUTORISÉ

**Le problème** : un déclencheur qui se réveille à 3 h du matin ne peut demander à
personne. `run_command` renvoie alors `awaiting_validation`, la demande expire en
5 minutes (`src/agents/approvals.ts`), et l'action n'a pas lieu.

**Le modèle** (`src/agents/preautorisations.ts`) :
`{ id, declencheur, agentId, motif, portee ("exacte" | "prefixe"),
destructifAutorise, expireA, creeLe, consommeeLe?, consommations, revoqueeLe? }`.

- ⚠️ **portée TOUJOURS bornée** : un déclencheur, un agent, **un** motif. Un `*`
  dans le motif est **refusé** (création **et** saisie de la page) : on ne
  rattrape pas un joker dans un champ de sécurité ;
- **préfixe explicite seulement** (`portee: "prefixe"`, ≥ 8 caractères) — sinon
  égalité **stricte** de la commande ;
- **expirante** : 30 jours par défaut, 90 au maximum, 1 au minimum ;
- ⚠️ **une consommation = une exécution** : `consommeeLe` est posé, la seconde
  exécution redemande une approbation (elle n'est **pas** refusée : c'est le
  comportement normal, avec le message du §11.3) ;
- persistance : **`preautorisations.json`** sur le volume `state`
  (`env.preAutorisationsPath`, `YUKI_PREAUTORISATIONS_PATH`) — ⚠️ ni
  `config.json` (patch plat de scalaires) ni `sources.json` (cycles de vie
  différents). Écriture atomique `tmp` + `rename`, mode 0600, 200 entrées max,
  purge à 90 jours des autorisations terminées.

### 11.1 La GARDE (`src/agents/execution.ts`, `authorize`)

Évaluée **AVANT** `approvals.request` et **uniquement** quand le tour porte une
origine de déclencheur (`declencheur:<nom>`) :

| Situation | Décision |
|---|---|
| aucune autorisation pour ce déclencheur | comportement historique : `awaiting_validation` (+ message §11.3) |
| autorisation valide (agent + motif + non expirée + non révoquée + destructif assumé) | **consommation** ⇒ **journal** ⇒ **exécution** |
| toutes **révoquées** | **REFUS** |
| toutes **expirées** | **REFUS** |
| **agent différent** de celui autorisé | **REFUS** |
| **motif non couvert** | **REFUS** |
| destructrice sans `destructifAutorise` | **REFUS** |
| toutes **déjà consommées** | retour au comportement normal (attente) |

⚠️ **DOUTE ⇒ REFUS** : on n'exécute pas « au bénéfice du doute ». Un refus écrit
une ligne `refus` dans le journal des déclencheurs (`raison: "pré-autorisation : …"`).
⚠️ **INVARIANT** : le journal est écrit **AVANT** la marque de consommation ; si
l'écriture échoue, la pré-autorisation **n'est pas** consommée et rien n'est
exécuté.

### 11.2 Propagation de l'origine (le nom du déclencheur)

`src/sources/service.ts` → `delegate({ origin: "declencheur:<nom>" })` →
`JobRecord.origin` → `HeavyRunRequest.origine` (`src/delegation/service.ts`,
`startJob`) → `buildHeavyActionTools(…, origine)` → `run_command`
(`origin: origine ?? "run_command"`) → `ExecutionRequest.origin` → `authorize`.
Le champ `origin` **existant** est réutilisé (aucun nouveau canal) ; côté
délégation, `estJobDeclencheur()` reconnaît la forme courte **et** la forme nommée
(le rapport est publié sans réveiller le léger dans les deux cas).

### 11.3 Le message quand il n'y a PAS d'autorisation

`messageAttenteValidation(origine)` ajoute, pour une origine de déclencheur :
« cette commande vient d'une TÂCHE DE FOND (déclencheur « X »). Personne ne peut
valider à sa place : la demande expirera en 5 minutes […] déclarez une
PRÉ-AUTORISATION dans la page de gestion (/config, onglet « Déclencheurs ») ».
Sans cette phrase, le modèle conclut « en attente » et réessaie indéfiniment.

### 11.4 La page de gestion (onglet Déclencheurs, volet « Pré-autorisations »)

- **liste** : déclencheur · machine · ce qui est autorisé · destructeur · état
  (active / consommée / expirée / révoquée) · ⚠️ **compteur de consommations** ·
  échéance · action ;
- **saisie** : le catalogue des motifs vient du **serveur**
  (`MOTIFS_PROPOSES`, servi par `GET /api/sources/preautorisations`) — pas de
  copie locale qui dérive ; la **saisie manuelle** est un choix **explicite**
  (« Autre commande… »), jamais un défaut ;
- ⚠️ **affichage du risque** : « Cette tâche de fond « veille » pourra exécuter
  TOUTES les commandes commençant par « systemctl restart » sur cette machine
  « nuc00 », SANS VALIDATION humaine jusqu'au … » (`phraseRisque`,
  `public/ui/preautorisations-vue.js`) ;
- **confirmation** par `HolafModal` (jamais la boîte native), **révocation** en un
  clic, et renvoi vers le **journal** filtré ;
- routes **gardées** (`X-Yuki-Config: 1` + `Origin`/`Host`) :
  `GET`/`POST /api/sources/preautorisations`, `DELETE …/<id>`. Création refusée
  (400) si le déclencheur est inconnu, l'agent inconnu/révoqué, ou le motif
  invalide — codes `unknown_source`, `unknown_agent`, `revoked_agent`,
  `invalid_motif`, `invalid_portee`, `invalid_duree`.

### 11.5 Journal

Événements ajoutés au journal existant (`declencheurs-journal.jsonl`) :
`preautorisation` (consommation : `source` = déclencheur, `preAutorisation` =
motif, `texte` = commande exécutée) et `refus` (avec la raison préfixée
« pré-autorisation : … »). Le filtre `preautorisation` existait déjà côté page.

### 11.6 Tests

- `tests/agents/preautorisations.test.ts` — modèle + **la garde** (sans
  autorisation ⇒ attente ; avec ⇒ exécution sans approbation ; origine humaine ⇒
  ignorée ; motif/expiration/agent/révocation ⇒ refus ; une consommation = une
  exécution ; aucune consommation sans ligne de journal).
- `tests/gateway/preautorisations-api.test.ts` — gardes, catalogue, création,
  colonne « pré-autorisations actives » de `GET /api/sources`, révocation.
- `tests/ui/preautorisations-page.test.ts` — phrase de risque, refus du joker à
  la saisie, compteur, échéance, absence d'`innerHTML`.
- `tests/pi/heavy-action-tools.test.ts` — l'origine `declencheur:<nom>` arrive
  jusqu'au service d'exécution ; un tour humain garde `run_command`.

### 11.7 Invérifiable / limites du lot 4

- Le catalogue de motifs est **fermé par défaut** : une action utile mais non
  listée exige la saisie manuelle (choix explicite) — c'est voulu, mais cela
  signifie qu'une pré-autorisation « sur mesure » dépend de la vigilance de
  l'utilisateur, pas d'une validation par liste.
- ⚠️ La pré-autorisation **ne vérifie pas** que la commande existe réellement sur
  la machine, ni qu'elle est inoffensive : elle autorise un TEXTE. Un préfixe
  large (`~/scripts/`) autorise tout ce que le shell acceptera derrière.
- Une pré-autorisation autorise **une** exécution ; une tâche de fond qui doit
  agir chaque nuit demande donc une nouvelle autorisation chaque nuit (pas de
  renouvellement automatique — non implémenté volontairement).
- Le compteur `consommations` ne peut valoir que 0 ou 1 aujourd'hui : il est
  affiché tel quel pour distinguer « pas encore utilisée » de « à recréer ».
- Les essais ci-dessus portent sur la GARDE et l'API ; le rendu visuel réel de la
  section est vérifié par la campagne E2E (`_tools/e2e-sources.mjs`).
