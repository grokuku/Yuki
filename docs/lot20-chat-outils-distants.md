# Lot 20 — Les runs venus d'un canal ont des OUTILS (et génèrent des images)

> Constat du lot 19, cité tel quel : « **aucun run venu de Mattermost n'a d'outils**
> (`prompt-writer.ts:83` `tools: []`) ⇒ `generer_image` y est **inatteignable**. »
> L'utilisateur avait exigé : « je veux pouvoir **générer et analyser des images** sur
> mattermost ». Ce lot ferme ce trou.
>
> **Complément du 2026-11-02** : la politique autorisait ~19 outils sous
> `chat.remoteAgents = actives` mais le run n'en construisait que 5. Les outils
> manquants sont désormais **instanciés** (§2), leur résultat est **publié dans le
> canal** (§3), et le risque de sécurité est **écrit noir sur blanc** (§4).

## 1. La politique était écrite, jamais branchée

| Avant | Après |
| --- | --- |
| `src/pi/sdk/prompt-writer.ts` ouvrait la session avec `tools: []` **en dur** | `tools` et `customTools` sont des **fonctions relues à chaque appel** (`config.tools?.() ?? []`) : la politique s'applique à CHAQUE réponse, à chaud |
| `toolAllowlistForChat` (`src/llm/tool-policy.ts`) existait mais **personne ne l'appelait** | elle est appelée par `createRemoteRunTools` (`src/pi/chat-run.ts`), seule porte du run distant |
| les options de politique du léger étaient écrites **dans** `createPiHost` | une seule fonction `lightToolOptions()` (`src/index.ts`) alimente le host LOCAL **et** le run DISTANT, puis `toolAllowlistForChat` décide — **pas de seconde liste** |

## 2. La liste RÉELLE des outils d'un run distant

`src/llm/tool-policy.ts` → `toolAllowlistForChat("light", options, { chatMode, remoteAgents, remoteTools })`.
Les **implémentations** viennent d'une fabrique unique (`buildRemoteRunTools`,
`src/pi/sdk/remote-run-tools.ts`) qui instancie les **mêmes** fabriques que le host local.

### 2.0 DEUX réglages, DEUX familles (2026-11-02)

Demande de l'utilisateur : « est-ce que je peux différencier l'accès aux **agents** de
l'accès aux **outils** ? ». Avec un seul interrupteur, la réponse était **non** — d'où le
découpage. Chaque outil custom appartient à **exactement un** groupe
(`REMOTE_TOOL_GROUP_OF`, `src/llm/tool-policy.ts`) : le type `Record<CustomToolName, …>`
rend l'oubli **impossible à compiler**, et un test de garde vérifie la partition
(`tests/chat/remote-access-split.test.ts`).

| Réglage | Outils ouverts | Risque (en clair) |
| --- | --- | --- |
| `chat.remoteAgents = actives` | `delegate`, `job_status`, `cancel_job`, `steer_job`, `lister_agents`, `etat_agent`, `lister_secrets` (+ les builtins de lecture) | **machines appairées** : n'importe quel membre d'un canal suivi peut faire exécuter du travail. Le garde-fou par AGENT s'applique (niveau, hors ligne, verrou, audit) — il n'existe **aucune** autorisation par PERSONNE. |
| `chat.remoteTools = actives` | `generer_image`, `consulter_workflow`, `recherche_libraire`, `liste_libraire`, `lire_libraire`, `archive_libraire`, `capture_libraire`, `archive_vie_anterieure`, `chercher_conversations_archivees` | **aucune machine** : GPU (génération d'image), requêtes vers le libraire, lecture d'archives. Coût de temps et de ressources, aucune exécution distante. |
| *(aucun réglage)* — socle `toujours` | `lister_fichiers`, `lire_fichier`, `publier_dans_canal`, `envoyer_fichier` | **rien ne sort de la conversation** : pièces jointes du fil, message dans un canal SUIVI (périmètre tenu par le port), fichier déjà rattaché. |
| *(aucun réglage)* — groupe `jamais` | `run_command`, `capturer_ecran`, `recuperer_fichier`, `deposer_fichier`, `demander_secret` | **fermés dans tous les cas** : ils exigent une approbation humaine (ou une saisie), qui s'affiche dans l'interface **web** et ne peut pas être donnée depuis un canal. |

Le socle `toujours` reste ouvert même quand les deux réglages sont `desactive`
(défaut) : sans `lister_fichiers`/`lire_fichier`, Yuki ne verrait plus une image jointe
dans un canal.

`lister_secrets` est classé **`agents`** : il ne touche aucune machine (NOMS seulement,
jamais une valeur), mais son unique usage est de savoir quel `${NOM}` référencer dans une
commande **déléguée** — il n'a de sens que si `delegate` est présent.
`envoyer_fichier` est classé **`toujours`** : il ne peut envoyer qu'un fichier **déjà
rattaché** à la conversation (aucun accès disque, aucune machine, aucune approbation).

Effet des quatre combinaisons :

| `remoteAgents` / `remoteTools` | Image | Délégation |
| --- | --- | --- |
| `desactive` / `desactive` (**défaut**) | non | non |
| `desactive` / `actives` | **oui** (inline, voir 2.2) | non |
| `actives` / `desactive` | non | oui |
| `actives` / `actives` | oui (déléguée) | oui |

### `chat.remoteAgents = desactive` (**défaut**) — ni délégation ni machine

Aucune délégation, aucun annuaire, aucun coffre, **ni builtin** (`read`, `ls`, `grep`,
`find`), aucun transfert, aucune commande. Les outils de la famille `outils` suivent
`chat.remoteTools` (tableau ci-dessus), le socle reste.

### 2.2 Outils LONGS : jamais un refus sans alternative

`generer_image` (180 s, `images.timeoutMs`) appelé INLINE dans un canal est REFUSÉ **s'il
existe une autre voie** — c'est-à-dire si `delegate` est dans le run (`remoteAgents =
actives`). Sans `delegate` (« agents non + outils oui », le cas que l'utilisateur
demandait), **aucun refus** : l'appel s'exécute et la **borne du tour** est relevée
jusqu'à 180 s (`channelTurnTimeoutMs`, `src/llm/tool-policy.ts`). Ce correctif ne dépend
**que** de la présence de `delegate`, jamais de la valeur de `chat.remoteTools`.

### Tour né d'un RAPPORT de tâche : aucun outil d'accès distant

`src/index.ts` passe `remoteAgents: false` **et** `remoteTools: false` quand
`contexte.origine === "job"`. Un rapport est une **donnée** : il ne relance pas de travail
(ni délégation, ni génération, ni libraire, ni archive). Il conserve le socle `toujours` —
lister/lire la pièce jointe du job, publier, envoyer un fichier.

### 2 bis. `publier_dans_canal` — publication inter-canal (2026-11-02)

**Ce que Yuki disait, et qui était faux** : « ça demande une validation humaine qui ne
s'affiche que dans l'interface web ». Deux erreurs : aucune approbation n'est en jeu, et
l'outil **n'existait pas**. La phrase du prompt qui l'induisait en erreur
(`CHAT_REPLY_SYSTEM_PROMPT`, « elles exigent une validation humaine… ») ne parlait que des
actions de **machine** ; elle est désormais suivie d'une consigne explicite de **vérité**
(« une capacité absente se dit en une phrase, sans justification inventée »).

**Décision utilisateur (2026-11-02) : option A** — l'outil existe, restreint aux canaux
**SUIVIS**.

| Règle | Où elle est tenue |
| --- | --- |
| canal désigné par **nom lisible** (résolu côté serveur) ou par identifiant | `resoudreCanal`, `src/chat/reply/channel-post.ts` |
| **canaux suivis uniquement** (miroir `chat-mirror.json`) — sinon refus + « ajoutez-le dans Configuration → Conversation → « Discussions — Mattermost / Discord » » | `createChannelPostPort` |
| **même plateforme que le run** (`dc-…` depuis Mattermost ⇒ refus) | `createChannelPostPort` |
| **aucune approbation** (c'est un message, pas une commande) ⇒ `REMOTE_SAFE_TOOLS`, construit même sous `desactive` | `src/llm/tool-policy.ts`, `src/pi/sdk/remote-run-tools.ts` |
| **bornes réutilisées** (`fitMattermostContent`, `fitDiscordContent`) — troncature **dite** au modèle | `src/chat/reply/channel-post.ts` |
| **fil** (`root_id`) facultatif ; un fil inconnu est refusé | `filConnu` (câblage `src/index.ts`) |
| **anti-boucle** : le message publié revient par le WebSocket, il est ingéré (`estBot`/`assistant`) et ne déclenche **aucune** réponse | `tests/chat/channel-post-tool.test.ts` (bout en bout) |

⚠️ **Risque assumé de l'option A** : sous ce périmètre, Yuki peut publier dans **n'importe
lequel** des canaux suivis (jusqu'à 50). Ce n'est pas « n'importe où » : un canal non suivi
est refusé côté serveur, et le modèle reçoit la liste réelle. Une restriction par canal
(`publier: non`) serait la suite naturelle, sur le modèle de `replyMode`.

### Les deux réglages à `actives` — politique locale **complète** (hors approbation)

| Groupe | Outils instanciés | Notes |
| --- | --- | --- |
| Lecture disque (builtins SDK) | `read`, `ls`, `grep`, `find` | fournis par le SDK quand ils sont dans l'allowlist (§5) |
| Agents | `lister_agents`, `etat_agent` | **lecture seule** ; sortie balisée/échappée (`src/agents/output.ts`) |
| Délégation | `delegate`, `job_status`, `cancel_job`, `steer_job` | jobs **rattachés au canal** ; résultat **publié dans le canal** (§3) |
| Secrets | `lister_secrets` | ⚠️ **NOMS seulement**, jamais une valeur |
| Fichiers | `envoyer_fichier` (+ `lister_fichiers`, `lire_fichier`) | socle `toujours` : présent même sans réglage ; le fichier est **téléversé dans le canal**, pas seulement affiché dans le web |
| Archive | `archive_vie_anterieure`, `chercher_conversations_archivees` | lecture seule |
| Libraire | `recherche_libraire`, `liste_libraire`, `lire_libraire`, `archive_libraire`, `capture_libraire` | bornes du host local conservées (URL http/https, taille d'image, délais) |
| Images | `generer_image`, `consulter_workflow` | groupe `outils` : présents dès que `remoteTools = actives` |

**Conversation FORCÉE au canal** pour tous les outils qui touchent une conversation
(image générée, pièces jointes, envoi de fichier, capture du libraire, jobs de
délégation) : la session du run est **éphémère**, et sans ce forçage tout serait
rattaché à une conversation fantôme (`src/pi/sdk/remote-run-tools.ts`).

### Rôle lourd

**Rien**, quelles que soient les deux valeurs : aucun run lourd ne naît d'un canal.

## 3. Le résultat d'une délégation revient DANS le canal

Un `delegate` produit un **job asynchrone**. Son résultat est livré par un « réveil »
(`LightWaker.send`, `src/delegation/service.ts`), et le seul réveil branché au départ était
le **host Pi** — qui **refuse** une session qu'il n'a pas ouverte (`PI_SESSION_ERROR`
« Session inconnue. », `src/pi/sdk-host.ts`). Une conversation de canal n'est pas une
session Pi : **le résultat était perdu**.

⚠️ **INVARIANT (2026-11-02, corrigé une deuxième fois)** : dans un canal, **un seul
rédacteur — le tour de Yuki** (`docs/lot18-chat.md` § 15). Le réveil de canal ne publie
donc **rien** lui-même : il INJECTE le rapport comme message SYSTÈME dans la conversation
et c'est la **réponse de Yuki** qui part.

| Conversation du job | Ce qui se passe |
| --- | --- |
| **locale** (`sessionId` Pi) | délégation **exacte** au host : comportement inchangé |
| **canal** (`mm-…` / `dc-…`) | le rapport est **injecté** (`wakeReport`, `src/chat/reply/job-report.ts`) : Yuki le lit et **sa** réponse est publiée, avec les fichiers du job |

**Ce que voit une personne du canal** :

| Situation | Ce qu'elle voit |
| --- | --- |
| le job **réussit** | la réponse de Yuki (1–3 phrases), avec les fichiers produits **joints** — sauf ceux qu'elle a publiés ailleurs dans le tour |
| le job **échoue** | la réponse de Yuki le dit : le rapport (erreur + travail partiel) est dans son contexte |
| Yuki **ne peut pas rédiger** (modèle injoignable, canal disparu, file pleine) | **repli explicite** : le rapport part en texte, précédé de « ⚠️ Repli : je n'ai pas pu reprendre la rédaction dans ce canal… » — seul cas où le serveur écrit |
| job d'un **autre** canal | `job_status`/`cancel_job`/`steer_job` répondent `not_found` (cloisonnement) |

Le délai du rédacteur vaut « rédaction + génération » (`CHAT_REPLY_TIMEOUT_MS` +
`images.timeoutMs`), sinon un run serait interrompu en pleine génération.

## 4. ⚠️ SÉCURITÉ — le risque, écrit en clair

**Depuis un canal distant, n'importe quel membre peut écrire à Yuki.** Sous
`chat.remoteAgents = actives`, il peut donc **déléguer une tâche**, c'est-à-dire
**faire exécuter du travail sur les machines appairées**. Sous `chat.remoteTools = actives`
(seul, sans agents), il peut **faire générer des images**, interroger le libraire et lire
les archives — sans jamais atteindre une machine. Ce qui protège, et ce qui ne protège pas :

| Garde-fou | État |
| --- | --- |
| **Autorisation par agent** (niveau de validation, agent désactivé/hors ligne, verrou matériel sensible, audit) | ✅ s'applique : le worker lourd passe par `AgentExecutionService` ; un agent non autorisé **refuse** |
| **Outils à approbation** (`run_command`, `capturer_ecran`, `recuperer_fichier`, `deposer_fichier`, `demander_secret`) | ✅ **retirés et non instanciés** : jamais atteignables depuis un canal (test de garde) |
| **Secrets** | ✅ `lister_secrets` ne rend que des **NOMS** ; `demander_secret` est exclu |
| **Cloisonnement des jobs** | ✅ un canal ne voit/annule/oriente que **ses** jobs |
| **`chat.remoteAgents`** | ⚠️ réglage **GLOBAL** : `actives` l'ouvre pour **tous** les canaux suivis |
| **`chat.remoteTools`** (2026-11-02) | ⚠️ réglage **GLOBAL** aussi : `actives` ouvre l'image, le libraire et les archives pour **tous** les canaux suivis — mais **aucune machine** n'est atteinte (le risque est du GPU et du temps, pas une exécution) |
| **Qui parle dans le canal** | ⚠️ **aucune notion d'autorisation par personne** : un membre du canal vaut un autre |

**Proposition (NON implémentée ici)** : une restriction **par canal**, sur le modèle des
réglages de réponse déjà stockés dans le miroir (`replyMode`/`replyStyle`,
`ChatMirrorStore.setReplySettings`) — un champ `agents: desactive|actives` par
conversation, lu par `runTools` avant `createRemoteRunTools`. Tant qu'elle n'existe pas :
`actives` = confiance dans **tous** les membres de **tous** les canaux suivis. Laisser
`desactive` (défaut) sur **les deux réglages** est le seul réglage sûr.

⚠️ Rappel : sous `actives`, les builtins `read`/`ls`/`grep`/`find` lisent le répertoire de
travail de Yuki (`/workspace`). C'est le comportement de la politique locale, pas une
nouveauté de ce lot — mais un canal distant y a désormais accès.

### Approbations — ce qui est RETIRÉ, et ce qui se passe

`APPROVAL_REQUIRED_TOOLS` (`src/llm/tool-policy.ts`) : `run_command`, `capturer_ecran`,
`recuperer_fichier`, `deposer_fichier` (garde-fou par agent ⇒ demande de validation) et
`demander_secret` (fenêtre de saisie web). Décisions :

1. ils sont **RETIRÉS de toute politique distante** (refus **avant** exécution) ;
2. `assertNoApprovalTool` **et** `assertNoApprovalToolDefinition` (`src/pi/chat-run.ts`)
   lèvent si une liste **ou une définition construite** en contient un — second filet
   contre un câblage forgé à la main ;
3. la consigne du rédacteur le dit au modèle (`CHAT_REPLY_SYSTEM_PROMPT`).

⚠️ **Publier n'est PAS dans cette liste** : `publier_dans_canal` n'exige aucune validation
humaine (aucune machine n'est touchée). C'est vérifié par un test de garde
(`REMOTE_SAFE_TOOLS` ∩ `APPROVAL_REQUIRED_TOOLS` = ∅).

⚠️ **Limite assumée** : une délégation peut rencontrer une action à valider sur une
machine ; la demande s'affiche alors dans l'interface **web**, et le canal n'en reçoit
que le texte du modèle. Le **relais d'approbations** (lot suivant) est le vrai remède.

## 5. Le journal de l'écart — corrigé

`chat.remote.tools.unimplemented` (`src/pi/chat-run.ts`) signalait comme « manquants »
`read`, `ls`, `grep`, `find` : **c'était faux**, ces outils sont fournis par le SDK dès
qu'ils figurent dans l'allowlist (`node_modules/@earendil-works/…/core/agent-session.js`).
La comparaison les **exclut** désormais (`READ_ONLY_TOOLS`). Le journal ne sert plus
qu'aux outils réellement absents, faute de port (coffre non initialisé, libraire non
configuré, service de délégation indisponible).

## 6. Tests — et ce qu'ils prouvent

| Sujet | Fichier |
| --- | --- |
| **chaque** outil de `actives` est construit (nommés un par un) ; `desactive` ⇒ tous absents ; aucun outil à approbation ; `lister_secrets` noms seuls (sentinelle) ; délégation rattachée au canal ; `job_status` cloisonné ; `envoyer_fichier` signalé pour publication ; journal **sans** les builtins | `tests/pi/remote-run-tools.test.ts` |
| le rapport d'un job est **publié dans le canal**, le local passe au host à l'identique, phrase honnête si le résumé échoue, échec de publication journalisé, texte borné | `tests/chat/channel-waker.test.ts` |
| politique par mode, aucun outil à approbation, mode local inchangé | `tests/llm/tool-policy.test.ts`, `tests/llm/tool-policy-chat.test.ts` |
| `publier_dans_canal` : canal suivi (nom/identifiant), refus hors miroir et hors plateforme, bornes/troncature, fil, anti-boucle de bout en bout | `tests/chat/channel-post-tool.test.ts` |
| chaîne complète jusqu'aux `file_ids` (serveur Mattermost fixture) | `tests/chat/mattermost-image-chain.test.ts` |
| frontière : la façade `src/pi` reste sans type du SDK | `tests/pi/boundary.test.ts` |

⚠️ **Échouent sur le code d'origine** (copie ciblée `git show HEAD:<f>` dans `/tmp`,
sans aucun `checkout`/`reset`) : `buildRemoteRunTools` n'acceptait que
`images`/`files`/`vision`/`onFileProduced` ⇒ `delegate`, `lister_agents`,
`lister_secrets`, les outils d'archive, du libraire et `envoyer_fichier` **n'existaient
pas** dans une définition de run distant ; `createChannelAwareWaker` n'existait pas ;
et le journal citait bien les builtins.

## 7. Ce qui reste INVÉRIFIABLE ici

| Point | Pourquoi |
| --- | --- |
| Un **vrai** Mattermost / Discord | aucun serveur accessible : fixtures HTTP/WS rejouant le contrat des API |
| Un **vrai** LLM décidant d'appeler `delegate` | modèle simulé : c'est le test qui appelle l'outil. La boucle d'outils du SDK est celle, déjà exercée, du host local |
| Un **vrai** serveur ComfyUI / un **vrai** Libry | générateurs simulés (mêmes formes que les réels) |
| La **publication réelle** du rapport d'un job dans un canal | l'adaptateur est couvert par ses propres tests (`send`), et le waker par `tests/chat/channel-waker.test.ts`, mais la chaîne « job → résumé → post » n'a pas été rejouée contre un serveur réel |
| L'**autorisation par personne** dans un canal | elle n'existe pas (voir §4) : le risque est documenté, pas corrigé |
