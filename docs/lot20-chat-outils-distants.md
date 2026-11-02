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

`src/llm/tool-policy.ts` → `toolAllowlistForChat("light", options, { chatMode, remoteAgents })`.
Les **implémentations** viennent d'une fabrique unique (`buildRemoteRunTools`,
`src/pi/sdk/remote-run-tools.ts`) qui instancie les **mêmes** fabriques que le host local.

### `chat.remoteAgents = desactive` (**défaut**) — jeu FERMÉ, 4 outils

| Outil | Ce qu'il fait |
| --- | --- |
| `generer_image` | génère une image sur le serveur ComfyUI et l'envoie dans le canal |
| `consulter_workflow` | consignes d'écriture du workflow retenu (lecture locale) |
| `lister_fichiers` | liste les pièces jointes du canal (identifiant, nom, taille) |
| `lire_fichier` | lit une pièce jointe (image vue par le modèle, texte borné) |

Rien d'autre : **ni builtin** (`read`, `ls`, `grep`, `find`), ni délégation, ni transfert,
ni commande, ni secret, ni annuaire, ni archive, ni libraire, ni envoi de fichier.

### `chat.remoteAgents = actives` — politique locale **complète** (hors approbation)

| Groupe | Outils instanciés | Notes |
| --- | --- | --- |
| Lecture disque (builtins SDK) | `read`, `ls`, `grep`, `find` | fournis par le SDK quand ils sont dans l'allowlist (§5) |
| Agents | `lister_agents`, `etat_agent` | **lecture seule** ; sortie balisée/échappée (`src/agents/output.ts`) |
| Délégation | `delegate`, `job_status`, `cancel_job`, `steer_job` | jobs **rattachés au canal** ; résultat **publié dans le canal** (§3) |
| Secrets | `lister_secrets` | ⚠️ **NOMS seulement**, jamais une valeur |
| Fichiers | `envoyer_fichier` (+ `lister_fichiers`, `lire_fichier`) | le fichier est **téléversé dans le canal**, pas seulement affiché dans le web |
| Archive | `archive_vie_anterieure`, `chercher_conversations_archivees` | lecture seule |
| Libraire | `recherche_libraire`, `liste_libraire`, `lire_libraire`, `archive_libraire`, `capture_libraire` | bornes du host local conservées (URL http/https, taille d'image, délais) |
| Images | `generer_image`, `consulter_workflow` | comme en `desactive` |

**Conversation FORCÉE au canal** pour tous les outils qui touchent une conversation
(image générée, pièces jointes, envoi de fichier, capture du libraire, jobs de
délégation) : la session du run est **éphémère**, et sans ce forçage tout serait
rattaché à une conversation fantôme (`src/pi/sdk/remote-run-tools.ts`).

### Rôle lourd

**Rien**, même sous `actives` : aucun run lourd ne naît d'un canal.

## 3. Le résultat d'une délégation revient DANS le canal

Un `delegate` produit un **job asynchrone**. Son résultat est livré par un « réveil »
(`LightWaker.send`, `src/delegation/service.ts:838`), et le seul réveil branché avant ce
lot était le **host Pi** — qui **refuse** une session qu'il n'a pas ouverte
(`PI_SESSION_ERROR` « Session inconnue. », `src/pi/sdk-host.ts:2295`). Une conversation
de canal n'est pas une session Pi : **le résultat était perdu**.

`createChannelAwareWaker` (`src/chat/reply/channel-waker.ts`, branché dans `src/index.ts`)
enveloppe le réveil sans le modifier :

| Conversation du job | Ce qui se passe |
| --- | --- |
| **locale** (`sessionId` Pi) | délégation **exacte** au host : comportement inchangé |
| **canal** (`mm-…` / `dc-…`) | le rapport est **résumé** par le modèle léger (délai `CHAT_JOB_REPORT_TIMEOUT_MS`, 45 s) puis **publié dans ce canal**, borné à 4 000 caractères |

Le même réveil sert à `archive_libraire` (archivage de fond).

**Ce que voit une personne du canal quand ça se passe mal** :

| Panne | Ce qu'elle voit |
| --- | --- |
| le job **échoue** | le rapport contient l'erreur et le travail partiel ; le résumé le dit, dans le canal |
| le **résumé** échoue (modèle indisponible) | une phrase honnête, avec l'identifiant : « …s'est terminée (job `X`), mais je n'ai pas pu en rédiger le résumé ici. Demande-moi « où en est le job `X` »… » — et `job_status` répond |
| la **publication** échoue (canal supprimé, jeton expiré) | rien dans le canal ; l'échec est **journalisé** (`chat.job_report.failed`). ⚠️ C'est la seule limite : aucun autre canal n'existe pour le dire |
| job d'un **autre** canal | `job_status`/`cancel_job`/`steer_job` répondent `not_found` (cloisonnement) |

Le délai du rédacteur vaut « rédaction + génération » (`CHAT_REPLY_TIMEOUT_MS` +
`images.timeoutMs`), sinon un run serait interrompu en pleine génération.

## 4. ⚠️ SÉCURITÉ — le risque, écrit en clair

**Depuis un canal distant, n'importe quel membre peut écrire à Yuki.** Sous
`chat.remoteAgents = actives`, il peut donc **déléguer une tâche**, c'est-à-dire
**faire exécuter du travail sur les machines appairées**. Ce qui protège, et ce qui ne
protège pas :

| Garde-fou | État |
| --- | --- |
| **Autorisation par agent** (niveau de validation, agent désactivé/hors ligne, verrou matériel sensible, audit) | ✅ s'applique : le worker lourd passe par `AgentExecutionService` ; un agent non autorisé **refuse** |
| **Outils à approbation** (`run_command`, `capturer_ecran`, `recuperer_fichier`, `deposer_fichier`, `demander_secret`) | ✅ **retirés et non instanciés** : jamais atteignables depuis un canal (test de garde) |
| **Secrets** | ✅ `lister_secrets` ne rend que des **NOMS** ; `demander_secret` est exclu |
| **Cloisonnement des jobs** | ✅ un canal ne voit/annule/oriente que **ses** jobs |
| **`chat.remoteAgents`** | ⚠️ réglage **GLOBAL** : `actives` l'ouvre pour **tous** les canaux suivis |
| **Qui parle dans le canal** | ⚠️ **aucune notion d'autorisation par personne** : un membre du canal vaut un autre |

**Proposition (NON implémentée ici)** : une restriction **par canal**, sur le modèle des
réglages de réponse déjà stockés dans le miroir (`replyMode`/`replyStyle`,
`ChatMirrorStore.setReplySettings`) — un champ `agents: desactive|actives` par
conversation, lu par `runTools` avant `createRemoteRunTools`. Tant qu'elle n'existe pas :
`actives` = confiance dans **tous** les membres de **tous** les canaux suivis. Laisser
`desactive` (défaut) est le seul réglage sûr.

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
