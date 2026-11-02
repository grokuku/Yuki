# Lot 18 — Modes de discussion : parler depuis Mattermost

> Objectif : Yuki lit et répond **dans un canal externe**, avec le **même** socle
> que la conversation locale.
>
> **Lot 1** (livré) : socle (types, registre, miroir vide), sélecteur de mode,
> modèle de données. **Lot 2** (ce document) : **vrai client Mattermost** — REST,
> WebSocket, miroir persistant, backfill 2 semaines, fils dépliables, trois modes
> de réponse, panneau `/config → Conversation → « Discussions — Mattermost »`.

## 1. Les trois modes

| Mode | Ce qu'il fait | Ce qui vient du serveur |
| --- | --- | --- |
| **Local** (défaut, `chat.mode = local`) | conversations de Yuki, comportement **inchangé** | liste des sessions Pi |
| **Mattermost** | canaux **synchronisés** (lecture seule côté interface web) | liste des canaux suivis + leur fil |
| **Discord** | **LIVRÉ au lot 21** (`docs/lot21-chat-discord.md`) : mêmes règles, client REST + passerelle | liste des salons suivis + leur fil |

⚠️ **`chat.mode` ne filtre QUE la vue.** La synchronisation démarre dès que la
plateforme est **configurée** (URL + jeton), même si l'utilisateur regarde le mode
local : sinon les messages reçus pendant ce temps seraient perdus
(`src/index.ts`, démarrage de `mattermost.connect()`).

## 2. Le client Mattermost — ce qui a été VÉRIFIÉ

| Point | Source vérifiée |
| --- | --- |
| Base `/api/v4`, `me` = utilisateur courant, `per_page` **max 200 tronqué EN SILENCE**, défaut 60 | `api/v4/source/introduction.yaml` (section *Schema & Conventions*) |
| **Trame d'authentification WebSocket** : après ouverture, premier message `{"seq":1,"action":"authentication_challenge","data":{"token":…}}` ; succès = `{"status":"OK","seq_reply":1}` puis événement `hello` | même fichier, section *WebSocket → Authentication* |
| Événements de post : `posted`, `post_edited`, `post_deleted` (parmi ~50 événements) | même fichier, section *WebSocket Events* |
| `GET /channels/{id}/posts` : `since` **non combinable** avec `page`/`per_page`, limité à **1000** posts, **continuité non garantie** | `api/v4/source/posts.yaml` + page archivée `mattermost-get-posts-for-channel` |
| `data.post` d'un événement est une **CHAÎNE JSON** (double encodage) | `server/channels/app/post.go:852` — `message.Add("post", postJSON)` |
| `POST /posts` avec `channel_id`, `message`, `root_id` | `api/v4/source/posts.yaml` |
| `POST /users/ids` (liste d'identifiants → utilisateurs) | `api/v4/source/users.yaml:682` |

⚠️ **Ce qui reste INVERIFIABLE ici** : aucun serveur Mattermost n'est accessible
depuis cet environnement. Les tests utilisent des **serveurs fixtures réels**
(HTTP et WebSocket) qui rejouent le contrat ci-dessus, pas une instance
Mattermost. Les commandes de vérification contre un vrai serveur sont en §10.

## 3. Lecture REST — pas de troncature muette

`src/chat/mattermost/client.ts`

- `per_page` n'est **jamais** demandé au-delà de 200 (`MM_MAX_PER_PAGE`) : au-delà,
  le serveur tronque **sans erreur**.
- Pagination : `channelPostsAll` s'arrête sur `has_next === false`, sur une page
  vide, ou sur la borne demandée — et dans ce dernier cas rend `hasNext: true`.
  ⚠️ **Quand `has_next` est absent**, une page plus courte que demandé n'est PAS
  la preuve de la fin (c'est exactement le piège du plafond à 60) : le client
  règle son pas sur ce que le serveur a bien voulu rendre et interroge la page
  suivante. Le test `mattermost-client.test.ts` le prouve avec un serveur qui
  plafonne à 60 et 250 messages à servir.
- `since` : un seul appel (l'API l'interdit avec `page`/`per_page`) ; si le
  serveur rend **1000** posts, la borne est **annoncée** (`hasNext: true`).
- **Débit** : une requête toutes les `MM_MIN_REQUEST_INTERVAL_MS` (250 ms). Un
  `429` est absorbé par un backoff borné (`Retry-After` s'il existe, sinon
  exponentiel, 4 tentatives) et allume le statut **« ralenti »**, visible dans
  l'interface (il retombe tout seul au bout de 60 s).
- **Jeton** : uniquement dans l'en-tête `Authorization` de la requête montante.
  Jamais dans une URL, jamais dans un message d'erreur (une erreur cite le
  **chemin** — `GET /users/me` — jamais l'hôte), jamais dans une réponse HTTP.

## 4. Temps réel — WebSocket

`src/chat/mattermost/ws.ts`

- Connexion à `/api/v4/websocket`, **authentification en premier message**
  (trame vérifiée ci-dessus). Le jeton ne circule que là : il ne part **jamais**
  vers un navigateur (la CSP `default-src 'none'` interdit de toute façon tout
  appel du navigateur vers Mattermost).
- Événements retenus : `posted`, `post_edited`, `post_deleted`. Tout le reste
  (`channel_viewed`, `typing`, `status_change`…) est ignoré : ce ne sont pas des
  messages.
- **Reconnexion** : backoff exponentiel **borné** 1 s → 60 s + gigue, compteur de
  tentatives **visible** dans `status()`. Au-delà de `maxAttempts` (20), le temps
  réel **s'arrête et le dit** : jamais de reconnexion silencieuse à l'infini.
- Un **jeton refusé** (`status: "FAIL"`) arrête net : aucune boucle de
  reconnexion sur une erreur qui ne se répare pas.
- **Filet de sécurité** : rattrapage REST toutes les **60 s** depuis le curseur
  persisté, plus une passe au démarrage. Le temps réel peut tomber, les messages
  ne sont pas perdus.

## 5. Miroir et ingestion

`src/chat/mirror/store.ts` + `src/chat/mirror/ingest.ts`

| Fichier | Rôle |
| --- | --- |
| `<état>/chat-mirror.json` | index : URL, identité du bot, une entrée par canal (plateforme, id distant, titre, curseur, compteur, backfill, mode de réponse) |
| `<état>/chat-mirror/<conversationId>.jsonl` | messages, **append-only** |

- Écriture **atomique** (`tmp` + `rename`) pour l'index, **0600** ; JSONL complété
  en ajout, **0600**. Chemins par `src/config/env.ts` (`chatMirrorPath`,
  `chatMirrorDir`).
- **Idempotence stricte** : clé `(platform, conversationId, remoteMessageId)`,
  index en mémoire construit au **chargement**, retour **avant** toute écriture.
  **Aucune heuristique de hachage de texte** : deux « ok » restent deux messages.
- **Édité** ⇒ mise à jour **sur place** : une ligne de plus portant le **même**
  identifiant ; au chargement la dernière gagne ⇒ **une seule bulle**, et le
  fichier ne perd jamais rien.
- **Supprimé** ⇒ l'entrée **reste**, avec la mention « (supprimé sur
  Mattermost) » et le **texte d'origine conservé** s'il était connu. Aucune
  disparition silencieuse.
- **Auteur → rôle** : `botUserId` ⇒ `assistant`, tout le reste ⇒ `user`.
- **Bornes explicites** : 50 canaux suivis, 20 000 messages/canal, 16 Kio/message
  (corps tronqué **avec mention**, jamais coupé en silence). Un dépassement est
  **refusé et journalisé**, et le canal est marqué pour que l'interface le dise.

## 6. Backfill — deux semaines, borné deux fois

`src/chat/sync/service.ts`

- `since = maintenant − 14 jours` (`BACKFILL_DAYS`), **ET** borne dure de
  **1 000 messages par canal** (`BACKFILL_MAX_MESSAGES`).
- Si la borne est atteinte (par les nôtres ou par celle de l'API), le canal est
  marqué `historiqueAnterieur` et l'interface affiche « **historique antérieur non
  importé** ». Le panneau `/config` porte le même bandeau.
- Un canal **déjà backfillé** n'est pas relu (aucun doublon au redémarrage).
- Un canal en échec n'empêche pas les autres et **n'est pas marqué fait** : son
  échec est visible dans le statut.
- **Un canal membre = une conversation**, titre = nom du canal. Les conversations
  **directes** (`type: "D"`) et de **groupe** (`G`) ne sont pas des canaux : elles
  ne sont pas miroitées.

## 7. Répondre — trois modes PAR CANAL

`src/chat/reply/responder.ts` + `src/chat/reply/prompt.ts`

| Mode | Règle |
| --- | --- |
| `tout` | répond à **chaque message humain** |
| `mention` | répond **seulement** si Yuki est **citée** : `@<pseudo du bot>`, `@<nom affiché>` ou l'identifiant du bot. Détection **explicite** (frontière de mot) : `@yukiko`, `contact@yuki.fr` ou le pseudo **nu** ne déclenchent rien |
| `auto` | un **appel modèle léger** juge (« ce message s'adresse-t-il à Yuki ? »). Le juge est **borné** : jamais sur un message du bot, **jamais deux fois** le même identifiant de message, et **jamais** si le canal n'est pas `auto` |

- **Anti-boucle** (prime sur les trois modes) : un message dont l'auteur est
  `botUserId` — ou déjà classé `assistant` — **ne déclenche aucune réponse**.
  Contrôlé **deux fois** (adaptateur + `decideReply`) : c'est le seul défaut
  capable de saturer un canal sans intervention humaine.
- **Réponse publiée** via `POST /api/v4/posts` **avec `root_id`** : dans le fil du
  message s'il en a un, sous le message sinon (le mode `tout` ne noie pas le
  canal).
- **Réglage par canal** persisté dans `chat-mirror.json` (`replyMode`). Défaut :
  `mention` (`DEFAULT_REPLY_MODE`), le plus prudent qui laisse le canal utilisable.
- **Échec d'envoi ⇒ visible** : journal + raison remontée par `status()`, et le
  panneau `/config` l'affiche. Jamais un échec silencieux.
- Le **relais d'approbations** (lot 3) n'est **PAS** branché : `send()` refuse
  explicitement un `ChatOutboundMessage` d'approbation.

## 8. Interface

- **`/config` → onglet Conversation → « Discussions — Mattermost »**
  (`public/ui/chat-panel.js`) : URL du serveur, jeton **saisi une fois** (champ
  vidé aussitôt, jamais réaffiché), bouton « Se connecter », état de connexion
  (badge ● / ◐ / ○ + raison), avancement du backfill, canaux suivis, bandeau
  « historique antérieur non importé ». Rendu **DOM pur** (`createElement`), aucun
  `innerHTML`, aucun style en ligne.
  ⚠️ **Pas de nouvel onglet** : les 9 onglets de `/config` sont verrouillés par un
  test ; la section vit dans l'onglet **Conversation**, comme « Libraire » vit
  dans « Système ».
- **Fils dépliables** (`public/ui/app.js`) : sous un message racine, un bouton
  « **N réponses** » (replié **par défaut**, `aria-expanded`), qui déplie les
  réponses. La racine est reconnue par `threadRootId` ; une réponse dont la racine
  n'est pas dans le fil affiché est rendue normalement. L'**auteur** de chaque
  message est affiché (information essentielle d'un canal d'équipe).
- **Clic droit sur un canal ⇒ mode de réponse** : le menu contextuel existant
  gagne un groupe « Réponses de Yuki dans ce canal » (`tout` / `auto` /
  `mention`), **masqué** sur une conversation locale. L'enregistrement passe par
  `PATCH /api/chat/conversations/<id>` et un échec est **dit** dans une modale.
- **Composer désactivé** sur un miroir : c'est `readOnly: true` (trame `sessions`)
  qui le porte, **pas** `canRun` — un canal miroir a `canRun: true` (il répond,
  donc il produit des runs) et reste malgré tout non composable depuis le
  navigateur.

## 9. Secret

- Le jeton vit dans le **coffre** sous **`YUKI_CHAT_MATTERMOST`**. Le préfixe
  `YUKI_CHAT_` est ajouté à `SECRET_NAME_PATTERN`
  (`src/secrets/references.ts`) — **troisième** préfixe réservé, après
  `YUKI_SECRET_` et `YUKI_SOURCE_`.
- ⚠️ **Non référençable dans une commande** : `isSecretReferenceName()` exige
  `YUKI_SECRET_`, donc `${YUKI_CHAT_MATTERMOST}` n'est jamais résolu par le shell
  d'un agent.
- **Saisi via l'interface uniquement**, affiché **une seule fois**, **jamais
  journalisé** (le logger masque aussi les valeurs du coffre), **jamais dans une
  trame** vers le navigateur.

## 10. Procédure de configuration (à exécuter sur un VRAI serveur)

1. Mattermost → **Intégrations → Bots → Ajouter un bot** (ou *System Console →
   Integrations → Bot Accounts* s'il faut d'abord autoriser les comptes bots) :
   nom `yuki`, rôle `System User` ou `Member`.
2. Copier le **jeton** affiché **une seule fois** par Mattermost.
3. **Inviter le bot dans les canaux** à suivre (`/invite @yuki`). Un canal où le
   bot n'est pas membre n'est pas lu.
4. Yuki → `/config` → **Conversation** → « Discussions — Mattermost » : saisir
   l'**URL** du serveur (`https://mattermost.exemple.fr`), **Enregistrer le
   jeton**, puis **Se connecter**.
5. Vérifier que le badge passe à **●** et que le backfill affiche une date.

Vérifications en ligne de commande (à lancer par l'utilisateur, avec le jeton
dans une variable d'environnement — jamais en argument) :

```bash
export MM=https://mattermost.exemple.fr
read -rs MM_TOKEN            # saisie masquée, jamais dans l'historique
curl -s -H "Authorization: Bearer $MM_TOKEN" "$MM/api/v4/users/me" | head -c 200
curl -s -H "Authorization: Bearer $MM_TOKEN" "$MM/api/v4/users/me/teams" | head -c 200
# Borne de 1 000 posts sur `since` (réponse tronquée ⇒ « historique antérieur ») :
curl -s -G -H "Authorization: Bearer $MM_TOKEN" \
  --data-urlencode "since=1700000000000" \
  "$MM/api/v4/channels/<channelId>/posts" | head -c 200
```

Côté Yuki, ce qui est **observable sans serveur** : `GET /api/chat/status`
(en-tête `X-Yuki-Config: 1`) rend l'état, le backfill et les canaux suivis — et
la ligne d'erreur dit précisément ce qui manque (URL, jeton, ou refus du serveur).

## 11. Limites assumées

| Limite | Pourquoi |
| --- | --- |
| **Aucun relais d'approbations** dans un canal | lot suivant : `ChatApprovalRequest` / `ChatApprovalDecision` existent, rien n'est branché |
| **Aucune mémoire durable** des conversations distantes | pas branchée, donc **aucun réglage** : `chat.remoteMemory` a été retiré (il n'était lu que pour l'affichage) |
| Backfill **borné** à 2 semaines / 1 000 messages | choix utilisateur ; le reste vit sur Mattermost, et l'interface le dit |
| `since` **non paginable** (API) | si un canal a plus de 1 000 messages modifiés dans la fenêtre, le surplus n'est pas récupéré et le bandeau s'affiche |
| Aucune vérification contre un **vrai** serveur Mattermost | pas d'instance accessible ici ; les tests rejouent le contrat de l'API sur des serveurs fixtures |
| Pas de rendu Markdown des messages entrants | ils sont affichés tels quels (le Markdown sortant n'est pas produit non plus) |

## 12. Où c'est prouvé

| Sujet | Fichier |
| --- | --- |
| registre, plateformes enregistrées par fournisseur, inconnu propre | `tests/chat/adapters.test.ts` |
| identifiants `mm-…`/`dc-…`, auteur + parent conservés | `tests/chat/mirror.test.ts` |
| mode lu à chaud, refus de création, capacités distantes | `tests/chat/service.test.ts` |
| **client REST** : `me`, canaux, **pagination sans perte sur serveur qui tronque**, `since`, `429`, jeton jamais dans une erreur | `tests/chat/mattermost-client.test.ts` |
| **WebSocket** : trame d'auth exacte, `posted` ingéré, **reconnexion**, jeton refusé, réponse avec `root_id`, **anti-boucle** | `tests/chat/mattermost-ws.test.ts` |
| **miroir** : idempotence, édition sur place, suppression conservée, append-only 0600, bornes 16 Kio / 20 000 / 50 canaux | `tests/chat/mirror-ingest.test.ts` |
| **backfill** : `since` = −14 j, borne 1 000 + bandeau, reprise au curseur sans doublon | `tests/chat/sync-backfill.test.ts` |
| **trois modes** : `tout`, `mention` (cas pièges), `auto` (un seul jugement) | `tests/chat/reply-modes.test.ts` |
| **routes** : URL validée, jeton jamais relu, refus explicites, mode par canal | `tests/chat/chat-api.test.ts` |
| `YUKI_CHAT_` accepté au coffre, **non** référençable en commande | `tests/secrets/references.test.ts` |
| `chat.mode` / `chat.remoteAgents` | `tests/config/schema-chat.test.ts` |
| politique d'outils par mode | `tests/llm/tool-policy-chat.test.ts` |
| trame `sessions`, sélection de miroir, refus d'écriture | `tests/gateway/ws/chat-remote.test.ts` |

## 13. Ce que ce lot ne prouve pas

- Aucun échange avec un **vrai** Mattermost (cf. §10 pour les commandes à lancer).
- Le **rendu visuel** des fils dépliables n'est vérifié par aucun test de
  navigateur : seule la structure DOM est construite par `app.js` (pas de test
  unitaire sur `public/ui/app.js`, qui n'est pas instrumenté).
- Le **juge `auto`** est prouvé par des doubles (contrat et bornes), pas par un
  vrai modèle : le chemin SDK est le même que le récapitulatif
  (`createSdkPromptWriter`), déjà éprouvé.

## 14. Ce que Yuki voit d'un canal — le vrai modèle mental

Court, et à lire avant de lui demander quelque chose dans un canal (lot 25).

| Elle a… | Où c'est vrai | Conséquence pratique |
| --- | --- | --- |
| **Aucune mémoire durable** | chaque réponse est une session éphémère (`src/pi/sdk/prompt-writer.ts:157`) ; `chat.remoteMemory` n'existe plus (§11) | elle ne « se souvient » pas de la conversation précédente : ce qui n'est pas dans la fenêtre ci-dessous est **perdu** |
| une **fenêtre horodatée** des derniers messages | `CHAT_REPLY_TRANSCRIPT_MAX_CHARS` = 6 000 (`src/chat/reply/prompt.ts:108`), lignes `[JJ/MM HH:mm]` (`:252`), **plus récent d'abord** (`:244-266`) | elle sait ce qui est récent ; quand la fenêtre coupe, le prompt le **dit** (`CHAT_PARTIAL_HISTORY_NOTICE`, `:119`) |
| l'**heure courante** | `src/chat/reply/prompt.ts:236` | elle peut dire « ce matin », « il y a dix minutes » |
| les **pièces jointes du message courant** | images vues par le modèle (`src/chat/mattermost/adapter.ts:804`), le reste **annoncé** et non transmis (`notes`, `src/chat/reply/prompt.ts:272-277`) | un fichier joint à *son* message est connu ; les autres ne le sont pas d'office |

⚠️ **Piège pour l'utilisateur — les images des AUTRES messages** : elles ne sont
**pas** dans le prompt. Yuki doit aller les chercher (`lister_fichiers` puis
`lire_fichier`), et ces deux outils **existent bien en canal** : ils sont réajoutés par
`REMOTE_SAFE_TOOLS` (`src/llm/tool-policy.ts:645-648`, appliqué `:884-887`) alors que le
rôle léger ne les porte pas en local (`fileList: []`/`fileRead: []`, `:381`/`:386`), et le
port fichiers est fourni (`files: filesService`, `src/index.ts:1509`). Elle ne peut donc
les voir que si le modèle du run a la **vision** (`receivesImages`,
`src/index.ts:1504`) — et seulement pour un fichier **de ce canal**
(`conversationSource`, `src/index.ts:1470`).
