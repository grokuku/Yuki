# Lot 28 — envois programmés (`programmer_envoi`)

Demande (production, 2026-11-04 15:54) : « j'aimerais que tu fasses une image… et que
tu la postes à 16h10 dans l'Imagerie » — réponse de Yuki : « je ne peux pas la
programmer : je n'ai pas de minuteur ». C'était exact pour elle : le planificateur
existe depuis le lot 2 (`src/sources/scheduler.ts`), aucun outil ne le lui donnait.

## Ce qui existe maintenant

Un envoi programmé est un **texte figé** (et d'éventuels fichiers du store) publié à un
instant donné dans une conversation résolue à la programmation. **Aucun modèle n'est
appelé à l'heure dite, aucune machine n'est touchée.**

| Élément | Où |
|---|---|
| Bornes et vocabulaire (20 en attente, 30 j, 30 s, rattrapage 1 h) | `src/chat/envois/types.ts:37,46,56,68` |
| Interprétation de `quand` (délai relatif, ISO, `16:10`) | `src/chat/envois/quand.ts:94` |
| Persistance `envois-programmes.json` (atomique, 0600) | `src/chat/envois/store.ts:66` |
| Validation, programmation, annulation, exécution des dus | `src/chat/envois/service.ts:172,197,336,380` |
| Outil `programmer_envoi` | `src/pi/sdk/scheduled-send-tool.ts:116` |
| Câblage local et canal | `src/index.ts:1550,1597,2625` ; `src/pi/sdk-host.ts` (`PiHostOptions.envoisProgrammes`) |
| Exécution par le **balayeur existant** | `src/sources/scheduler.ts:230` |
| Politique : `toujours`, **léger seulement** | `src/llm/tool-policy.ts:445` / `:489` |
| Journal (4 événements + champ `envoi`) | `src/sources/journal.ts` (`envoi_programme`, `envoi_publie`, `envoi_annule`, `envoi_echec`) |
| API de gestion (lecture gardée + annulation) | `src/gateway/routes/sources.ts:402,635` |
| Volet « Envois programmés » | `public/ui/sources-panel.js:1485` ; `public/ui/declencheurs-vue.js:95` |
| Prompts (anti-minuteur inventé) | `config/pi/system-prompt.md:87` ; `src/chat/reply/prompt.ts:94` |

## Les décisions, et pourquoi

1. **Aucun second ordonnanceur.** `executerDus` est appelé au début du `tick` du
   `DeclencheurBalayeur` (`src/sources/scheduler.ts:230`), donc un seul `setInterval`
   (30 s) dans le processus : un seul rythme, un seul arrêt à gérer, aucun risque de
   double publication à la reprise. Un envoi en échec n'interrompt pas le balayage.

2. **Le texte est figé — pas un tour différé.** Le service n'appelle jamais le modèle
   (`src/chat/envois/service.ts:380`). Conséquence voulue : gratuit, déterministe, et
   le message ne peut pas dire autre chose que ce qui a été confirmé.

3. **Même chemin de publication que les autres messages.** En canal :
   `createChannelPostPort` → `envoyerDansCanal` → `adapter.send`, donc la file
   **par conversation** (`ConversationSendQueue`, `src/chat/reply/send-queue.ts:22`) —
   le même point d'étranglement que `publier_dans_canal`. En local :
   `PiHost.publierMessage`, la fonction exacte de `envoyer_message` local
   (`src/pi/sdk-host.ts:2509`). ⚠️ Il n'y a **pas** de `ReplyProgress` à l'heure dite :
   elle appartient à un tour, et aucun tour n'existe. C'est la file de l'adaptateur qui
   porte l'ordre et la sérialisation.

4. **Rien n'est perdu en silence.** Une cible disparue (canal quitté, fil supprimé,
   session supprimée) est un `echoue` **persisté avec sa raison** ET journalisé
   (`envoi_echec`). Un envoi manqué de plus d'une heure n'est pas publié en retard : il
   est marqué échoué avec sa raison (`RATTRAPAGE_MAX_ENVOI_MS`). Un `en_cours` retrouvé
   au démarrage (arrêt brutal) n'est **jamais rejoué** — un doublon est pire qu'un
   manque annoncé.

5. **Visible et annulable.** Le volet de la page de gestion liste tout (attente puis
   terminés), avec le texte, la destination, l'état, la raison d'un échec, et le bouton
   « Annuler » seulement sur l'attente. `DELETE /api/sources/envois/<id>` refuse (409)
   un envoi déjà parti. Confirmation par `HolafModal`, aucun `innerHTML`.

6. **Un seul rédacteur.** L'outil est dans le groupe `toujours` et dans
   `TOOL_POLICY.light` seulement ; `TOOL_POLICY.heavy.envoisProgrammes = []` et le
   worker lourd ne reçoit pas le port. Programmer une publication est un acte de
   rédacteur, comme `envoyer_message`.

7. **Validation des fichiers À LA PROGRAMMATION.** À l'heure dite il n'y a plus de run
   pour vérifier la propriété d'un fichier : `validerFichiers` (la fonction partagée
   avec `publier_dans_canal`) est donc appelée au moment de la programmation
   (`src/chat/reply/channel-post.ts`, exportée pour ce lot). Les pièces jointes ne
   partent que vers un **canal** (aucun envoi de fichier dans une session locale).

8. **Le fuseau n'est jamais celui du processus.** `16:10` est interprété en
   `Europe/Paris` (même outillage que les déclencheurs, `src/sources/cron.ts`) et
   l'instant **effectif** est rendu au modèle avec son fuseau.

## Bornes (annoncées au modèle, tenues par le port)

| Borne | Valeur | Refus |
|---|---|---|
| Envois en **attente** | 20 | nomme le plafond et la page de gestion |
| Horizon | 30 jours | « horizon maximal » + la valeur demandée |
| Délai minimal | 30 s | renvoie vers `envoyer_message` pour un envoi immédiat |
| Date passée | refusée | « cette heure est déjà passée » |
| Texte vide | refusé | « le message est vide » |
| Pièces jointes hors canal | refusées | « les pièces jointes ne partent que dans un CANAL » |

## Preuve d'échec

`git show HEAD:` ne suffit pas (plusieurs lots antérieurs ne sont pas commités) : copie
de l'arbre dans `/tmp` (tar sans `.git`/`node_modules`), puis neutralisation **par
script** des quatre points de câblage (hook du balayeur, ligne de `TOOL_POLICY.light`,
route `/envois`, montage du volet). Résultat : **8 tests sur 45 échouent**
(`tests/chat/envois-programmes.test.ts`, `tests/ui/envois-programmes-page.test.ts`),
dont le balayeur (⑨), l'invariant « un seul rédacteur » (⑧), les trois tests d'API et
le montage du volet.

## Ce qui reste invérifiable ici

- La réception réelle par Mattermost/Discord d'un message parti par le balayeur : les
  tests captent la requête (`file_ids`/multipart via `adapter.send`), pas le réseau.
- Le passage réel de l'horloge (30 s de balayage en production) : le temps est injecté.
