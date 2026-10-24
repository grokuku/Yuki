# Lot 15 — « Supprimer définitivement » et « Compacter… » dans le menu du titre

> Demande utilisateur (2026-10-24) : « je veux bien un **vrai bouton SUPPRIMER**,
> non pas pour les trucs sensibles, mais pour les **discussions qui n'ont aucun
> intérêt**. Et j'aimerais un **bouton COMPACTER** en plus pour **forcer la
> compression** d'une conversation — **(ça serait bien que ça fasse une PASSE DE
> REMPLISSAGE DE MÉMOIRE AVANT de compresser)**. »
>
> Ce document complète [`docs/lot12.md`](lot12.md) (mémoire) et
> [`docs/lot14-set-aside.md`](lot14-set-aside.md) (passe de mémoire à la mise de
> côté, dont la mécanique est réutilisée).

## Réponse courte à la question qui décide : la compaction forcée EXISTE

Le moteur sait compacter **à la demande**. Vérifié dans le paquet installé :

| Élément | Emplacement |
| --- | --- |
| `AgentSession.compact(customInstructions?)` | `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` |
| Documentation SDK | `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` (« Compaction ») |
| Mode RPC équivalent | `…/docs/rpc.md` → `{"type": "compact"}` |
| Événements | `compaction_start` / `compaction_end` ; hook `session_before_compact` (`reason: "manual"`) |

C'est **le même chemin** que `/compact` : même découpage (`findCutPoint`), même
prompt de résumé, même entrée `CompactionEntry` dans le JSONL, même hook
d'extension. Ce n'est donc **pas une imitation** de compaction naturelle.

## ① Supprimer définitivement

- `PiHost.deleteSession(id)` : **arrêt du run en cours** et vidage de la file,
  fermeture du runtime, puis **effacement du fichier JSONL**. Aucune corbeille,
  aucune annulation.
- **La mémoire durable n'est jamais touchée** : aucune écriture, aucun souvenir
  supprimé. C'est vérifié par une assertion **octet pour octet** (SHA-256 du
  fichier de mémoire avant/après) dans `tests/pi/sdk-host-delete.test.ts` et dans
  l'E2E `_tools/e2e-session-actions.mjs`.
- **Confirmation obligatoire** via `HolafModal` : le **titre nomme la
  conversation** (« Supprimer définitivement « X » ? ») et le texte dit
  « c'est DÉFINITIF, aucune récupération possible, aucune corbeille » + « La
  mémoire durable n'est PAS touchée ». Le bouton de confirmation est nommé
  (« Supprimer définitivement »), pas un « OK » générique.
- **Périmètre** : les conversations **présentes dans la liste**. Une conversation
  mise de côté **en sort** (dossier `conversations-supprimees/`, `readdir` non
  récursif) : elle n'est plus sélectionnable, et aucun écran ne liste les
  archives — ce cas n'existe donc pas et n'a **pas** de logique dédiée.
- **Conversation ouverte supprimée** : le host n'a plus de conversation courante,
  le client reçoit un `snapshot` vide ⇒ **état vide**, comme après une mise de
  côté.
- **Run en cours** : **arrêté** avant l'effacement (sinon le SDK réécrirait le
  fichier supprimé : fil fantôme).

## ② Compacter (passe de mémoire AVANT)

- `PiHost.compactSession(id, { onProgress })` :
  1. **passe de remplissage de mémoire attendue** sur la conversation ENTIÈRE
     (`MemoryPort.onSessionCompact`, même mécanique que la mise de côté :
     `runSessionPass`, mêmes bornes, même filtre, même `why` obligatoire, même
     déduplication) — **l'ordre est prouvé** par les journaux
     (`pi.session.compact.memory.done` **avant** `pi.session.compact.begin`) et
     par le test d'intégration (le faux fournisseur n'a reçu **aucune** requête
     quand la passe se termine) ;
  2. arrêt du run en cours (la compaction a besoin de la main) ;
  3. `session.compact()` du moteur.
- **Si la passe de mémoire échoue, la compaction CONTINUE** et le compte rendu
  l'écrit noir sur blanc (« Passe de mémoire ÉCHOUÉE (…) : la compaction a quand
  même eu lieu »). Décision : on ne bloque pas l'action explicitement demandée
  pour un remplissage de mémoire ; on ne le cache pas non plus.
- **Conversation vide / trop courte** : refus **avant** toute passe, avec un
  message clair (« Cette conversation est vide ou trop courte : il n'y a rien à
  compacter. »). Les refus du moteur sont **traduits** : « trop courte », « déjà
  compactée », « interrompue », « aucun modèle utilisable », « la compaction a
  échoué : … ».
- **Progression visible** : trames de contrôle `compact_progress` (phase
  `memory` avec `part`/`parts`, puis `compact`), affichées par le **même écran
  d'attente** que « Conversation dédiée » (`HolafModal.busy`). Aucun second
  système d'attente.
- **Compte rendu honnête** (`compact_done`) : ce que la mémoire a réellement fait
  (écrit / inactive / sans extracteur / vide / échouée) + les mesures du moteur.
  ⚠️ `tokensBefore` et `tokensAfter` viennent de **deux estimations distinctes**
  du moteur : on n'annonce une « réduction » que si elle est constatée, sinon on
  dit « aucune économie constatée ».

## Contrat de transport

| Sens | Trame |
| --- | --- |
| client → serveur | `{ type: "delete", sessionId }` |
| client → serveur | `{ type: "compact", sessionId, requestId }` |
| serveur → client | `{ type: "compact_progress", requestId, phase, part?, parts? }` |
| serveur → client | `{ type: "compact_done", requestId, title, memory, tokensBefore, tokensAfter? }` |
| serveur → client | `{ type: "error", code, message, requestId? }` (échec corrélé) |

## Décisions

- **D144 — Suppression = effacement du fichier**, pas un déplacement. La mise de
  côté reste le geste récupérable ; les deux entrées du menu sont distinctes.
- **D145 — La mémoire n'est pas concernée par la suppression.** Aucun appel au
  port de mémoire : l'assertion porte sur les octets du fichier de mémoire.
- **D146 — Compaction forcée = `AgentSession.compact()`**, pas une
  réimplémentation ; on ne touche ni au découpage ni au prompt de résumé.
- **D147 — Passe de mémoire ATTENDUE avant compaction** (contrairement à la mise
  de côté, où elle est silencieuse) : c'est la demande explicite, et l'ordre doit
  être observable.
- **D148 — Échec de la passe non bloquant, mais DIT.** Jamais un succès muet.
- **D149 — Vérification amont du vide** (`COMPACT_MIN_MESSAGES`) : refus clair
  plutôt qu'un succès vide ; le moteur reste l'autorité sur « trop court ».
- **D150 — Une seule compaction à la fois** côté interface (une requête en
  attente à la fois, trames corrélées par `requestId`).

## Preuves

| Test | Ce qu'il prouve |
| --- | --- |
| `tests/pi/sdk-host-delete.test.ts` | fichier effacé, liste mise à jour, mémoire **identique octet pour octet**, état vide, run arrêté, cible inconnue refusée |
| `tests/pi/sdk-host-compact.test.ts` | ordre passe → compaction, échec non bloquant, refus du vide, aucun vol de focus, traduction des erreurs |
| `tests/integration/compact-session.test.ts` | **vrai SDK** + faux fournisseur : entrée `compaction` dans le JSONL, mesures du moteur, ordre prouvé |
| `tests/gateway/ws/session-actions.test.ts` | trames `delete` / `compact` / `compact_progress` / `compact_done` / `error` corrélée |
| `tests/ui/session-actions.test.ts` | libellés d'attente, comptes rendus honnêtes, corrélation, écran fermé avant le résultat |
| `tests/ui/sessions-panel.test.ts` | menu : « Supprimer » actif, confirmation nommée, garde-fou anti-neutralisation |
| `_tools/e2e-session-actions.mjs` | parcours réel (bureau + téléphone) : confirmation, annulation, suppression + fichier, mémoire intacte, compaction réelle, ordre, conversation vide, CSP/connexion/exceptions à 0 |
