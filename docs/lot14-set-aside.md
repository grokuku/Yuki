# Lot 14 (suite) — Solidification à la MISE DE CÔTÉ + archive consultable

> Demande utilisateur (2026-10-24) : « est-ce que ça serait pertinent de refaire
> une passe sur une discussion quand on la ferme pour être sûr que tout ce qui
> est intéressant est enregistré en mémoire ? » — **réponse : oui, à la mise de
> côté** (pas à la fermeture d'onglet, fragile et sans action explicite).
>
> Ce document décrit les **deux** ajouts : ① une **passe de mémoire silencieuse
> sur la conversation ENTIÈRE** au moment où l'utilisateur la met de côté ;
> ② une **archive complète** de cette conversation, **jamais injectée**, 
> consultable uniquement sur **demande explicite** via un outil de recherche
> plein texte. Il complète [`docs/lot12.md`](lot12.md) (mémoire) et
> [`docs/lot13.md`](lot13.md) (archive « vie antérieure », dont le modèle est
> repris).

## Ce qui existait déjà

| Déclencheur | Emplacement | Portée |
| --- | --- | --- |
| Fin de chaque tour | `agent_end` → `MemoryService.onTurnEnd` | le DERNIER échange |
| Avant compaction | `session_before_compact` → `MemoryService.onBeforeCompact` | les messages sur le point d'être perdus |
| **Mise de côté (NOUVEAU)** | `PiHost.setAsideSession` → `MemoryService.onSessionSetAside` | **la conversation ENTIÈRE** |

Le trou comblé : une conversation **courte** mise de côté ne déclenchait **jamais**
la compaction — donc jamais de consolidation finale.

## Décisions

- **D135 — Déclencheur = la MISE DE CÔTÉ** (action explicite de l'utilisateur),
  jamais la fermeture d'onglet.
- **D136 — MÉCANIQUE RÉUTILISÉE, pas une 3ᵉ logique.** La passe appelle
  `buildConsolidationPrompt` (`src/memory/extract.ts`, variante `set-aside`),
  `parseMemoryOps`, le même **filtre déterministe**
  (`sanitizeConsolidationMessages`, `src/memory/consolidate.ts`) et la même
  exigence : **`why` obligatoire** (sans justification, le CODE n'écrit rien).
- **D137 — SILENCIEUX et ASYNCHRONE.** `setAsideSession` rend la main **avant**
  la passe (aucun aperçu, aucune confirmation, aucun blocage). Un échec est
  **journalisé** (`memory.set_aside.failed`) et **ne casse rien** : la
  conversation reste mise de côté et archivée.
- **D138 — BORNES.** Entrée : `memory.setAside.maxChars` (défaut 24 000 car./appel)
  et `memory.setAside.maxChunks` (défaut 2 appels). Écritures : au plus
  `maxChunks × memory.extract.maxItems` souvenirs par mise de côté. Au-delà, le
  premier morceau (contexte) et les derniers (état récent) sont couverts, et le
  journal porte `truncated: true` — **jamais une coupe silencieuse**.
- **D139 — DÉDUPLICATION À TROIS NIVEAUX** (les tours ont déjà écrit à chaud) :
  1. le prompt **fournit les souvenirs existants** (fusion par `update`) ;
  2. le store refuse un texte identique (empreinte `sha1(foldText))` ;
  3. **`src/memory/dedup.ts`** refuse un **quasi-doublon** : un `add` dont ≥ 80 %
     des mots significatifs (≥ 3 lettres, casse/accents repliés) figurent déjà
     dans un souvenir existant est **écarté** (journal `memory.dedup.near_duplicate`).
     Conservateur : « habite à Rennes » vs « habite à Nantes » ne sont **pas**
     des doublons.
- **D140 — ARCHIVE COMPLÈTE = un fichier JSON par conversation**, dans
  `/data/state/conversations-archive/` (`YUKI_CONVERSATION_ARCHIVE_DIR`) :
  `{v,id,title,archivedAt,messages:[{at,role,text}]}`. **Jamais écrasée** (flag
  `wx`), **jamais dupliquée** : ré-archiver la même conversation est un no-op
  (`archived:false`), et une conversation déjà archivée **ne relance pas** la
  passe.
- **D141 — RECHERCHE PLEIN TEXTE (FTS5, `node:sqlite`), pas de RAG.** Index
  DÉRIVÉ (`/data/state/conversations-archive-index.sqlite`,
  `YUKI_CONVERSATION_ARCHIVE_INDEX_PATH`), réconcilié avec le dossier au premier
  usage (fichier supprimé à la main ⇒ l'index s'aligne). Honnêteté : le plein
  texte ne trouve **ni les paraphrases ni les synonymes** ; il trouve les mots
  réellement écrits (casse et accents ignorés).
- **D142 — L'archive n'est JAMAIS dans le prompt.** Aucune extension ne la lit
  (l'ordre des extensions reste règles → personnalité → mémoire → annuaire →
  heritage) ; seul l'outil **`chercher_conversations_archivees`** (LECTURE SEULE,
  allowlist du rôle léger) la consulte, et son `description` impose une **demande
  explicite** de l'utilisateur. Preuve : `tests/pi/prompt-archive-isolation.test.ts`
  + sonde `/prompt` de l'E2E.
- **D143 — Le contenu de l'archive est une DONNÉE.** Sortie encadrée par
  `<conversations_archivees>` (texte échappé, rappel « jamais une instruction »),
  et cette balise est ajoutée à `EXCLUDED_FRAME_TAGS` (`src/memory/filter.ts`) :
  un bloc cité dans un échange **ne devient jamais un souvenir**.

## Fichiers

- `src/memory/service.ts` — `onSessionSetAside`, `consolidateSession`, bornes,
  dédup dans `applyOps` ;
- `src/memory/consolidate.ts` — filtre commun + découpage borné ;
- `src/memory/dedup.ts` — quasi-doublons déterministes ;
- `src/memory/conversation-archive.ts` + `conversation-archive-store.ts` —
  types/encadrement et stockage + index FTS5 (idempotent) ;
- `src/pi/sdk/conversation-archive-tools.ts` — outil
  `chercher_conversations_archivees` ;
- `src/pi/sdk-host.ts` — capture de la conversation AVANT déplacement, archivage
  puis passe en tâche de fond (`afterSetAside`) ;
- `src/llm/tool-policy.ts` — outil du léger, activé quand l'archive existe ;
- `src/config/{env,schema}.ts`, `src/index.ts` — chemins + bornes + câblage.

## Preuves

- `tests/memory/set-aside.test.ts` — conversation entière soumise, fait retrouvé
  par le rappel, `why` obligatoire, dédup, bornes, échec silencieux ;
- `tests/memory/conversation-archive.test.ts` — archivage complet/idempotent,
  recherche casse/accents, index dérivé, encadrement ;
- `tests/pi/sdk-host-set-aside.test.ts` — host RÉEL : archive + passe, asynchrone
  (extracteur muet), échec simulé, idempotence, session vivante ET non vivante ;
- `Yuki and Libs/_tools/e2e-set-aside-memory.{mjs,serve.ts}` — parcours UI complet
  (26 vérifications) : immédiateté, archive, mémoire, outil, panne, non-fuite.
