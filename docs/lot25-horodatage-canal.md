# Lot 25 — le fil de canal est HORODATÉ

Défaut signalé par l'utilisateur (2026-11-02 15:12, verbatim) : « **elle m'a dit qu'elle
avait pas les timestamp des messages** ».

## Le trou mesuré

Le fil injecté dans le prompt de canal était construit ligne par ligne en `auteur :
texte` — **aucune heure, aucune date** (`src/chat/reply/prompt.ts:187` avant ce lot).
Conséquence observable : Yuki ne pouvait pas savoir **quel message était récent** ; elle
a cité une fiche produite le matin comme « la dernière », sans voir celle arrivée trois
minutes plus tard — non par amnésie, mais parce que **l'ordre temporel lui était
invisible**.

## Livré

| Élément | Où |
|---|---|
| Chaque ligne du fil porte `[JJ/MM HH:mm]`, **date ET heure** (compact : la fenêtre de 6 000 caractères est serrée) | `src/chat/reply/prompt.ts:149` (`formatLineTimestamp`), utilisée `:252` |
| Même horloge et même fuseau que les prompts locaux : `formatCompactDateTime` réutilisé (`Intl`, fuseau IANA) | `src/pi/timestamp.ts:81` ← `src/chat/reply/prompt.ts:153` |
| **Heure courante** dans le prompt, au format du projet | `src/chat/reply/prompt.ts:236` (`buildTimestampPrefix`, `src/pi/timestamp.ts:92`) |
| **Mention « historique partiel »** quand la fenêtre coupe, **absente** sinon | `CHAT_PARTIAL_HISTORY_NOTICE`, `src/chat/reply/prompt.ts:119` ; posée `:269` |
| L'horodatage **entre dans le décompte** — et le retour à la ligne aussi | `src/chat/reply/prompt.ts:253-262` |
| Ordre de troncature **inchangé** : plus récent d'abord, on jette les plus anciens | `src/chat/reply/prompt.ts:244-266` |

## Prémisse corrigée (vérifiée, pas supposée)

La demande supposait qu'en canal Yuki n'a « aucun accès aux images de la conversation »
(ni `lister_fichiers` ni `lire_fichier`). C'est vrai du **rôle léger en local**
(`fileList: []` / `fileRead: []`, `src/llm/tool-policy.ts:381`/`:386`), **faux en canal** :
`toolAllowlistForChat` réajoute `REMOTE_SAFE_TOOLS` (`src/llm/tool-policy.ts:645-648`,
appliqué `:884-887`) et le port fichiers est fourni (`files: filesService`,
`src/index.ts:1509`). Vérifié à l'exécution : `toolAllowlistForChat("light", {},
{ chatMode: "mattermost", remoteAgents: false })` rend `['lister_fichiers',
'lire_fichier']`. Le vrai piège est donc **double** et il est écrit tel quel dans la doc
du chat (`docs/lot18-chat.md` §14) :
- les images des AUTRES messages ne sont **pas** dans le prompt (le fil ne transporte que
  le TEXTE) : il faut les demander par outil, et le modèle doit avoir la vision ;
- les pièces jointes du message COURANT, elles, arrivent par le prompt (images vues,
  le reste **annoncé**).

## Décisions

- **Format de ligne : date toujours, même pour aujourd'hui.** `[02/11 11:46]` et non
  `[11:46]` : après une nuit de messages, une heure seule ne dit pas de quel jour il
  s'agit, et une ligne datée se compare d'un coup d'œil au repère « heure courante ».
  Coût : ~15 caractères par ligne. Un `[auteur] : texte` de 60 caractères en consomme 25 %
  de plus — c'est le prix de la lisibilité temporelle, et il est **compté**.
- **L'heure courante est en TÊTE DE FIL, pas dans le prompt système.**
  `CHAT_REPLY_SYSTEM_PROMPT` (`src/chat/reply/prompt.ts:49`) est une **constante du
  contrat de comportement** : elle ne peut pas changer d'un run à l'autre. Le repère n'a
  de sens qu'**à côté** des horodatages qu'il permet d'interpréter (« ce matin », « tout à
  l'heure »).
- **Le fil est rendu au message courant inchangé** : le message déclencheur est toujours
  présenté à part, à la fin, et il n'est pas recopié dans le fil.

## Ce qui ne change pas

- **Ordre de troncature** : plus récent d'abord (couper la fin retirerait le contexte du
  message auquel il faut répondre).
- **Aucun appel modèle supplémentaire** : tout tient dans le prompt existant.
- **Backfill D1 (`historique: true`) : ZÉRO run** — chemin inchangé, aucun prompt construit.
- Ack, images, jobs, délégation, outils longs, mode local, Mattermost, Discord : aucun
  autre fichier de production n'est touché (`src/chat/reply/prompt.ts` + un export dans
  `src/chat/index.ts`).

## Où c'est prouvé

`tests/chat/reply-horodatage.test.ts`, 15 tests : horodatage par ligne avec deux heures
connues, fuseau honoré, ordre lisible, instant illisible ⇒ `[horodatage inconnu]` (jamais
une heure inventée), fil ≤ `maxChars` **horodatages et retours à la ligne compris** pour
six budgets, troncature côté ancien, mention « partiel » présente / absente / fil vide.
Non-régression : `tests/chat/reply-modes.test.ts` (le message déclencheur reste hors du
fil, les plus récents restent) et les **33 fichiers** de `tests/chat`.

### Échec sur l'origine (HEAD)

Arbre HEAD reconstitué dans `/tmp/preuve-lot25` (`git show HEAD:src/chat/reply/prompt.ts`
et `git show HEAD:src/chat/index.ts`), `node_modules` lié, test neuf recopié ⇒
**12 échecs / 3 passants**.

Les 3 passants sont exactement les non-régressions (troncature côté ancien, mention
absente quand tout tient, fil vide) : l'origine les satisfait trivialement. Deux échecs
sont des assertions de contenu, un échec est **mesuré** et instructif : à HEAD, le bloc
réel du fil dépasse la borne de **1 caractère** (601 pour `maxChars=600`) — la borne
comptait les lignes sans leurs séparateurs, donc la fenêtre débordait en silence. Les
autres échecs portent sur la constante neuve (`CHAT_PARTIAL_HISTORY_NOTICE` vaut
`undefined` à HEAD) et sur les horodatages absents.

## Invérifiable ici

- ~~**Le fuseau réel en production.**~~ **CORRIGÉ le 2026-11-04** (« tous les
  horodatages en UTC ») : le fil n'est plus formaté dans le fuseau du process mais dans
  le fuseau du réglage `/config` **`ui.timeZone`** (défaut **UTC**, le fuseau de
  Mattermost), passé **explicitement** à `Intl` (`src/pi/timestamp.ts`). La
  planification, elle, garde le fuseau de **chaque déclencheur** (`src/sources/cron.ts`),
  et un envoi programmé celui de l'envoi (`src/chat/envois/quand.ts`). Voir
  [`runbook.md`](runbook.md) §2.2.
- **Le comportement du modèle devant des heures** : aucun test ne dit qu'il en tirera
  « ce matin » ou « il y a trois minutes ». On prouve que l'information est **présente et
  lisible**, pas qu'elle est exploitée.
