# Lot 13 — Archive « vie antérieure » (séparée, jamais fusionnée)

> Archive de la **vie antérieure** de Yuki (machine `Yuki-old`, ère OpenClaw),
> **délibérément séparée** de la mémoire durable du Lot 12 (`docs/lot12.md`).
> Elle est **consultable à la demande**, **jamais injectée par défaut**, et
> **jamais fusionnée** avec la mémoire courante. Ce document décrit
> l'emplacement, le format, l'exclusion de l'extraction automatique, la
> consultation, l'import, puis **ce qui est garanti vs ce qui ne l'est pas**.

## 1. Faits constatés (état AVANT ce lot)

- **Déclencheurs d'écriture** (`src/pi/sdk/memory-extension.ts`) :
  - fin de tour : événement `agent_end` → `MemoryService.onTurnEnd` ;
  - compaction : `session_before_compact` → `MemoryService.onBeforeCompact`.
- **Ce que lit l'extracteur** : le **dernier échange** `user→assistant` de la
  branche active de la session (`lastExchange`, `memory-extension.ts:38-72`) ; à
  la compaction, `preparation.messagesToSummarize` + `turnPrefixMessages`.
  **Il ne lit JAMAIS le disque de l'archive** : seulement des messages.
- **Où il écrit** : `MemoryService.applyOps` → `MemoryStore.add/update/remove`
  (`src/memory/store.ts`), journal append-only **`/data/state/memory.jsonl`**
  (volume `state`), index dérivé `/data/state/memory-index.sqlite`
  (`src/config/env.ts:222-232`).
- **Mécanisme d'exclusion DÉJÀ existant** : `syntheticUserPrefixes` — un texte
  utilisateur SYNTHÉTIQUE (report de job) est **ignoré** (préfixe explicite,
  `memory-extension.ts:26-28,42-46`). C'est le **patron de l'indicateur
  explicite** réutilisé ici (voir §4).
- **Fait déterminant** : le store ne lit QUE son propre fichier. Un dossier
  VOISIN (non lu par le store) n'est **structurellement jamais absorbé**.

## 2. Emplacement et format de l'archive

**Choix** : un dossier dédié **`/data/state/memory-heritage/`** (volume `state`,
**voisin** de `memory.jsonl`), surchargée par `YUKI_HERITAGE_DIR`
(`src/config/env.ts`). Pourquoi un dossier voisin plutôt qu'un fichier ?
- il est **séparé par construction** du store (le store ne lit que son fichier) ;
- il reste **lisible, corrigeable et supprimable à la main** (fichiers
  individuels), dans l'esprit du projet ;
- il peut contenir **N fichiers** déposés librement (import trivial).

Structure :

```
/data/state/memory-heritage/
├── README.md              # notice auto-descriptive (écrite à la création)
├── manifest.json          # provenance (machine, ère) + période
└── entries/
    ├── identite.json
    ├── profil.json
    └── reves.md
```

**Chaque entrée est étiquetée** : l'étiquette canonique `vie antérieure — ne pas
fusionner` (`HERITAGE_LABEL`, `src/memory/heritage.ts`) est appliquée à la
lecture si le fichier ne la porte pas ; la provenance (`Yuki-old`, `OpenClaw`) et
la période sont également complétées. Toute entrée lue est **auto-descriptive**.

**Exemple d'entrée** (`entries/identite.json`) :

```json
{
  "v": 1,
  "id": "heritage-identite",
  "titre": "Identité (SOUL.md)",
  "categorie": "identite",
  "periode": "ère OpenClaw (avant la bascule vers le chatbot maison)",
  "provenance": { "machine": "Yuki-old", "ere": "OpenClaw" },
  "label": "vie antérieure — ne pas fusionner",
  "texte": "Qui était Yuki à l'ère OpenClaw…",
  "importe_le": "2026-10-08T00:00:00.000Z"
}
```

La lecture est **tolérante** (`parseHeritageEntry`) : un JSON **quelconque**
(le condensé complet, par ex.) est sérialisé comme `texte` et étiqueté ; un
fichier Markdown/texte est pris brut ; un JSON **corrompu** ne lève pas.

## 3. Consultation

- **Outil exposé au modèle** (LECTURE SEULE) : `archive_vie_anterieure`
  (`src/pi/sdk/heritage-tools.ts`), dans l'esprit de `lister_agents`/`etat_agent`.
  Sans argument : provenance + liste (titre, catégorie). Avec un identifiant ou
  un titre : le contenu d'UNE entrée. Sortie encadrée par `<vie_anterieure>`
  (anti-injection : le contenu est échappé, une seule fermeture possible).
- **Politique d'outils** : catégorie `heritage` (`src/llm/tool-policy.ts`),
  **léger uniquement**, activée par le câblage (`src/index.ts`).
- **Signal d'existence** (`src/pi/sdk/heritage-extension.ts`) : à chaque tour, SI
  l'archive contient au moins une entrée, **une seule ligne courte** est ajoutée
  au **prompt système du tour** (non persisté) : « Une archive “vie antérieure”
  existe (non fusionnée)… consultable à la demande ». **Aucun contenu n'est
  injecté.**

**Décision — l'archive est-elle injectée ?** **NON, jamais par défaut.**
Seule une **métadonnée d'existence** (une ligne, si l'archive existe) est
signalée. Justification : sans ce signal, le modèle ignorerait l'archive et ne
la consulterait jamais (outil inutilisable) ; la ligne ne porte **aucun contenu**
donc **aucun risque de fusion**, et coûte ~1 ligne par tour.

## 4. Exclusion de la mémoire automatique (point critique)

Ce qui empêche l'absorption, du plus fort au plus faible :

1. **STRUCTUREL** (garanti) : l'archive est un **dossier séparé** du store. Le
   store ne lit que `memory.jsonl` ; l'index que `memory-index.sqlite`.
   **L'extracteur ne lit que les conversations** : il n'ouvre jamais l'archive.
   ⇒ **l'archive ne peut pas être fusionnée sans que quelqu'un la colle dans le
   chat.** Prouvé par `tests/memory/heritage-exclusion.test.ts` (séparation).
2. **GARDE LOCALE** (fiable SI le marqueur est présent) : si un texte (utilisateur
   OU assistant) contient un marqueur explicite — `vie antérieure` (accents/casse
   près) ou `ne pas fusionner` — le tour est **écarté de l'extraction**
   (`MemoryService.onTurnEnd` → `looksLikeHeritage`) et de la **consolidation**
   (`onBeforeCompact`). Un faux positif est **sans danger** (il ne fait que
   sauter une extraction). Prouvé par `heritage-exclusion.test.ts`.
3. **CONSIGNE** (faillible, assumée) : les deux prompts d'extraction portent
   `HERITAGE_EXTRACTION_INSTRUCTION` (« si le contenu se présente comme une
   archive d'une vie antérieure… réponds `[]` »). ⚠️ **Ce n'est PAS une
   garantie** : c'est une consigne LLM. Elle couvre le cas où l'utilisateur colle
   un extrait **SANS** marqueur explicite.

⚠️ **Honnêteté sur les limites** : si l'utilisateur colle un contenu parlant de la
vie antérieure **sans** aucun marqueur (ni « vie antérieure », ni « ne pas
fusionner »), seule la consigne (§4.3) s'applique — **faillible**. La détection
fiable et sémantique d'un tel contenu **n'est pas possible** de façon fiable ;
on ne prétend pas le contraire.

## 5. Import du contenu fourni

Le **mécanisme** est implémenté ; **aucun contenu n'est inventé** (l'exécutant
n'a pas le condensé). Procédure :

1. Nettoyer le condensé (⚠️ **pas de sources BRUTES** — voir §6).
2. Copier le(s) fichier(s) dans `/data/state/memory-heritage/` ou dans
   `entries/` (ex. `docker compose cp condense.json gateway:/data/state/memory-heritage/entries/condense.json`).
3. Aucune commande : la lecture est faite **à la demande** (outil ou
   consultation directe des fichiers).
4. Corriger/supprimer une entrée : éditer ou supprimer son fichier.

Un fichier JSON **quelconque** déposé est lu et étiqueté automatiquement : un
condensé complet peut donc être déposé tel quel (il devient une entrée).

## 6. ⚠️ Secrets

Les sources **brutes** de `Yuki-old` contiennent des **SECRETS** (clé MCP Docker,
identifiants machine). **NE PAS les importer brutes** : consultées, elles
partiraient chez le **fournisseur LLM**. Ne déposer qu'un condensé **déjà
nettoyé**. L'avertissement est répété dans le `README.md` auto-écrit.

## 7. Décisions (D129+)

| # | Décision |
| --- | --- |
| **D129** | **Archive = dossier séparé** `/data/state/memory-heritage/` (volume `state`), voisin du store. Aucun volume neuf. Surcharge `YUKI_HERITAGE_DIR`. |
| **D130** | **Lecture seule + tolérante** (`HeritageStore`) : dossier absent/corrompu ⇒ message honnête, aucune exception ; les erreurs de lecture sont **conservées** pour diagnostic. |
| **D131** | **Étiquetage appliqué à la lecture** : `HERITAGE_LABEL` (« vie antérieure — ne pas fusionner ») + provenance (`Yuki-old`, `OpenClaw`) complétées si absentes ⇒ entrées auto-descriptives. |
| **D132** | **Exclusion à trois niveaux** : structurelle (dossier séparé), garde locale (`looksLikeHeritage` sur marqueurs), consigne d'extraction. La consigne est **faillible et documentée comme telle**. |
| **D133** | **Consultation à la demande** : outil `archive_vie_anterieure` (léger, lecture seule), sortie encadrée `<vie_anterieure>`. **Jamais injectée par défaut.** |
| **D134** | **Signal d'existence** = une ligne dans le prompt système du tour, **seulement si l'archive contient une entrée**, **sans aucun contenu**. |

## 8. Composition

| Fichier | Rôle |
| --- | --- |
| `src/memory/heritage.ts` | Domaine pur : étiquette, types, lecture tolérante, détection, rendu encadré, README. |
| `src/memory/heritage-store.ts` | `HeritageStore` : lecture filesystem tolérante, cache d'existence, `ensureLayout`. |
| `src/pi/sdk/heritage-tools.ts` | Outil `archive_vie_anterieure`. |
| `src/pi/sdk/heritage-extension.ts` | Signal d'existence (une ligne, non persistée). |

`src/memory/heritage*.ts` n'importe **ni le SDK ni typebox** (test de frontière).

## 9. Ce qui reste incertain

- **Qualité de la détection `looksLikeHeritage`** : couvre les marqueurs
  explicites ; un contenu sans marqueur n'est couvert que par la consigne.
- **Faux positifs** : un texte ordinaire contenant « vie antérieure » saute une
  extraction (sans danger, mais possible).
- **Contenu** : l'exécutant n'a **pas** le condensé ⇒ l'archive est **vide** tant
  que l'utilisateur n'a pas déposé ses fichiers (l'outil le dit honnêtement).
