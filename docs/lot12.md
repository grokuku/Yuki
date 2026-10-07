# Lot 12 — Mémoire durable automatique (écriture + rappel)

> Implémentation du **Lot 12 : mémoire durable de Yuki**, **entièrement
> automatique** (l'utilisateur ne clique rien, ne dit rien). Ce document résume
> les décisions, le **format du store**, le schéma de l'index, les **bornes** du
> rappel et ce qui reste à faire. Il complète [`docs/lot11.md`](lot11.md) et
> [`docs/architecture.md`](architecture.md).

## Objectif et décisions utilisateur (actées)

1. **Écriture automatique** : Yuki retient seule les préférences/faits durables.
2. **Rappel automatique** : le contexte utile est présent « en tête » avant
   chaque réponse, sans que l'utilisateur demande à chercher.
3. **Portée GLOBALE** (pas par projet).
4. **Pas de filtre à secrets** (choix explicite : ce qui est dit est mémorisable).
5. **Zéro dépendance ajoutée**, **zéro build UI**.

## Ancrages SDK **vérifiés** (Phase 0)

Références **réelles** dans `node_modules/@earendil-works/pi-coding-agent/dist/`
(version `0.85.1`) :

| Élément | Emplacement | Signature utile |
| --- | --- | --- |
| Extension inline | `core/resource-loader.d.ts:76` | `DefaultResourceLoaderOptions.extensionFactories?: InlineExtension[]` |
| `InlineExtension` | `core/extensions/types.d.ts:1160` | `ExtensionFactory \| { name; factory; hidden? }` |
| `before_agent_start` | `core/extensions/types.d.ts:539` | `{ prompt; systemPrompt; systemPromptOptions; images? }` |
| Résultat | `core/extensions/types.d.ts:845` | `{ message?: … (PERSISTÉ) ; systemPrompt?: string (par tour) }` |
| `session_before_compact` | `core/extensions/types.d.ts:442` | `{ preparation; … }` |
| `CompactionPreparation` | `core/compaction/compaction.d.ts:116` | `{ firstKeptEntryId; messagesToSummarize; turnPrefixMessages; isSplitTurn; tokensBefore; previousSummary?; … }` |
| `turn_end` | `core/extensions/types.d.ts:597` | `{ turnIndex; message; toolResults }` |
| `agent_end` | `core/extensions/types.d.ts:~583` | `{ messages }` |

**Écart avec l'énoncé** : aucun. `extensionFactories` est bien accepté par
`createAgentSessionServices` (`resourceLoaderOptions`) et donc par
`buildResourceLoaderOptions()` (`src/pi/sdk/session-factory.ts`). L'intégration
se fait **sans nouvelle dépendance ni build**.

## Décisions

- **D97 — Mécanisme d'injection = `systemPrompt` de tour, jamais `message`.**
  `before_agent_start` peut renvoyer `message` (⇒ `CustomMessageEntry` **persisté**
  dans la session, donc pollue le transcript) **ou** `systemPrompt` (« for this
  turn », non persisté). On renvoie **exclusivement `systemPrompt`** : le rappel
  n'est jamais une entrée de session, n'apparaît ni dans le transcript ni dans
  l'UI, et n'est pas rejoué au redémarrage. Prouvé par
  `tests/pi/memory-extension.test.ts`.
- **D98 — Store = JSONL append-only, édition étroite.** Une ligne = un événement
  (`add`/`update`/`delete`). Chaque écriture **n'ajoute qu'une ligne** : aucune
  réécriture globale (le piège documenté « un assistant a écrasé 1000 lignes de sa
  mémoire » est impossible par construction). Le fichier reste **lisible et
  corrigeable à la main**.
- **D99 — Source et date conservées.** Chaque entrée porte `source` (id du
  message d'origine, ou `compaction`) et `at`/`updatedAt` (ISO-8601).
- **D100 — Extraction par CHEMIN ISOLÉ.** L'extraction tourne dans une session
  **éphémère en mémoire** (`createEphemeralSession`, `SessionManager.inMemory`),
  comme le worker lourd. Le prompt d'extraction ne touche jamais la session de
  l'utilisateur (donc jamais son historique).
- **D101 — Double déclencheur.** Écriture à la **fin de tour** (`agent_end`, 0–N
  souvenirs) **et** à la **compaction** (`session_before_compact`, consolidation
  des messages sur le point d'être perdus). Motif : la compaction seule rate tout
  ce qui précède le seuil, et une conversation courte ne la déclenche jamais.
- **D102 — Index FTS5 `node:sqlite`, dérivé.** L'index est **reconstructible** à
  tout moment (source de vérité = JSONL). Absent/corrompu ⇒ reconstruit **en
  tâche de fond**, sans bloquer le démarrage (fichier corrompu supprimé puis
  recréé — c'est un dérivé).
- **D103 — Accents traités à l'indexation.** La colonne FTS contient
  `foldText(texte)` (minuscules, sans accents, espaces réduits) et la requête est
  construite par `buildMatchQuery` (même repli) ⇒ recherche **insensible aux
  accents et à la casse**. `tokenize='unicode61 remove_diacritics 2'` en
  ceinture-bretelles.
- **D104 — Bornes dures + dégradation gracieuse.** Le rappel est sur le chemin
  critique : `top-k` (défaut 5), budget en caractères (défaut 8000), timeout court
  (défaut 400 ms). Au-delà / mémoire indisponible ⇒ la réponse part **sans**
  mémoire, **sans erreur visible**.
- **D105 — Une panne d'extraction n'affecte jamais la conversation.** Erreur LLM,
  disque plein, extraction non-JSON : journalisées, silencieuses côté utilisateur.
- **D106 — Idempotence (dédup).** `MemoryStore.add` calcule une **empreinte**
  (`sha1(foldText)`) : ré-ajouter le même contenu (casse/accents/espaces près) est
  un **no-op**. Rejouer une extraction ne duplique pas.
- **D107 — Réglages en `enum|int` uniquement.** Le schéma ne connaît que
  `string | int | enum` : l'activation est un enum `off|on` (pas de booléen).
- **D108 — Emplacement.** Le store et l'index vivent sur le volume **`state`**
  déjà existant (`yuki-state` → `/data/state`) : `/data/state/memory.jsonl` et
  `/data/state/memory-index.sqlite`. **Aucun volume nouveau** n'est créé.

## Où vit le fichier de mémoire (promesse utilisateur)

- **Chemin** : `/data/state/memory.jsonl` (volume nommé `yuki-state`), surchargeable
  par `YUKI_MEMORY_STORE_PATH`. L'index dérivé est `/data/state/memory-index.sqlite`
  (`YUKI_MEMORY_INDEX_PATH`).
- **Lecture** : c'est du **texte** (une ligne JSON par événement, préfixé d'un
  en-tête commenté `#`). Ouvrez-le dans n'importe quel éditeur.
- **Correction à la main** :
  - corriger un souvenir : ajouter une ligne
    `{"v":1,"t":"update","id":"<id>","at":"<ISO>","text":"…","source":"…","cat":"fait"}` ;
  - supprimer un souvenir : ajouter une ligne
    `{"v":1,"t":"delete","id":"<id>","at":"<ISO>"}` (ou effacer sa ligne d'ajout) ;
  - l'index se reconstruit seul au démarrage (ou dès qu'il ne correspond plus).

### Format du store (contrat)

```jsonl
# Yuki — mémoire durable (Lot 12).
# Une ligne = un événement JSON. Fichier LISIBLE et corrigeable à la main.
# Le contenu courant est la PROJECTION de toutes les lignes, dans l'ordre.
{"v":1,"t":"add","id":"mem-…","at":"<ISO>","text":"…","source":"<id message>","cat":"preference"}
{"v":1,"t":"update","id":"mem-…","at":"<ISO>","text":"…","source":"…","cat":"fait"}
{"v":1,"t":"delete","id":"mem-…","at":"<ISO>"}
```

Catégories : `preference | fait | projet | relation | autre` (toute autre valeur
est ramenée à `autre`). Texte borné à 600 caractères (`MEMORY_TEXT_MAX_CHARS`).

## Schéma de l'index (dérivé, `node:sqlite` + FTS5)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  mem_id UNINDEXED,
  body,                                   -- foldText(texte) : minuscules, sans accents
  tokenize='unicode61 remove_diacritics 2'
);
-- recherche : SELECT mem_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?
```

La requête `MATCH` est construite par `buildMatchQuery` (termes ≥ 2 caractères,
dédupliqués, bornés à 8, chacun mis entre guillemets ; joints par `OR`) : aucune
syntaxe FTS5 interprétable, jamais d'exception.

## Bornes du rappel et comportement en dégradation

| Réglage | Défaut | Rôle |
| --- | --- | --- |
| `memory.enabled` | `on` | Active/désactive entièrement la mémoire (à chaud). |
| `memory.recall.topK` | `5` | Nombre max de souvenirs injectés. |
| `memory.recall.budgetChars` | `8000` | Taille max du bloc injecté (0 = aucun rappel). |
| `memory.recall.timeoutMs` | `400` | Délai max de préparation du rappel (ms). |
| `memory.extract.maxItems` | `3` | Souvenirs extraits par tour (0 = écriture off). |
| `memory.extract.timeoutMs` | `30000` | Délai max d'une extraction (hors chemin de réponse). |

**Dégradation gracieuse** : si l'index est indisponible, la reconstruction trop
lente (au-delà du timeout) ou la mémoire désactivée, `recall` renvoie un bloc
`null` — la réponse part **sans** mémoire, **sans erreur**.

**Coût observé** (store de 2000 souvenirs, mesure locale) : latence du rappel
`p50 = 1,5 ms`, `p95 = 2,2 ms`, `max = 4,0 ms` — soit < 0,5 % d'un TTFT de ~650 ms.
Le coût réel sur le TTFT en production **n'a pas été mesuré** (aucun modèle/appel
réseau dans l'environnement de dev) ; les bornes ci-dessus garantissent un plafond.

## Composition

| Fichier | Rôle |
| --- | --- |
| `src/memory/types.ts` | Types purs (entrée, événement, port `MemoryPort`, bornes). |
| `src/memory/normalize.ts` | `foldText`, `fingerprint`, `buildMatchQuery`. |
| `src/memory/store.ts` | `MemoryStore` (JSONL append-only, projection, dédup). |
| `src/memory/index-db.ts` | `MemoryIndex` (FTS5, rebuild, recherche). |
| `src/memory/extract.ts` | Prompts d'extraction/consolidation + lecture robuste. |
| `src/memory/service.ts` | `MemoryService` (`recall` borné, `onTurnEnd`, `onBeforeCompact`). |
| `src/pi/sdk/memory-extension.ts` | Extension SDK : rappel (`systemPrompt`) + déclencheurs. |
| `src/pi/sdk/memory-extractor.ts` | Extracteur LLM via session éphémère isolée. |

`src/memory/**` n'importe **ni le SDK ni typebox** (test de frontière). Seul
`src/pi/sdk/memory-extension.ts` importe le SDK (imports de types uniquement).

## Ce qui reste à faire / incertitudes

- **C59 — Mesure du TTFT réel** : à instrumenter en production (le rappel ajoute
  une requête SQLite locale ; plafond 400 ms). Non mesuré ici.
- **C60 — Qualité d'extraction** : dépend du modèle léger ; les prompts
  privilégient la prudence (0–3 items, anti-injection). Aucun corpus d'évaluation
  n'a été constitué.
- **C61 — Fusion sémantique** : la dédup est exacte (empreinte) ; la fusion de
  paraphrases proches (`update`/`delete`) n'arrive que si le modèle la propose lors
  de la consolidation.
- **C62 — `/health`** : la mémoire n'est pas encore exposée dans le snapshot
  `/health` (nombre d'entrées, dernier rappel).
- **C63 — Vue `/config`** : les réglages mémoire sont sous l'onglet « Conversation » ;
  aucune visualisation du contenu de la mémoire dans l'UI (le fichier reste la
  source).
