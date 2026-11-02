# Lot 23 — Yuki orchestratrice en canal

Objectif utilisateur (2026-11-02) : **en canal Mattermost/Discord, le tour de Yuki finit
vite ; les actions longues partent en job (`delegate`), leur résultat — fichier
compris — est posté dans le canal, et on peut lui parler pendant.**

## Le trou mesuré

Un run de canal est borné par `CHAT_REPLY_TIMEOUT_MS` = 90 s
(`src/chat/reply/prompt.ts:72`) alors que `generer_image` peut prendre
`images.timeoutMs` = 180 s (`src/config/schema.ts:899-905`) ⇒ **l'image était
avortée en plein vol, sans message**. Et le rapport d'un job était **pur texte**
(`LightWaker.post(conversationId, text)`) ⇒ déléguer une image donnait une image
que personne ne voyait.

## Livré

| Élément | Où |
|---|---|
| `LightWaker.send(..., { fichiers })` ; bornes **3 fichiers**, troncature **dite**, échec de fichier ⇒ **le texte part quand même** | `src/delegation/ports.ts`, `src/chat/reply/channel-waker.ts` |
| `JobResult.fichiers` journalisé avec le résultat (union dédupliquée au rejeu) ⇒ il **survit à un redémarrage** | `src/jobs/types.ts`, `src/jobs/store.ts` |
| `HeavyRunResult.fichiers` ; le lot de `job_report` les réunit et les passe au réveil | `src/pi/sdk/heavy-worker.ts`, `src/delegation/service.ts` |
| Publication réutilisant **le seul** chemin existant : `envoyerDansCanal` (`POST /files` multipart puis `file_ids`) | `src/index.ts` (`post:`) |
| `generer_image` + `consulter_workflow` au **worker lourd** (`images: IMAGE_TOOLS`, `imagesEnabled` réel) ; conversation **forcée** = celle du canal ; `onFileProduced` ⇒ `HeavyRunResult.fichiers` | `src/llm/tool-policy.ts`, `src/index.ts`, `src/pi/sdk/heavy-worker.ts` |
| `LONG_RUNNING_TOOLS` : borne **mesurée** et sa source par entrée (`generer_image` 180 s, `run_command` 60 s, transferts 120 s, `capturer_ecran` 30 s, `capture_libraire` 30 s) | `src/llm/tool-policy.ts` |
| **Refus dans l'outil** d'un appel long inline en canal (`guardLongToolsInChannel`), message actionnable ; **local inchangé** | `src/pi/sdk/long-tool-guard.ts`, `src/pi/sdk/remote-run-tools.ts` |
| `DELEGATION_RULE` + **jobs du canal** injectés dans le prompt du run distant, **sous `chat.remoteAgents = actives` seulement** (`extensionFactories`) | `src/pi/chat-run.ts`, `src/pi/sdk/prompt-writer.ts`, `src/chat/reply/generate.ts` |

## Conséquence assumée

`chat.remoteAgents` reste **`desactive` par défaut** (`src/config/schema.ts`). Sous ce
défaut, `delegate` **n'existe pas** en canal : une action longue est donc **refusée**
et le refus **le dit** (il ne renvoie pas vers un outil absent). **Sans
`chat.remoteAgents = actives`, la délégation est impossible en canal — et donc la
génération d'image aussi.**

## Non vérifiable ici

- La latence réelle d'un job (worker lourd, ComfyUI) : mesurée hors de ce dépôt.
- Le rendu Mattermost/Discord réel des pièces jointes (bornes d'instance :
  `chat.discord.maxUploadBytes`, `MM_MAX_UPLOAD_BYTES`) : seules les requêtes sont
  vérifiées (fixtures HTTP).
