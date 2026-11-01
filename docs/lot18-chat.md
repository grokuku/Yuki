# Lot 18 — Modes de discussion : parler depuis Mattermost (et Discord plus tard)

> Objectif : Yuki lit et répond **dans un canal externe**, avec le **même** socle
> que la conversation locale. Ce lot (lot 1) pose le **socle**, le **sélecteur de
> mode** et le **modèle de données**. ⚠️ **Aucun client Mattermost, aucune
> synchronisation** : c'est le lot 2.

## 1. Les trois modes

| Mode | Ce qu'il fait | Ce qui vient du serveur |
| --- | --- | --- |
| **Local** (défaut, `chat.mode = local`) | conversations de Yuki, comportement **inchangé** | liste des sessions Pi |
| **Mattermost** | canaux synchronisés en **lecture seule côté interface web** | liste vide tant que le lot 2 n'est pas livré |
| **Discord** | **stub honnête** : « Discord n'est pas encore configuré. » | aucune conversation, création désactivée |

## 2. Répondre : trois modes PAR CANAL

| `ChatReplyMode` | Sens |
| --- | --- |
| `tout` | elle répond à **tous** les messages du canal |
| `auto` | elle répond quand le message lui est **adressé** — c'est le **LLM qui juge** |
| `mention` | elle ne répond que si elle est **citée** |

Le choix se fait par **clic droit sur le canal** dans la barre latérale (le mode
est stocké par canal dans un JSON du volume `state` — le schéma de `/config`
n'accepte ni liste ni objet, `src/config/schema.ts:14`).

## 3. Fils dépliables et backfill

- **Un canal = une conversation** ; chaque message porte son **parent**
  (`threadRootId`, obligatoire dès le modèle : `src/chat/types.ts`). Les fils
  s'affichent et se déplient comme dans Mattermost. Ajouter ce champ après coup
  aurait imposé de **re-synchroniser tout le miroir**.
- **Backfill : deux semaines** d'historique par canal (suffisant, choix
  utilisateur). Curseur **opaque** fourni par l'adaptateur, idempotence
  `(platform, conversationId, remoteMessageId)`.

## 4. Ce qui est LIVRÉ (lot 1) et ce qui reste (lot 2/3)

| Livré au lot 1 | Lot 2 / lot 3 |
| --- | --- |
| `src/chat/types.ts` (`ChatAdapter`, `RemoteConversation`, `RemoteMessage`, `ChatReplyMode`, origine de run, messages sortants typés) | client Mattermost, authentification, transport |
| registre `getAdapter` / `listPlatforms`, adaptateur **local**, **stub** Discord | adaptateur Mattermost, miroir `chat-mirror.json` + `chat-mirror/<id>.jsonl` |
| `chat.mode` (`apply: hot`), `chat.remoteAgents`, `chat.remoteMemory` (défaut `desactive`) | synchronisation, backfill 2 semaines, curseurs |
| `GET /api/chat/status` (lecture **gardée** : `X-Yuki-Config: 1`) | onglet « Configuration → Discussions » |
| sélecteur segmenté + badge ●/◐/○, création désactivée **avec la raison** | relais des approbations (lot 3), outils par mode en exécution |
| trame `sessions` : `kind`, `platform`, `readOnly`, `canRun` ; sélection d'un miroir ; refus `conversation_lecture_seule` ; refus `creation_desactivee` | réponses, images générées envoyées dans le canal |

⚠️ **`readOnly` et `canRun` ne disent pas la même chose** : `readOnly` = « on ne
crée rien et on n'écrit pas **depuis l'interface web** » ; `canRun` = « la
conversation **répond** donc produit des runs » (et pourra demander des
approbations). Un nom qui confondrait les deux mentirait au lot 2.

## 5. Agents et mémoire en mode distant — désactivés par défaut

| Réglage | Défaut | Sens |
| --- | --- | --- |
| `chat.remoteAgents` | `desactive` | pas de délégation, pas de transfert, pas de commande, pas de secret |
| `chat.remoteMemory` | `desactive` | la mémoire durable des conversations distantes n'est pas branchée (**réversible**) |

La politique d'outils correspondante existe déjà
(`toolAllowlistForChat`, `src/llm/tool-policy.ts`) : un run distant, agents
désactivés, garde **seulement** `generer_image`, `consulter_workflow`,
`lister_fichiers` et `lire_fichier` — c'est-à-dire **générer et analyser des
images**. Elle sera **branchée** quand des runs distants existeront (lot 2/3) :
aujourd'hui le seul run est local, et lui appliquer la restriction casserait
l'usage courant.

## 6. Le bricolage Mattermost

Le « bricolage » (agent qui lit un canal) vit dans une **VM « playground »**,
**hors du dépôt** : rien à retirer ici. C'est l'utilisateur qui la supprime.

## 7. Où c'est prouvé

| Sujet | Fichier |
| --- | --- |
| registre, stub Discord, inconnu propre | `tests/chat/adapters.test.ts` |
| identifiants `mm-…`/`dc-…`, auteur + parent conservés | `tests/chat/mirror.test.ts` |
| mode lu à chaud, refus de création, capacités distantes | `tests/chat/service.test.ts` |
| `chat.mode` / `chat.remoteAgents` / `chat.remoteMemory` | `tests/config/schema-chat.test.ts` |
| politique d'outils par mode | `tests/llm/tool-policy-chat.test.ts` |
| route gardée, mode câblé, aucun secret | `tests/gateway/chat-api.test.ts` |
| trame `sessions`, sélection de miroir, refus d'écriture | `tests/gateway/ws/chat-remote.test.ts` |
| sélecteur, badge, **trois** chemins de clic | `tests/ui/chat-mode.test.ts` |

## 8. Ce que ce lot ne prouve pas

- **Aucune** conversation réelle n'est lue : le miroir est vide par
  construction (`emptyChatMirror`, `src/chat/mirror.ts`), donc « les canaux
  s'affichent » n'est pas démontré — seule la **mécanique** l'est.
- Le **relais d'approbations** et l'envoi vers une plateforme ne sont pas
  implémentés (`send?` absent des adaptateurs livrés) : seuls les **types** sont
  réservés.
- Rien n'a été vérifié contre un vrai serveur Mattermost (aucun client n'existe
  encore).
