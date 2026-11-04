# Lot 27 — réponses en plusieurs messages (`envoyer_message`)

Demande : « est-ce que Yuki saura faire des réponses étalées sur plusieurs messages ?
(PI jusqu'à la 20ᵉ décimale, avec une décimale par message) » — « l'idée n'est pas de
timer chaque réponse, mais de les enchaîner automatiquement » — « je préfère l'appel
d'outil, même si c'est plus coûteux. C'est plus élégant. »

## Ce qui existe maintenant

Un outil, `envoyer_message(texte)` : chaque appel publie **un** message **pendant** le
tour (aucun minuteur, aucun second tour). Le nom dit ce qu'il fait.

| Élément | Où |
|---|---|
| Définition de l'outil (plafond 20, refus vides, résultat court) | `src/pi/sdk/send-message-tool.ts` |
| Port « conversation courante » + bornes de plateforme | `src/chat/reply/message-send.ts` |
| Bornes partagées avec `publier_dans_canal` | `src/chat/reply/channel-post.ts` (`couperPourPlateforme`) |
| File sérialisée + drapeau « j'ai déjà parlé » | `src/chat/reply/progress.ts` (`envoyerTexte`, `retirerMessagesEnvoyes`) |
| Nettoyage de la réponse finale | `src/chat/reply/generate.ts` |
| Run de canal | `src/pi/sdk/remote-run-tools.ts`, `src/pi/chat-run.ts`, `src/index.ts` |
| Fil « Déclencheurs » / local | `src/pi/sdk-host.ts` (`publierDansSession`, même chemin que `publierMessage`) |
| Politique (groupe `toujours`, absent du lourd) | `src/llm/tool-policy.ts` |
| Consigne de canal | `src/chat/reply/prompt.ts` (`CHAT_REPLY_SYSTEM_PROMPT`) |

## Les décisions, et pourquoi

1. **Un seul chemin de publication.** L'outil n'écrit jamais lui-même : en canal il
   publie par `ReplyProgress.envoyerTexte` (même file qu'un seul `send` en vol, même
   ancrage `root_id`/`message_reference`) ; en local par `publierDansSession`, la
   fonction déjà utilisée pour publier un résultat de déclencheur. Aucune seconde file,
   aucun second ordre.

2. **La réponse finale ne répète pas — drapeau, pas « ne rien faire ».** C'est le même
   piège que le double accusé, en plus grand : un modèle qui vient d'étaler 20 messages
   a tendance à redonner l'ensemble. La redite est donc traitée : `ReplyProgress`
   retient ce qui est **réellement parti**, et `generate.ts` retire du texte final les
   **lignes** dont la forme normalisée est celle d'un message déjà envoyé. S'il ne reste
   rien, la réponse finale est vide et rien n'est publié (l'adaptateur sait qu'un tour
   qui a déjà publié n'a pas besoin d'un second texte). Un envoi **en échec** n'est pas
   retenu : le texte reste dans la réponse finale au lieu d'être perdu.

3. **Plafond = 20 messages par tour, refus explicite.** Vingt est le cas d'usage mesuré
   (l'exemple PI) ; au-delà, l'outil répond « maximum de 20 messages pour ce tour » et
   n'envoie rien. Jamais une troncature muette. Le compteur vit dans l'instance d'outil,
   donc il repart à zéro au tour suivant.

4. **Un texte vide est refusé** (aucune bulle vide), et **les bornes de la plateforme
   sont celles de `publier_dans_canal`** (Mattermost 16 383 / Discord 2 000, troncature
   **dite** dans le message publié ET dans le résultat de l'outil).

5. **Le fil « Déclencheurs » et le mode local ont l'outil.** Le fil « Déclencheurs »
   n'est pas un canal : c'est une session **locale** du host Pi, réveillée par les
   sources. Sans l'outil en local, une réponse étalée y serait impossible. L'interface
   affiche un message par bulle : l'ordre reste naturel (messages de l'outil pendant le
   tour, réponse finale ensuite). Le worker lourd, lui, ne l'a pas : invariant « un seul
   rédacteur ».

6. **Groupe `toujours`.** Envoyer un message ne touche aucune machine : l'outil ne
   dépend ni de `chat.remoteAgents` ni de `chat.remoteTools`, et il ne demande aucune
   approbation.

## Tests

- `tests/chat/envoyer-message.test.ts` — 20 appels ⇒ 20 publications **dans l'ordre** ;
  la réponse finale ne répète pas ; 10 appels parallèles ⇒ **aucun `send` simultané** ;
  21ᵉ refusé ; texte vide refusé ; troncature dite ; résultat sans le texte ; politique
  (groupe, absent du lourd).
- `tests/pi/sdk-host-envoyer-message.test.ts` — fil « Déclencheurs » : le runtime local
  reçoit l'outil, un appel = un message assistant persisté + transcript + trames.
- Garde étendue : `tests/pi/worker-sans-publication.test.ts`.

Preuve d'échec sur l'origine : arbre copié dans `/tmp/preuve27` (le dépôt a des lots
antérieurs NON commités, donc `git show HEAD:` ne représente pas l'état d'avant ce lot),
puis câblage retiré (outil non construit en canal ni en local, pas de nettoyage de la
réponse finale, pas de groupe `toujours`) ⇒ **14/14 tests nouveaux en échec**.

## Ce qui reste invérifiable ici

- La façon dont le **modèle** décide réellement d'étaler sa réponse (qualité du prompt) :
  vérifiable seulement avec un vrai modèle et une vraie conversation.
- Le rendu visuel exact côté interface web pendant qu'un tour streame : les messages de
  l'outil ouvrent leur propre bulle (`run_started` → `delta` → `run_finished`), la
  réponse finale continue dans une autre ; aucun test de navigateur ne le couvre.
- Discord en conditions réelles : le code passe par la même abstraction que Mattermost
  et les mêmes bornes, mais seuls les tests unitaires l'exercent.
