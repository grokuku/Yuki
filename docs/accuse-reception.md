# Accusé de réception — « je m'en occupe »

> Une ligne de **statut**, courte et humaine, au moment où Yuki lance une action
> qui ne rendra pas la main tout de suite. Ce n'est **pas** une réponse : le fond
> arrive ensuite.

## Qui écrit la phrase : LE MODÈLE (plus de texte figé)

⚠️ **Le texte de l'accusé est écrit par le modèle** : c'est le **premier texte de
son tour**, puis il appelle l'outil **dans le même message**. Le code ne fait que
**reconnaître** ce texte quand une action longue démarre — il ne le fabrique plus.

Pourquoi : un libellé figé (« C'est parti. » pour chaque image, « Je m'en occupe. »
pour chaque délégation) devient mécanique et répétitif à l'usage.

- **Consigne** : `ACK_RULE` (`src/pi/ack.ts`), injectée au prompt système de chaque
  tour par `src/pi/sdk/ack-extension.ts` (mécanisme NON persisté, comme la mémoire
  et l'annuaire). Une phrase courte, française, ton humain, **variée**, qui annonce
  l'**intention** et jamais la promesse d'un résultat.
- **Reconnaissance** : `ackShapedText` (`src/pi/ack.ts`) — le texte est un accusé
  s'il tient sur **une ligne** et fait **au plus `ACK_MAX_CHARS` = 90 caractères**.
  Au-delà (PIÈGE ⑥, le modèle écrit un pavé) ce n'est pas un accusé : le texte part
  comme contenu ordinaire.
- **ZÉRO appel modèle supplémentaire** : l'accusé est le tour lui-même. La latence
  du premier mot est celle du modèle (≈ 650 ms), ce qui est accepté.

## Le critère : L'ACTION, jamais une prédiction

⚠️ La décision reste un **test de forme** sur un texte déjà produit — « une action
longue démarre-t-elle dans ce message ? » — et **rien d'autre**. Aucune estimation
(longueur probable, nombre de tokens, temps restant) n'est faite : elle coûterait
du TTFT et se tromperait.

| L'action qui démarre | Où c'est détecté | Accusé |
| --- | --- | --- |
| une **DÉLÉGATION** | `message_end` du message qui appelle `delegate` | ✅ texte du modèle (repli : « Je m'en occupe. ») |
| une **GÉNÉRATION D'IMAGE** | `message_end` du message qui appelle `generer_image` | ✅ texte du modèle (repli : « C'est parti. ») |
| une **COMMANDE envoyée à un agent** | `message_end` du message qui appelle `run_command` | ✅ texte du modèle (repli : « C'est parti. ») |
| une question simple / une réponse immédiate | aucun outil d'action | ❌ rien |
| un outil de lecture (recherche, libraire, liste…) | `message_end` d'un autre outil | ❌ rien |

Règle : `src/pi/ack.ts` (`ACK_TOOLS`, `isAckTool`, `ackShapedText`,
`ackFallbackText`, `firstAckToolCall`, `ACK_RULE`). Décision :
`src/pi/sdk-host.ts` (`maybeAcknowledge`, appelé depuis `case "message_end"`).

## Le texte est RETENU pendant le flux (et pourquoi)

Le début d'un message assistant est **retenu** (`ackHoldMustRelease`) au lieu
d'être émis comme contenu, tant qu'il peut être un accusé :

- s'il s'avère que c'est un accusé (le message porte l'appel d'outil), il part dans
  une trame `ack` — **jamais** un `delta` de contenu. C'est ce qui garantit qu'il
  n'est **ni prononcé** par la synthèse vocale, **ni** recopié dans le corps de la
  réponse, **ni** dans le texte du message ;
- sinon (pas d'outil d'action, ou texte trop long / multiligne) il est **relâché
  tel quel** comme contenu, sans perte.

Coût assumé et borné : le premier texte d'une réponse ordinaire n'apparaît qu'après
au plus `ACK_MAX_CHARS` (90) caractères de flux — donc jamais tout un paragraphe.
Un texte qui dépasse la borne est relâché **immédiatement**, sans attendre la fin
du message.

## Pas de doublon

- **le run a déjà parlé** (du contenu a été émis dans ce run) ⇒ aucun accusé ;
- **un accusé est déjà parti pour ce run** ⇒ aucun second : deux outils longs dans
  le même tour ne produisent qu'une ligne ;
- le texte de l'accusé **n'est jamais concaténé** au corps affiché.

## Le repli en dur, avec VARIATIONS

Si le modèle va **droit à l'outil** sans rien écrire, le repli parle :
`ACK_FALLBACK_TEXTS` (`src/pi/ack.ts`), plusieurs phrases par outil.

**Mécanisme : rotation déterministe**, index incrémenté à chaque repli de la
conversation. Justification : reproductible en test (aucun aléa, aucun *flake*),
deux replis consécutifs ne disent **jamais** la même phrase, et toutes les variantes
finissent par passer. `Math.random()` a été écarté : non reproductible, et rien ne
garantit qu'il ne tire pas deux fois la même phrase.

**Mesure du taux de repli** : chaque `ack` porte son origine (`source: "model"` /
`"fallback"`), journalisée (`pi.ack`) et exposée dans le DOM (`data-ack-source`).
⚠️ Si le taux de repli dépasse ~20 % en production, c'est la **consigne du prompt**
qu'il faut renforcer, pas le repli qu'il faut multiplier.

## Un MESSAGE À PART ENTIÈRE (et l'ordre du fil)

L'accusé **ouvre sa propre bulle** : même fond, même texte, même heure qu'une
réponse — **ni italique, ni taille réduite, ni gris d'annotation**. Ce n'est pas un
détail cosmétique : il n'est pas une *note sur* la réponse, c'est le **premier
message du tour**.

Conséquence directe, l'ordre du fil devient celui de l'action elle-même :

```
① bulle d'ACCUSÉ        « C'est parti. »
② CARTE IMAGE           la vignette que l'action vient de produire
③ bulle de RÉPONSE      le texte final
```

Le SDK émet `message_end` du message assistant **avant** `tool_execution_start`
(voir `agent-loop.js` : le streaming se termine, puis les outils sont exécutés). La
décision est prise à `message_end`, donc :

- l'accusé précède l'exécution de l'outil (le corps du tool n'a pas commencé) ;
- il précède les trames produites par l'action (`job_started`, `image`, …) ;
- il est versé au **transcript** comme une entrée à part entière (donc une bulle,
  avec son horodatage), et le corps du run ouvre la bulle **suivante**.

⚠️ **La même chose après un rechargement.** Les médias conservés (images, captures)
sont ré-émis **après** le snapshot : ils retrouvent leur place **chronologique**
(`createdAt` / `capturedAt` comparés aux horodatages des messages, voir
`chronologicalAnchor` dans `public/ui/app.js`) au lieu de s'empiler à la fin du fil
— le défaut corrigé (« tous les messages en haut, toutes les images en bas »).

Preuves mesurées :
- `tests/pi/sdk-host-ack.test.ts` (ordre réel dans le VRAI host) ;
- `tests/pi/events.test.ts` (restitution : **deux** entrées, dans l'ordre) ;
- `_tools/e2e-ack.mjs` (navigateur) : ordre ACCUSÉ → IMAGE → IMAGE → CAPTURE →
  RÉPONSE mesuré **en direct ET après rechargement**, style calculé de l'accusé
  (`font-style: normal`, même taille et même couleur que la réponse), horodatage,
  séparateur de 22 px entre deux messages d'assistant consécutifs.

## Transport : trame de CONTRÔLE, éphémère et MUETTE

`ack` est une trame de **contrôle** (aucun `seq` consommé, jamais bufferisée) :
elle n'entre jamais dans le rejeu ni dans le snapshot, et elle n'est **jamais
prononcée**.

**Décision TTS : l'accusé n'est PAS prononcé.** C'est une ligne de **statut**, pas
une phrase de la réponse ; le moteur ne reçoit que les `delta` de contenu (canal
`content`), et le texte de l'accusé n'en est jamais un — c'est structurel, pas une
exclusion a posteriori. Prononcer « je m'en occupe » puis le résultat doublerait la
voix avec un texte qui n'apporte rien.

## Persistance (survit au rechargement)

- l'accusé est une **entrée de transcript à part entière** (`TranscriptEntry.ack`,
  `text` vide) et il est écrit dans le JSONL de session (`yuki.run_ack`, données
  `{tool, text}`) : il revient **à l'identique** après un rechargement, y compris
  après un redémarrage, **dans sa propre bulle et à sa place** ;
- le message du modèle qui **n'était que l'accusé** ne produit pas de bulle de
  corps : l'auteur de la restitution (`transcriptFromEntries`) le reconnaît par
  **égalité stricte** avec le texte persisté (jamais « ça a l'air court ») ;
- aucune action (réaction, statistiques) n'est attachée à la bulle d'accusé quand
  une réponse suit : la corrélation reste sur la **réponse** ;
- ⚠️ **Pas un souvenir** : l'extracteur de mémoire écarte le préambule d'accusé
   d'un message qui appelle un outil (`src/pi/sdk/memory-extension.ts`), et une
  entrée `custom` n'est jamais relue par le modèle.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `src/pi/ack.ts` | déclencheurs, borne, forme, replis (variations), consigne de prompt |
| `src/pi/sdk/ack-extension.ts` | injection de `ACK_RULE` au prompt système du tour |
| `src/pi/sdk-host.ts` | retenue du texte, décision à `message_end`, émission de la trame |
| `src/pi/sdk/memory-extension.ts` | exclusion de l'accusé de la mémoire durable |
| `src/pi/types.ts` | événement `PiEvent` de type `ack` (avec son origine) |
| `src/gateway/ws/protocol.ts` | trame serveur `ack` (contrôle) |
| `src/gateway/ws/server.ts` | routage en trame de contrôle, **avant** `streams.append` et **avant** `routeTtsEvent` |
| `src/pi/events.ts` | persistance (`run_ack`) et restitution (entrée d'accusé + entrée de réponse, dans l'ordre) |
| `public/ui/ack-block.js` | contenu de la bulle d'accusé (`role="status"`, nœud texte) |
| `public/ui/app.js` | branche `ack` (avant le curseur `seq`) → **sa propre bulle** ; insertion **chronologique** des médias (`chronologicalAnchor`) |
| `public/ui/image-block.js`, `public/ui/screenshot-block.js` | point d'insertion (`before`) + anti-doublon |
| `public/ui/styles.css` | `.ack-block` = rendu d'un message ordinaire (aucun style spécial) |
| `tests/pi/ack.test.ts` | déclencheurs, forme, bornes, variations du repli, consigne |
| `tests/pi/sdk-host-ack.test.ts` | décision réelle du host, retenue, ordre, repli |
| `tests/pi/sdk-host-ack-persist.test.ts` | persistance et restitution à l'identique |
| `tests/pi/memory-extension.test.ts` | l'accusé n'est jamais mémorisé |
| `tests/gateway/ws/ack.test.ts` | trame de contrôle (aucun `seq`), routage, non-prononciation |
| `tests/ui/ack-block.test.ts` | garde-fous du bloc et de son câblage |
| `_tools/e2e-ack.mjs` (+ `e2e-ack-serve.ts`) | preuves navigateur : texte du modèle, deux formulations, ordre ACCUSÉ → MÉDIAS → RÉPONSE (en direct et après rechargement), style d'un message normal, horodatage, séparateur, repli, jamais prononcé |
