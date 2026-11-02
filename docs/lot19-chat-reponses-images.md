# Lot 19 — Répondre « comment » depuis Mattermost, et faire passer les images

> Deux demandes de l'utilisateur (2026-11-01) :
> **(A)** au clic droit sur un canal, choisir **comment** répondre (fil / nouveau
> message) et **citer l'auteur** (oui / non), en plus du « quand » déjà livré ;
> **(B)** faire marcher la **génération** et l'**analyse d'image** sur Mattermost.

## 1. Ce que l'utilisateur voit

| Où | Quoi |
| --- | --- |
| Clic droit sur un canal distant | trois groupes : **Quand répondre** (`tout` / `auto` / `mention`), **Comment répondre** (**Réponse dans le fil** / **Nouveau message**), **Citer l'auteur** (oui / non). L'option active est cochée (● + gras + `aria-checked`). |
| Réponse de Yuki dans le canal | si « Citer l'auteur » est actif, la réponse commence par un bloc `> **@auteur** a écrit :` **borné** (3 lignes, 240 caractères) |
| Pièce jointe impossible à envoyer | le texte part quand même, et une ligne discrète dit laquelle n'est pas passée (`_(…)`) — et la raison est aussi dans l'état de la plateforme |

## 2. Réglages — par canal, dans `chat-mirror.json`

`src/chat/types.ts`, `src/chat/mirror/store.ts`

| Clé | Valeurs | Défaut | Sens |
| --- | --- | --- | --- |
| `replyStyle` | `fil` \| `nouveau` | **`fil`** | réponse dans le fil du message, ou nouveau message **à la racine du canal** |
| `quoteAuthor` | `oui` \| `non` | **`non`** | préfixe la réponse par une citation de l'auteur du message |

- ⚠️ **Compatibilité** : un `chat-mirror.json` écrit par la version précédente **n'a pas
  ces clés**. Les défauts sont appliqués **à la lecture** (`effectiveReplyStyle`,
  `effectiveQuoteAuthor`), et le fichier n'est **jamais réécrit** de ce seul fait :
  un miroir existant ne peut pas être cassé par une montée de version.
  Valeur inconnue ⇒ clé **ignorée** (donc défaut), jamais une valeur devinée.
- L'interface reçoit les valeurs **effectives** (trame `sessions` **et**
  `GET /api/chat/status`) : elle n'a aucun défaut à deviner, donc aucun état local qui
  pourrait diverger du serveur.

## 3. Envoi — la RACINE du fil, et une citation sûre

`src/chat/reply/responder.ts`, `src/chat/mattermost/adapter.ts`

| Cas | `root_id` envoyé |
| --- | --- |
| `fil` + message racine | le message lui-même (un fil s'ouvre **sous** lui) |
| `fil` + message de fil | **la racine du fil** (`threadRootId`), jamais le message |
| `nouveau` | **aucun** `root_id`, même si le message d'origine est dans un fil |

⚠️ Le second cas est le piège : répondre à une réponse de fil avec `root_id` = ce
message crée un **fil imbriqué**, que Mattermost n'affiche pas comme une réponse du fil
d'origine.

Citation (`quotePrefixOf`) — Markdown `>` (toujours rendu par Mattermost ; aucune autre
syntaxe de citation n'est documentée côté API) :

- format : `> **@auteur** a écrit :` puis les lignes du message, chacune préfixée par `> ` ;
- **bornée** : `REPLY_QUOTE_MAX_LINES` = 3, `REPLY_QUOTE_MAX_CHARS` = 240, « … » si coupé ;
- **assainie** : caractères Markdown significatifs échappés (`\#`, `\[`, `\*`…), caractères
  de contrôle retirés, et **`@` suivi d'un espace de largeur nulle** — citer `@channel` ne
  doit pas **notifier** le canal (c'est une injection de mention, pas une citation).

## 4. Route — la MÊME, étendue

`src/gateway/routes/chat.ts`

`PATCH /api/chat/conversations/<id>` accepte désormais n'importe quel **sous-ensemble**
de `{ replyMode, replyStyle, quoteAuthor }` (`null` = revenir au défaut). Un champ absent
n'est pas touché. Valeur inconnue, type non textuel, ou corps vide ⇒ **400 explicite**,
et **rien** n'est appliqué. Canal non synchronisé ⇒ **404**. Aucune seconde route.

## 5. Partie B — la VÉRITÉ, d'abord

Trois constats vérifiés **avant** d'écrire du code :

| # | Constat | Preuve |
| --- | --- | --- |
| B1.1 | `send()` ne publiait que du **texte** : `POST /posts` n'avait **jamais** de `file_ids` ⇒ une image produite par Yuki n'arrivait **jamais** sur Mattermost | `src/chat/mattermost/client.ts:createPost` (corps `channel_id`/`message`/`root_id` seulement) ; `src/chat/mattermost/adapter.ts:send` |
| B1.2 | `postToRemoteMessage` **ignorait `post.file_ids`** ⇒ une image postée par un humain n'était jamais téléchargée, donc **jamais** vue par le modèle | `src/chat/mirror/ingest.ts:postToRemoteMessage` (aucune mention de `file_ids` avant ce lot) |
| B1.3 | **Aucun run déclenché depuis Mattermost n'appelait d'outil** : la réponse distante était écrite par un écrivain de prompt à `tools: []` | `src/chat/mattermost/adapter.ts:produceReply` → `generateReply` → `src/pi/sdk/prompt-writer.ts` (`tools: []`) |

⚠️ **B1.3 est CORRIGÉ au lot 20** (`docs/lot20-chat-outils-distants.md`) : le run distant
reçoit désormais la **politique d'outils de son origine** (`toolAllowlistForChat`,
`src/llm/tool-policy.ts`) et les **définitions** correspondantes. Le transport livré ici
(`POST /files` + `file_ids`, §6) est ce qui permet à l'image générée d'arriver dans le
canal : la chaîne complète est prouvée par `tests/chat/mattermost-image-chain.test.ts`.

## 6. Partie B — envoyer un fichier

`src/chat/mattermost/client.ts`, `src/chat/mattermost/adapter.ts`

- `POST /api/v4/files` en `multipart/form-data` (`channel_id` + `files`), **vérifié** dans
  la doc archivée (`mattermost-upload-file`) ; la réponse rend `{ file_infos: [...] }`.
  **Aucun `content-type` manuel** : `fetch` pose la frontière lui-même.
- Puis `POST /api/v4/posts` avec **`file_ids`** (l'ordre est imposé : un `file_id`
  n'appartient à un canal qu'une fois porté par un post).
- **Octets** : uniquement le store de Yuki (`FilesPort.get`/`readBytes`) — **aucune
  lecture disque**, aucun chemin.
- **Borne** : `MM_MAX_UPLOAD_BYTES` = **100 Mo** (défaut `FileSettings.MaxFileSize` de
  Mattermost depuis la 5.33, mattermost/mattermost#16664 → PR #16668). Refus **avant tout
  appel réseau** au-delà ; un `413` d'une instance bridée est **remonté tel quel**.
- **Échec d'upload ≠ échec du run** : décision **tranchée** ⇒ le texte part **et** la
  raison est **écrite dans le message** (`_((« image.png » n'a pas pu être envoyé (…))_`),
  parce que la personne qui a demandé l'image doit savoir qu'elle n'arrive pas. Elle est
  aussi dans `status()` via un champ **séparé** (`derniereAvertissement`) qu'un succès de
  réponse n'efface pas.
- ⚠️ **Jamais de jeton** dans un message d'échec : les erreurs ne citent que le **chemin**
  de la requête (`POST /files`).

## 7. Partie B — recevoir une image

`src/chat/mirror/ingest.ts`, `src/chat/mirror/store.ts`, `src/chat/attachments.ts`
(cache **commun** aux deux plateformes, remonté au lot 21) et, pour ce qui est **propre à
Mattermost** (téléchargement d'un `file_id`, métadonnées `GET /files/<id>/info`),
`src/chat/mattermost/attachments.ts`.

- Le miroir conserve désormais `attachments` (`file_id`), y compris **après
  redémarrage** (validation dans `sanitizeMessage`). Le **nom** n'est pas connu à
  l'ingestion (un post Mattermost ne transporte que des identifiants) : il vaut
  l'identifiant, puis il est renseigné **à la demande** (`GET /files/<id>/info`).
- ⚠️ **Rien n'est téléchargé pendant la synchronisation** : un backfill de 1 000 messages
  déclencherait des milliers de requêtes. Le téléchargement se fait **au moment où
  l'image sert** (le message auquel Yuki répond).
- ⚠️ **GARDE DE SÛRETÉ** : `GET /files/<id>` sert n'importe quel fichier à qui connaît
  l'identifiant. On exige donc que le fichier soit **référencé par un message du canal
  demandé**, lui-même **canal suivi** du miroir. Un identifiant deviné (ou appartenant à
  un autre canal) est **refusé localement**, sans aucune requête.
- **Bornes** : 20 Mio par fichier (`MM_MAX_DOWNLOAD_BYTES`, connexion **coupée** dès
  dépassement), cache **32 pièces / 48 Mio** (un même `file_id` n'est téléchargé qu'une
  fois ; la garde d'appartenance est revérifiée **à chaque** lecture, cache compris).
- **Vision** : `prepareMessageImages` passe par la politique **partagée**
  (`src/files/vision.ts` : `VISION_MAX_EDGE` 2 000, réduction éphémère, plafonds
  `files.imageMaxBytes` / `files.imageMaxWireBytes`) et par la **détection par octets**
  (`imageMimeFromBytes`, `imageSize`) — l'extension Mattermost peut manquer ou mentir.
- Les images préparées partent **dans le même tour** que le prompt du rédacteur
  (`session.prompt(prompt, { images })`, `src/pi/sdk/prompt-writer.ts`). Ce qui n'a pas pu
  être joint (pas une image, trop lourd, illisible) est **dit au modèle** (`notes`) et
  n'est jamais un silence. Quand `llm.light.vision = non`, le SDK remplace l'image par une
  mention explicite — même comportement que les autres chemins.

## 8. Ce qui est prouvé, et comment

| Sujet | Fichier |
| --- | --- |
| défauts sur un miroir **existant** (fichier non réécrit), valeur inconnue ignorée, persistance + relecture | `tests/chat/reply-style.test.ts` |
| `root_id` = racine du fil / absent en `nouveau` (4 combinaisons contre un serveur fixture réel), citation bornée et assainie | `tests/chat/reply-style.test.ts` |
| `PATCH` : sous-ensemble, `null` = défaut, refus explicites, canal inconnu | `tests/chat/chat-api.test.ts` |
| pièces jointes ingérées **et conservées** au redémarrage | `tests/chat/mirror-ingest.test.ts` |
| `POST /files` multipart puis `file_ids` ; refus avant réseau ; échec visible ; jeton absent | `tests/chat/mattermost-files.test.ts` |
| garde d'appartenance (autre canal / identifiant inventé / canal inconnu) **sans aucune requête** ; cache (un seul téléchargement) ; borne de taille | `tests/chat/mattermost-files.test.ts` |
| politique de vision (image → `ImageContent`, fichier texte → note) ; `images`/`notes` transmis au rédacteur | `tests/chat/mattermost-files.test.ts` |
| menu contextuel : trois groupes, option cochée venue du **serveur**, clic → `PATCH`, rechargement, clavier, **CSP 0** | `Yuki and Libs/_tools/e2e-chat-reply-menu.mjs` |

Tous les tests de la partie A et B **échouent sur le code d'origine** (vérifié par copie
ciblée `git show HEAD:<f>` dans `/tmp`, sans aucun `checkout`/`reset`) :
- `reply-style.test.ts` : 15/15 en échec ;
- `chat-api.test.ts` : 6 en échec (les nouveaux cas) ;
- `mirror-ingest.test.ts` : le cas « pièces jointes » en échec ;
- `mattermost-files.test.ts` : le module `attachments.js` n'existe pas.

## 9. Ce qui reste INVÉRIFIABLE ici

| Point | Pourquoi |
| --- | --- |
| Un vrai serveur Mattermost | aucun n'est accessible depuis cet environnement : les tests rejouent le contrat de l'API sur des serveurs fixtures (HTTP réels) |
| La borne réelle d'upload de **votre** instance | dépend de `FileSettings.MaxFileSize` **et** de `client_max_body_size` du proxy : un `413` sera annoncé, jamais contourné |
| Le rendu de la citation dans le client Mattermost | vérifié en Markdown standard (`>`), pas dans un vrai client |
| **Générer une image depuis Mattermost** | **atteignable depuis le lot 20** : politique d'outils branchée sur le run distant (`docs/lot20-chat-outils-distants.md`). Prouvé contre un serveur fixture + un modèle SIMULÉ (`tests/chat/mattermost-image-chain.test.ts`) — pas contre un vrai Mattermost ni un vrai LLM |
