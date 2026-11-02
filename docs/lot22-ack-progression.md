# Lot 22 — accusé, résultat d'outil, non-blocage

Ce lot ferme un trou mesuré : **un run distant ne publiait qu'un seul texte, à la fin**.
Pendant une génération d'image (jusqu'à 180 s, `src/config/schema.ts:899-905`), la
personne qui avait écrit dans le canal n'avait aucun signe de vie.

## Livré

| Élément | Où |
|---|---|
| `ackRuleFor(tools)` : **même** consigne d'accusé, **liste d'outils paramétrée** ; `ACK_RULE = ackRuleFor(ACK_TOOLS)` | `src/pi/ack.ts:104`, `:184`, `:227` |
| `onTool` sur l'écrivain SDK : `tool_execution_start`/`_end` **sortent** (avec le texte déjà écrit, `ackCandidat`) | `src/pi/sdk/prompt-writer.ts` (config `onTool`, abonnement `tool_execution_*`) |
| `ReplyProgress` : module **pur**, 1 accusé/run, 3 résultats/run, rappel unique > 90 s, ligne d'échec unique, publication **sérialisée** | `src/chat/reply/progress.ts:33`, `:36`, `:91`, `:177`, `:201` |
| `publier` dans l'entrée du générateur ; la ligne d'accusé est **retirée** du texte final ; les fichiers déjà postés **ne sont pas réattachés** | `src/chat/reply/generate.ts` (`RemoteReplyInput.publier`) |
| Image publiée **à l'arrivée** (`onFileProduced`) avec `rootIdForReply` + `composeReplyText` (citation **forcée**, `quoteAuthor` inchangé pour la réponse) | `src/chat/mattermost/adapter.ts:766-800`, `src/chat/discord/adapter.ts` |
| Prompt assoupli : « une seule **réponse de fond** ; une ligne d'accusé avant une action est permise » | `src/chat/reply/prompt.ts:43` |
| Garanties verrouillées : ordre `[ack, image, réponse]`, anti-boucle (écho de nos posts ⇒ `auteur_bot`), `historique:true` ⇒ **zéro** run | `tests/chat/reply-*.test.ts` |

Aucune borne réécrite : `MM_DEFAULT_MAX_POST_CHARS` / `fitMattermostContent`
(`src/chat/mattermost/adapter.ts`) et `DISCORD_MAX_CONTENT_CHARS` restent les seules
autorités, et la troncature continue d'être **dite**.

## Le chaînon manquant : le modèle « orchestrateur »

L'utilisateur veut pouvoir **corriger une demande en cours**, comme on steer un
sous-agent. Aujourd'hui, trois faits l'empêchent.

### 1. Un message de canal ouvre TOUJOURS un nouveau run

`maybeReply` décide puis `produceReply` lance une rédaction
(`src/chat/mattermost/adapter.ts:714`, `:751`). Rien ne cherche un **job déjà actif**
pour ce canal : le message devient une question neuve, pas une correction de la tâche
en cours.

### 2. Le run distant n'a AUCUNE identité adressable

Chaque run ouvre une session **éphémère en mémoire** et la `dispose()` dans le même
appel (`src/pi/sdk/prompt-writer.ts:136`, `:259`). Il n'existe donc ni identifiant de
session à rejoindre, ni `steer` possible : c'est structurel, pas un oubli.

### 3. `steer_job` existe, mais il est appelé par le MODÈLE

`steerJob` (`src/delegation/service.ts:434`) route une consigne vers un job **déjà
lancé**, avec un tampon borné pour la fenêtre « en file → premier prompt »
(`src/delegation/steer.ts:26`, `MAX_PENDING_STEERS = 10`), et un refus honnête
`not_steerable` (`src/delegation/ports.ts:220`). Mais l'appelant est l'**outil** du
modèle : pour qu'un message humain y arrive, il faudrait un run qui le lise… donc un
run, c'est-à-dire précisément ce qu'on veut éviter.

## Les deux options (non tranchées)

**Option A — router le message vers le job actif du canal.**
Un index `conversationId → jobId` consulté **avant** `maybeReply` : s'il existe un job
vivant pour ce canal, le message part en `steerJob` au lieu d'ouvrir un run, et une
ligne d'accusé (« consigne transmise ») part sur le canal.
*Coût* : faible (un index + un appel). *Risques* : ambiguïté quand **plusieurs** jobs
tournent pour un canal (lequel corriger ?), et perte du « je te réponds quand même »
(une question sans rapport serait avalée par le job). Atténuation : router seulement si
le job est unique **et** récent, sinon répondre normalement.

**Option B — rendre le run distant PERSISTANT (une session par canal).**
Une session longue par canal, réutilisée : elle devient steerable comme en local
(`src/pi/sdk-host.ts:1592`) et le contexte du canal reste chaud.
*Coût* : élevé (cycle de vie, reprise après redémarrage, compaction, mémoire, coût de
contexte par canal). *Risques* : fuite de contexte entre canaux si l'isolation est mal
faite, et sessions orphelines à nettoyer.

## Génération d'image : détachable ?

`generer_image` s'exécute **dans le tour** (`src/chat/reply/generate.ts`), d'où un tour
de 90 s + 180 s au maximum (`src/chat/reply/prompt.ts:72`, `src/index.ts:1524`). Tant
qu'elle reste synchrone, « tour court » est impossible pour cette action. La rendre
asynchrone suppose un job d'image dont le résultat serait publié par le même chemin que
`createChannelAwareWaker.post` — c'est le prérequis de l'option A, pas un lot séparé.

## Ce qui reste invérifiable ici

- Le ressenti d'usage (latence perçue, bruit dans le canal) ne se mesure qu'en
  situation réelle : aucun test ne le prouve.
- La parité exacte avec le modèle « harness » dépend de choix d'interface (où afficher
  la consigne transmise) qui n'existent pas encore.
