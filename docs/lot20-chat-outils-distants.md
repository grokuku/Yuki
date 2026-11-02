# Lot 20 — Les runs venus d'un canal ont des OUTILS (et génèrent des images)

> Constat du lot 19, cité tel quel : « **aucun run venu de Mattermost n'a d'outils**
> (`prompt-writer.ts:83` `tools: []`) ⇒ `generer_image` y est **inatteignable**. »
> L'utilisateur avait exigé : « je veux pouvoir **générer et analyser des images** sur
> mattermost ». Ce lot ferme ce trou.

## 1. La politique était écrite, jamais branchée

| Avant | Après |
| --- | --- |
| `src/pi/sdk/prompt-writer.ts` ouvrait la session avec `tools: []` **en dur** | `tools` et `customTools` sont des **fonctions relues à chaque appel** (`config.tools?.() ?? []`) : la politique s'applique à CHAQUE réponse, à chaud |
| `toolAllowlistForChat` (`src/llm/tool-policy.ts`) existait mais **personne ne l'appelait** | elle est appelée par `createRemoteRunTools` (`src/pi/chat-run.ts`), seule porte du run distant |
| les options de politique du léger étaient écrites **dans** `createPiHost` | une seule fonction `lightToolOptions()` (`src/index.ts`) alimente le host LOCAL **et** le run DISTANT, puis `toolAllowlistForChat` décide — **pas de seconde liste** |

## 2. Quels outils dans un run distant

`src/llm/tool-policy.ts` → `toolAllowlistForChat("light", options, { chatMode, remoteAgents })`

| Configuration | Allowlist du run |
| --- | --- |
| `chat.mode = local` | **inchangée** : exactement `toolAllowlist("light", options)` (test de non-régression) |
| distant + `chat.remoteAgents = desactive` (**défaut**) | `REMOTE_SAFE_TOOLS` : `generer_image`, `consulter_workflow`, `lister_fichiers`, `lire_fichier` — rien d'autre |
| distant + `chat.remoteAgents = actives` | la politique locale du léger, **plus** les quatre outils ci-dessus qu'elle ne porte pas (le léger local lit le store via `envoyer_fichier` ; un run distant n'a que `lire_fichier` pour voir une image), **moins** les outils à approbation |
| distant, **rôle lourd** | **rien**, même agents activés : aucun run lourd ne naît d'un canal |

Les **implémentations** viennent d'une fabrique unique (`buildRemoteRunTools`,
`src/pi/sdk/remote-run-tools.ts`) qui instancie les **mêmes** fabriques que le host local
(`createImageTools`, `createListFilesTool`, `createReadFileTool`). La conversation est
**forcée** au canal : la session du run est éphémère, et sans cela l'image serait
rattachée à une conversation fantôme. Un test verrouille la **parité** entre
`REMOTE_SAFE_TOOLS` et les outils réellement construits.

## 3. Approbations — ce qui est RETIRÉ, et ce qui se passe

⚠️ **Une approbation s'affiche dans l'interface WEB** (`ApprovalRegistry` →
`src/agents/execution.ts:1147`) ; `demander_secret` ouvre aussi une fenêtre dans le web.
**Un run distant qui en demanderait une resterait en attente d'une décision que personne
ne peut prendre depuis le canal.**

`APPROVAL_REQUIRED_TOOLS` (`src/llm/tool-policy.ts`) :

| Outil | Pourquoi |
| --- | --- |
| `run_command`, `capturer_ecran` | garde-fou par agent (niveau 2, ou 3 si destructrice) ⇒ demande de validation |
| `recuperer_fichier`, `deposer_fichier` | même garde-fou (`authorizeTransfer`) |
| `demander_secret` | fenêtre de saisie dans la conversation web |

Décision **tranchée** :
1. ces outils sont **RETIRÉS de toute politique distante** (refus **avant** exécution) ;
2. `assertNoApprovalTool` (`src/pi/chat-run.ts`) **lève** si une liste en contient un
   (« Cette action nécessite une approbation humaine, qui ne peut pas être donnée depuis
   un canal distant… Rien n'a été exécuté. ») — second filet pour une liste forgée à la main ;
3. la consigne du rédacteur le dit au modèle (`CHAT_REPLY_SYSTEM_PROMPT`,
   `src/chat/reply/prompt.ts`) : il annonce l'impossibilité au lieu d'attendre.

**Les quatre outils de `REMOTE_SAFE_TOOLS` ne demandent AUCUNE approbation** (vérifié
outil par outil) : `generer_image` (génération locale sur ComfyUI), `consulter_workflow`
(lecture locale), `lister_fichiers` et `lire_fichier` (lecture du store de la
conversation). Un test échoue si quelqu'un en ajoute un.

⚠️ **Limite assumée** : sous `actives`, la **délégation** reste autorisée (elle ne demande
pas d'approbation) ; si le worker lourd qu'elle déclenche rencontre une action à valider
sur une machine, la demande s'affiche dans l'interface web et le canal n'en voit que le
texte du modèle. Le **relais d'approbations** (lot suivant) est le vrai remède.

## 4. La chaîne complète, prouvée

`tests/chat/mattermost-image-chain.test.ts` (serveur Mattermost **fixture** HTTP + WS,
stores **réels**, modèle **simulé** qui appelle vraiment l'outil reçu) :

1. message posté dans le canal → miroir → décision de répondre (`tout`) ;
2. la politique du run est calculée (`mattermost`, `desactive`) et **arrive à la session** ;
3. `generer_image` s'exécute (générateur ComfyUI simulé) → l'image est **copiée dans le
   store des fichiers**, rattachée à la **conversation du canal** (jamais à la session
   éphémère) ;
4. `POST /files` (multipart) puis `POST /posts` avec **`file_ids` non vides**.

⚠️ L'image d'un run distant n'est **pas** diffusée dans l'interface web (pas de trame
`image` : aucune conversation web n'est concernée) — elle vit dans le canal et dans le
store des fichiers de la conversation distante.

⚠️ **Délai** : une génération peut durer jusqu'à `images.timeoutMs` (180 s par défaut).
Le délai du rédacteur vaut donc « rédaction + génération » (`src/index.ts`), sinon le run
serait interrompu **en pleine génération** et le canal n'aurait aucune réponse.

Le contrat de sortie du générateur de réponse a été étendu pour cela :
`Promise<string | { text, fichiers? }>` (`src/chat/mattermost/adapter.ts`), et
`produceReply` joint les fichiers au post (`send(..., { fichiers })`).

## 5. Tests — et ce qu'ils prouvent

| Sujet | Fichier |
| --- | --- |
| le prompt distant **contient les outils** de la politique (aujourd'hui `[]` sur l'origine) ; `desactive` ⇒ image/lecture ; `actives` ⇒ liste locale complète | `tests/pi/prompt-writer-tools.test.ts` |
| politique par mode, **aucun** outil à approbation, mode local inchangé | `tests/llm/tool-policy.test.ts`, `tests/llm/tool-policy-chat.test.ts` |
| chaîne complète jusqu'aux `file_ids` | `tests/chat/mattermost-image-chain.test.ts` |
| frontière : la façade `src/pi` reste sans type du SDK | `tests/pi/boundary.test.ts` |

⚠️ **Échouent sur le code d'origine** (copie ciblée `git show HEAD:<f>` dans
`/tmp/preuve-lot20`, sans aucun `checkout`/`reset`) : `toolAllowlistForChat is not a
function`, `createRemoteRunTools is not a function`, `createRemoteReplyGenerator is not a
function` ⇒ **10 tests en échec** ; et `git show HEAD:src/pi/sdk/prompt-writer.ts` montre
bien `tools: [],` là où le code courant passe `config.tools?.() ?? []`.

## 6. Ce qui reste INVÉRIFIABLE ici

| Point | Pourquoi |
| --- | --- |
| Un **vrai** Mattermost | aucun serveur accessible : fixture HTTP/WS qui rejoue le contrat de l'API |
| Un **vrai** LLM décidant d'appeler `generer_image` | fournisseur simulé : c'est le test qui appelle l'outil, pas un modèle. La boucle d'outils du SDK est celle, déjà exercée, du host local |
| Un **vrai** serveur ComfyUI | générateur simulé (écrit dans le vrai store d'images, rend la même forme que le réel) |
| Les outils de `actives` **non instanciés** dans un run éphémère (délégation, coffre, libraire, archive, envoi de fichier) | ils supposent un état de conversation persistant : la politique les autorise, le run ne les fournit pas encore, et l'écart est **journalisé** (`chat.remote.tools.unimplemented`) — jamais silencieux |
