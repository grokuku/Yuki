# Lot 35a — Multi-bot : structure + migration

⚠️ **Aucune fonction visible** : pas de page, pas d'écran, pas de bouton. Le
produit rend **exactement** les mêmes fichiers au même endroit ; seule leur
**disposition** change (sous `state/bots/yuki/`). Le garde-fou d'une boucle de
bots reste le seul **bouton `actif`** d'une paire — il n'y a **aucun frein, aucun
plafond** (rien de tel n'a jamais été demandé).

## 1. Registre `state/bots.json`

`src/bots/registry.ts` — `{schemaVersion: 1, bots: [...], echanges: {}}`.

- Un seul bot à la fin du lot : `{id:"yuki", nom:"Yuki", profil:"complet",
  actif:true, ordre:0, creeLe, plateformes:{}}` (`creerRegistreInitial`, `:121`).
- `echanges` est **vide** (les paires arriveront avec les canaux).
- Écriture **atomique 0600** (`tmp` + `rename`), partagée avec le journal :
  `ecrireFichierAtomique0600` (`src/bots/registry.ts:187`), comme
  `src/sources/store.ts:781-803`.
- Lecture **stricte** (`lireRegistreBots`, `:157`) : un fichier présent mais
  invalide **lève** — retomber en silence sur le mode mono-bot ferait écrire le
  bot aux anciens chemins, à côté des nouvelles données.
- Un **seul** fichier dédié : **aucune clé de bot dans `config.json`** (la
  scission des pages est le lot 1b).

## 2. Résolution des chemins par bot

`src/bots/paths.ts` — `pathsForBot(env, botId)` (`:284`) renvoie une **COPIE**
d'`Env` : il **surcharge** les chemins du bot, il ne remplace pas `env`. La
résolution est **injectée** (aucune variable globale), donc testable seule.

**Par bot** (22 clés d'`Env`, table `CHEMINS_BOT` `:105` → `<state>/bots/<id>/…`) :
mémoire (`memory.jsonl`, index SQLite, `memory-archive/consolidation`,
`memory-consolidation.json`, `memory-heritage`), archive des conversations
(+ index), `personality.md`, `rules.md`, `session-pins.json`, `reactions.jsonl`,
`jobs.jsonl`, `librarian-jobs.jsonl`, `librarian-shots`, `sources.json`,
`sources-inbox.json`, `declencheurs-journal.jsonl`, `preautorisations.json`,
`envois-programmes.json`, `avatar`, `chat-mirror.json`, `chat-mirror`.

⚠️ La consigne annonçait « 18 chemins » : `src/config/env.ts` en porte en réalité
**22** (voir les défauts `:417-565`), auxquels s'ajoutent **4 chemins DÉRIVÉS**
(`CHEMINS_DERIVES` `:147` : `personality-history`, `personality-journal.jsonl`,
`rules-history`, `rules-journal.jsonl` — posés par
`src/state/text-document-store.ts:192-194`) et les **sessions Pi**. Les dérivés
doivent être déplacés, sinon historique et journal restent orphelins.

**Sessions Pi** : `piSessionsDir` vit sur le volume `pi`
(`src/config/env.ts:568-572`, `/data/pi` : `src/config/container-paths.ts:23`) →
`<pi>/agent/sessions/<botId>`. **Deux volumes ⇒ les `rename` ne sont pas
atomiques entre eux.**

**Globaux, jamais déplacés** : `configStorePath`, coffre de secrets, mot de passe
d'instance, `filesDir`, journal d'audit, agents, transferts, ComfyUI, push —
ils n'appartiennent à aucun bot.

**Surcharges de déploiement** : une variable (`YUKI_MEMORY_STORE_PATH`…) qui
pointe **hors de son volume** est **SAUTÉE** et **signalée au démarrage**
(`bots.avertissement`). Aucun déplacement sauvage.

## 3. Migration

`src/bots/migrate.ts` — `migrerVersMultiBot` (`:292`), journal
`state/migration-multibot.json` réécrit **après CHAQUE `rename` réussi**.

Ordre : ① journal `en_cours` → ② `mkdir state/bots/yuki/` → ③ les chemins du
volume `state` → ④ **sessions Pi** (dossier de transit
`sessions.en-migration`, deux `rename` sur le **même** volume `pi`) → ⑤
**`bots.json`** (la bascule) → ⑥ journal `termine`.

- **Reprise** : seules les entrées `a_faire` sont rejouées (fusion
  journal/plan, `fusionnerJournal`). Aucune entrée n'est perdue, SAUF celles
  qu'une surcharge de déploiement apparue entre-temps interdit — abandonnées et
  journalisées (`bots.migration.entree_ignoree`).
- **Idempotence** : un chemin déjà déplacé est marqué `faite` sans rien rejouer.
- ⚠️ **Si les sessions échouent, `bots.json` n'est PAS écrit** : sinon l'UI
  chercherait les conversations sous `sessions/yuki` alors qu'elles sont encore à
  la racine — Yuki **perdrait son historique**.
- **Conflit** (origine et cible présentes) : erreur explicite, aucun écrasement.
- Le **plan** exclut les surcharges hors volume : elles ne sont ni déplacées ni
  surveillées (elles restent au choix du déploiement).

## 4. Démarrage

`src/bots/index.ts` — `preparerMultiBot(env)` (`:104`), appelé par
`src/index.ts:269`.

- `bots.json` **absent** ⇒ migration puis résolution par bot. Si le **journal ne
  peut pas être écrit** (volume absent/`ro`), **rien n'a été déplacé** ⇒ **mode
  mono-bot historique** (`migrationAutomatique: false` force ce mode).
- `bots.json` **présent** ⇒ résolution par bot ; bot actif `yuki` (repli : premier
  bot `actif` par `ordre`).
- **Refus de démarrer** (`DemarrageRefuseError`, `:73`) : `MIGRATION_PARTIELLE`
  (`bots.json` + un chemin d'origine encore présent — `cheminsOrigineEncorePresents`
  `migrate.ts:207`, liste exacte des chemins), `MIGRATION_ECHOUEE`,
  `REGISTRE_INVALIDE`, `AUCUN_BOT_ACTIF`. Jamais de fonctionnement à moitié
  migré. Le contrôle des sessions tolère le dossier `sessions` (il contient
  `<botId>`) et ne regarde que ce qui y reste.
- ⚠️ **Pas de `MAX_BOTS`** (lot 1b, écran d'ajout).

## 5. Vérification

`tests/bots/migration.test.ts` (10 cas) : migration complète (**octet pour
octet**, sessions comprises), idempotence, **coupure au milieu ⇒ reprise**,
échec des sessions ⇒ `bots.json` non écrit, `MIGRATION_PARTIELLE`, mémoire écrite
avant lue après, surcharge hors volume sautée + avertie, mode mono-bot intact,
et **surcharge apparue pendant une migration interrompue ⇒ entrée abandonnée
sans déplacement sauvage**.

⚠️ **Preuve d'échec sur l'origine** : `git show HEAD:` ne suffit pas (l'arbre est
un empilement de lots) ⇒ **copie `/tmp` + neutralisation** : `src/bots` retiré ⇒
`Cannot find module '../../src/bots/index.js'` (0 test) ; puis
`migrerVersMultiBot` neutralisé (retour `sans_volume`) ⇒ **8 cas sur 10 échouent**.

Démarrage RÉEL vérifié (`tsx src/index.ts`, `state`/`pi` en `/tmp`) : ① première
exécution ⇒ `bots.migration.*` puis `bots.actif` (`migration:"effectuee"`), la
mémoire est sous `state/bots/yuki/` ; ② seconde ⇒ `migration:"aucune"` ; ③ un
`state/memory.jsonl` résiduel ⇒ `erreur fatale : DemarrageRefuseError:
MIGRATION_PARTIELLE` avec le chemin listé, sortie code 1.

**Invérifiable ici** : comportement sur un vrai déploiement à deux volumes
(bind mounts, SELinux, uid/gid), et le fait qu'aucun client externe ne garde une
référence à un chemin `/data/state/<fichier>` en dur.
