# Accusé de réception — « je m'en occupe »

> Une ligne de **statut**, courte et humaine, au moment où Yuki lance une action
> qui ne rendra pas la main tout de suite. Ce n'est **pas** une réponse : le fond
> arrive ensuite.

## Le critère : L'ACTION, jamais une prédiction

⚠️ La décision est un **test booléen** — « une action vient-elle de démarrer ? » —
et **rien d'autre**. Aucune estimation (longueur probable, nombre de tokens,
temps restant) n'est faite : elle coûterait du TTFT et se tromperait. C'est ce qui
rend l'accusé **instantané**.

| L'action qui démarre | Où c'est détecté | Accusé |
| --- | --- | --- |
| une **DÉLÉGATION** | `tool_execution_start` de `delegate` | ✅ « Je m'en occupe. » |
| une **GÉNÉRATION D'IMAGE** | `tool_execution_start` de `generer_image` | ✅ « C'est parti. » |
| une **COMMANDE envoyée à un agent** | `tool_execution_start` de `run_command` | ✅ « C'est parti. » |
| une question simple / une réponse immédiate | aucun outil d'action | ❌ rien |
| un outil de lecture (recherche, libraire, liste…) | `tool_execution_start` d'un autre outil | ❌ rien |

Règle de décision : `src/pi/ack.ts` (`ACK_TOOLS`, `ackTextForTool`,
`shouldAcknowledge`). Détection : `src/pi/sdk-host.ts` (branche
`case "tool_execution_start"`).

## Pas de doublon

Deux faits suffisent, tous deux lus en O(1) :

- **le run a déjà dit quelque chose** (texte partiel du message en cours, ou
  message assistant déjà complet) ⇒ aucun accusé : elle a répondu, ou elle a
  elle-même dit « je m'en occupe » (la règle `DELEGATION_RULE` du prompt le
  demande) ;
- **un accusé est déjà parti pour ce run** ⇒ aucun second : deux outils longs dans
  le même tour ne produisent qu'une ligne.

## Ordre garanti : l'accusé AVANT l'action

Le SDK émet `tool_execution_start` **juste avant d'exécuter l'outil**. L'accusé est
émis **synchroniquement** dans ce gestionnaire, donc :

- il précède l'exécution de l'outil (le corps du tool n'a pas commencé) ;
- il précède les trames produites par l'action (`job_started`, `image`, …) ;
- côté interface il est inséré **juste avant** la bulle assistant encore vide du
  run : il reste donc **au-dessus** de la réponse et de l'image qui suivent.

Preuves : `tests/pi/sdk-host-ack.test.ts` (ordre mesuré dans le VRAI host : un
marqueur est posé juste après le retour de l'émission de `tool_execution_start`,
et l'accusé doit le précéder) et `_tools/e2e-ack.mjs` (ordre mesuré dans le
navigateur par `MutationObserver` + horodatages `performance.now()`).

## Aucun surcoût au TTFT

- L'accusé est émis **après** la réponse du modèle (au démarrage de l'outil) : le
  premier token est déjà acquis, il ne peut pas le décaler ;
- il ne déclenche **aucun** appel modèle supplémentaire et ne fait **aucune** E/S :
  un test booléen et l'émission d'une trame ;
- mesure E2E : même délai de premier token dans les deux tours, TTFT identique
  (écart observé ≈ 2 ms, dans le bruit de mesure).

## Transport : trame de CONTRÔLE, éphémère et MUETTE

`ack` est une trame de **contrôle** (aucun `seq` consommé, jamais bufferisée) :
elle n'entre donc **jamais** dans le rejeu, le snapshot, le transcript ou la
mémoire, et elle n'est **jamais prononcée**.

**Décision TTS** : l'accusé n'est **pas** prononcé. C'est une trame de **statut**,
pas une phrase de la réponse ; le moteur ne reçoit que les `delta` de contenu
(canal `content`). Prononcer « je m'en occupe » doublerait la voix avec un texte
qui n'apporte rien, juste avant le vrai contenu.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `src/pi/ack.ts` | liste fermée des déclencheurs, libellés, décision booléenne |
| `src/pi/sdk-host.ts` | détection de `tool_execution_start` (avant l'action) |
| `src/pi/types.ts` | événement `PiEvent` de type `ack` |
| `src/gateway/ws/protocol.ts` | trame serveur `ack` (contrôle) |
| `src/gateway/ws/server.ts` | routage en trame de contrôle, **avant** `streams.append` et **avant** `routeTtsEvent` |
| `public/ui/ack-block.js` | ligne de statut (`role="status"`, nœud texte) |
| `public/ui/app.js` | branche `ack` (avant le curseur `seq`), insertion avant la bulle du run |
| `public/ui/styles.css` | `.ack-block` (discret, italique, plus petit qu'un message) |
| `tests/pi/ack.test.ts` | déclencheurs, absence de doublon, libellés |
| `tests/pi/sdk-host-ack.test.ts` | décision réelle du host, **ordre**, absence de surcoût |
| `tests/gateway/ws/ack.test.ts` | trame de contrôle (aucun `seq`), routage, non-prononciation |
| `tests/ui/ack-block.test.ts` | garde-fous du bloc et de son câblage |
| `_tools/e2e-ack.mjs` (+ `e2e-ack-serve.ts`) | preuve navigateur : aucun accusé sur une question simple, ordre mesuré, TTFT identique, jamais prononcé |
