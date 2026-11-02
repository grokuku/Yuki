# Lot 21 — Le client Discord (même modèle que Mattermost)

> Objectif : **parler depuis Discord** avec le **même** socle que Mattermost — mêmes
> fonctions de décision, de rédaction, de politique d'outils et de miroir.
> Ce document est **court** : il dit ce qui est livré, ce qui est vérifié, ce qui diffère
> de Mattermost et ce qui reste **invérifiable sans un vrai serveur Discord**.

## 1. Prérequis côté utilisateur (⚠️ à faire AVANT de chercher une panne)

1. **Créer une application** sur <https://discord.com/developers/applications> → *Bot* →
   **Reset Token** → copier le jeton (il ne sera plus jamais affiché).
2. ⚠️ **Activer l'intent privilégié `MESSAGE_CONTENT`** : *Bot* → **Privileged Gateway
   Intents** → *MESSAGE CONTENT*. **Sans lui, Discord envoie les messages avec un
   `content` VIDE** : le bot est connecté, il ne « voit » rien (sauf s'il est cité).
   C'est **la** cause n°1 de « ça ne marche pas ». L'intent est détecté par
   `GET /applications/@me` (drapeaux `1 << 18` / `1 << 19`) et affiché **en rouge** dans
   `/config → Discussions` (`src/chat/discord/client.ts:application`,
   `public/ui/chat-panel.js:MESSAGE_CONTENT_WARNING`).
3. **Inviter le bot** avec les permissions : *Voir les salons*, *Lire l'historique des
   messages*, *Envoyer des messages*, *Joindre des fichiers* (+ *Gérer les fils* si les
   réponses doivent partir dans un fil).
4. Dans Yuki : `/config → Discussions → Discord` → coller le jeton →
   **Enregistrer le jeton** → **Se connecter**.

## 2. Ce qui est livré

| Élément | Fichier |
| --- | --- |
| Client REST v10 (identité, serveurs, salons, messages, envoi, CDN) | `src/chat/discord/client.ts` |
| Passerelle v10 (`HELLO`, `IDENTIFY`, `RESUME`, battements avec gigue, `4014`) | `src/chat/discord/ws.ts` |
| Types filaires + constantes (intents, bornes, types de salons) | `src/chat/discord/types.ts` |
| Adaptateur `ChatAdapter` + `ChatSyncPlatform` | `src/chat/discord/adapter.ts` |
| Ingestion (auteur, pièces jointes, fils) | `src/chat/mirror/ingest.ts:ingestDiscordMessage` |
| Cache de pièces jointes **générique** (partagé Mattermost/Discord) | `src/chat/attachments.ts` |
| Routes `/api/chat/discord*` (GÉNÉRIQUES par plateforme) | `src/gateway/routes/chat.ts` |
| Réglages `chat.discord.guildId`, `chat.discord.maxUploadBytes` | `src/config/schema.ts` |
| Jeton `YUKI_CHAT_DISCORD` (coffre, saisi une fois, jamais relu) | `src/secrets/references.ts` |

⚠️ **Rien n'a été recopié de Mattermost** : `decideReply`, `composeReplyText`,
`rootIdForReply`, `toolAllowlistForChat`, `createRemoteRunTools`, `ChatSyncService`,
`ChatMirrorStore` et `prepareMessageImages` sont **les mêmes objets**, appelés de la même
façon. Ce lot a d'ailleurs **remonté** dans la couche générique ce qui était à tort dans
`src/chat/mattermost/` : le cache de pièces jointes (`src/chat/attachments.ts`), le juge et
le rédacteur (`src/index.ts`, `chatJudge` / `chatReplyGenerator`), et l'écriture dans le
miroir (`applyMessageToMirror`).

## 3. API vérifiée (sources)

| Point | Source |
| --- | --- |
| `wss://gateway.discord.gg/?v=10&encoding=json` ; `HELLO` (op 10) donne `heartbeat_interval`; premier battement après `interval × jitter` (jitter ∈ [0,1]) puis toutes les `interval` | `developers/events/gateway.mdx` § *Connecting*, § *Sending Heartbeats* |
| `IDENTIFY` (op 2) = `{ token, intents, properties{os,browser,device} }` ; `RESUME` (op 6) = `{ token, session_id, seq }` ; `HEARTBEAT` (op 1) porte le dernier `s` (ou `null`) | `developers/events/gateway-events.mdx` § *Identify*, § *Resume*, § *Heartbeat* |
| `READY` fournit `session_id` et `resume_gateway_url` (à utiliser pour reprendre) ; `RESUMED` clôt le rejeu ; `RECONNECT` = op 7 ; `INVALID_SESSION` = op 9 (`d` booléen) | `gateway.mdx` § *Resuming*, `gateway-events.mdx` § *Ready / Resumed / Reconnect / Invalid Session* |
| Codes de fermeture : **4004** (jeton incorrect) et **4014** (intent non autorisé) ⇒ `Reconnect: false` | `topics/opcodes-and-status-codes.mdx` § *Gateway Close Event Codes* |
| Intents : `GUILDS` `1<<0`, `GUILD_MESSAGES` `1<<9` (standard) ; **`MESSAGE_CONTENT` `1<<15` (privilégié)** | `gateway.mdx` § *List of Intents*, § *Privileged Intents* |
| Détection de l'intent : `GET /applications/@me` → `flags` `1<<18` (`GATEWAY_MESSAGE_CONTENT`) / `1<<19` (`…_LIMITED`) | `resources/application.mdx` § *Application Flags*, § *Get Current Application* |
| REST : `Authorization: Bot <jeton>` ; base `https://discord.com/api/v10` | `reference.mdx` § *Authentication*, § *API Versioning* |
| `GET /channels/{id}/messages?limit=1..100&before=|after=|around=` — **ordre antéchronologique**, `before`/`after` exclusifs, **pas de `since`** | `resources/message.mdx` § *Get Channel Messages* |
| `POST /channels/{id}/messages` — `message_reference{message_id, channel_id, fail_if_not_exists}`, `files[n]` + `payload_json` en `multipart/form-data`, `content` ≤ 2 000 caractères, requête ≤ 25 Mio | `resources/message.mdx` § *Create Message*, `reference.mdx` § *Uploading Files* |
| Fichier : **20 Mio par défaut** (davantage selon le boost), requête max **25 Mio** | `reference.mdx` § *Uploading Files* |
| `GET /guilds/{id}/channels` **n'inclut pas les fils** ; un fil a `parent_id` = salon parent, et son identifiant **est** celui du message racine | `resources/guild.mdx`, `resources/channel.mdx` (types 0/5/10/11/12) |
| Débit : `X-RateLimit-Limit/Remaining/Reset-After/Bucket`, `429` + `retry_after` (secondes) + `Retry-After`, seaux par route | `topics/rate-limits.mdx` § *Header Format*, § *Exceeding A Rate Limit* |

## 4. Différences ASSUMÉES avec Mattermost

1. **`replyMode` par défaut = `mention`, résolu PAR PLATEFORME**
   (`defaultReplyModeFor("discord")`, `src/chat/reply/responder.ts`). Un bot qui répond à
   **tout** dans un serveur actif y est insupportable, et Discord n'a pas de fil par défaut.
   ⚠️ Mattermost applique **déjà** `mention` depuis le lot 18 : la divergence n'est donc
   pas dans la valeur d'aujourd'hui, mais dans le fait que le défaut est **désormais
   résolu par plateforme** — le jour où l'une change, l'autre ne suivra pas par accident.
2. **Pas de `since`** : le backfill **descend** par identifiant (`before`) jusqu'à la
   fenêtre de 14 jours ou la borne de 1 000 messages. ⚠️ Une page **courte** n'est pas la
   preuve de la fin : la lecture ne conclut qu'à une page **vide**
   (`src/chat/discord/client.ts:channelMessagesSince`).
3. **Pièces jointes entrantes** : Discord fournit nom, taille, type et URL **dans le
   message** ⇒ **aucun appel d'API pour les lister**. Le téléchargement se fait sur le CDN
   **sans le jeton du bot** (`Authorization` absent) et seulement pour un fichier déjà
   référencé par un message d'un canal **suivi**.
4. **Fichiers sortants** : `multipart` dans le **même** appel (`files[0]`) ; Mattermost
   demande `POST /files` **puis** `file_ids`.
5. **Un fil n'est pas une conversation** : ses messages rejoignent la conversation du
   salon parent avec `threadRootId` = identifiant du fil. Le backfill ne remonte **pas**
   dans les fils (le temps réel les voit ; c'est une limite, pas un oubli).
6. **Borne d'envoi** : 8 Mio par défaut (`chat.discord.maxUploadBytes`), plafonnée à
   25 Mio. Mattermost : 100 Mio.

## 5. Bornes et garde-fous

- 50 canaux suivis (borne du miroir), 20 000 messages par canal, 16 Kio par message.
- Backfill : **14 jours** et **1 000 messages** par canal ; le dépassement est **dit**
  (« historique antérieur non importé »).
- Jeton : coffre chiffré, **saisi une fois**, jamais relu, **jamais référençable dans une
  commande** (`YUKI_CHAT_` ≠ `YUKI_SECRET_`), jamais journalisé, jamais dans une URL, jamais
  vers le CDN.
- Réponses : anti-boucle **avant tout le reste** (auteur = robot ⇒ aucune réponse, Yuki
  comme un autre bot : `decideReply`, `src/chat/reply/responder.ts`), mentions
  neutralisées (`allowed_mentions: {parse: []}`), texte tronqué à 2 000 caractères **en le
  disant** (`fitDiscordContent`), pièce jointe refusée **avant réseau** sans empêcher le
  texte de partir.
- **Backfill ≠ réponses** : l'historique rejoué par la synchronisation est livré à
  l'interface mais **jamais** au moteur de réponse (`historique: true`), et les réponses
  simultanées sont **bornées** (2 en cours, file bornée, refus journalisé :
  `src/chat/reply/limiter.ts`).
- **CSP inchangée** : aucun appel du navigateur vers Discord, aucun `innerHTML`.

## 6. Limites (dites, pas cachées)

- **Pas de relais d'approbations** : une approbation se donne dans l'interface web ; les
  outils qui en exigent une sont **retirés** de la politique distante
  (`APPROVAL_REQUIRED_TOOLS`, `assertNoApprovalTool`).
- **Mémoire distante non branchée** — et **sans réglage** : `chat.remoteMemory` a été
  **retiré** (il n'avait aucun consommateur, seulement un affichage).
- **Pas de backfill des fils**, pas de listing des fils actifs
  (`GET /channels/{id}/threads/active` non utilisé).
- Les URL de pièces jointes Discord **expirent** : au-delà, le téléchargement échoue et le
  dit ; le message est alors relu **une fois** par l'API pour rafraîchir le lien — dans le
  **salon du message** (celui du fil pour un message de fil, `salonDuMessage`), pas dans le
  salon parent, qui rendait `404`.

## 7. ⚠️ Ce qui reste INVÉRIFIABLE sans un vrai serveur Discord

Tout a été testé contre des **fixtures réelles** (serveur HTTP + serveur WebSocket) :
pagination, `429`, `IDENTIFY`/`RESUME`, ingestion, anti-boucle, trois modes, pièces
jointes, routes. **N'a PAS été observé contre Discord lui-même** :

1. l'acceptation d'un `before=` **synthétique** (on n'en envoie pas : la descente part
   toujours d'un identifiant réel) ;
2. le comportement exact d'un **`4014`** (testé en simulant la fermeture, pas en la
   provoquant) ;
3. la **rotation** des URL signées (24 h) et le rafraîchissement par relecture ;
4. les **seuils de débit réels** (on lit les en-têtes, on ne les suppose pas) ;
5. l'ordre d'arrivée `MESSAGE_CREATE` / `MESSAGE_UPDATE` sous forte charge.

**Étapes de vérification par l'utilisateur** (5 minutes) :
```bash
# 1. Jeton valide + intent actif (doit répondre 200 et montrer les drapeaux)
curl -s -H "Authorization: Bot $JETON" https://discord.com/api/v10/users/@me
curl -s -H "Authorization: Bot $JETON" https://discord.com/api/v10/applications/@me | head -c 300
# 2. Un salon lisible par le bot (remplacer SALON)
curl -s -H "Authorization: Bot $JETON" "https://discord.com/api/v10/channels/SALON/messages?limit=5"
```
Puis, dans Yuki : `/config → Discussions → Discord` → jeton → **Se connecter** → vérifier
que le badge passe à ● et que les salons apparaissent. Enfin : écrire `@Yuki bonjour` dans
un salon (mode `mention` par défaut) et vérifier que la réponse arrive **dans le fil**.

## 8. Tests

| Ce qui est prouvé | Fichier |
| --- | --- |
| REST : `Authorization: Bot`, pagination par identifiant sans perte, `429` respecté, erreurs sans jeton, CDN sans jeton, hôte étranger refusé | `tests/chat/discord-rest.test.ts` |
| Passerelle : `HELLO`⇒battement (+gigue), `IDENTIFY` (intents), `RESUME` sans doublon, `4004` ⇒ arrêt net, `4014` ⇒ reprise sans intent, `RECONNECT` | `tests/chat/discord-ws.test.ts` |
| Miroir : idempotence, édition ⇒ une bulle, suppression ⇒ mention, `threadRootId`, identité du bot par plateforme | `tests/chat/discord-mirror.test.ts` |
| Réponses : `mention` par défaut, trois modes, anti-boucle, `message_reference` selon `replyStyle`, `files[0]`, troncature, borne avant réseau | `tests/chat/discord-reply.test.ts` |
| Pièces jointes : métadonnées sans appel, téléchargement à la demande, vision par octets, id hors canal ⇒ refus **zéro requête**, image générée jointe | `tests/chat/discord-attachments.test.ts` |
| Outils : politique distante appliquée sans duplication, aucun outil à approbation, mémoire désactivée | `tests/chat/discord-tools.test.ts` |
| Routes : garde `X-Yuki-Config`, jeton jamais renvoyé, validation du serveur et de la borne, routage par préfixe | `tests/chat/discord-api.test.ts` |
