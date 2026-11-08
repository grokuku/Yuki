# Lot 33 — Discussion / Travail (simplification des modèles)

Renommage **UI et doc uniquement** : « Modèle de discussion » (ex. LLM léger)
et « Modèle de travail » (ex. LLM lourd). ⚠️ Aucune clé renommée :
`llm.light.*` / `llm.heavy.*` et `YUKI_LLM_LIGHT_API_KEY` /
`YUKI_LLM_HEAVY_API_KEY` restent canoniques. Alias de lecture seule dépréciés :
`YUKI_LLM_DISCUSSION_API_KEY` / `YUKI_LLM_TRAVAIL_API_KEY`.

Table unique des 8 usages (voir `runbook.md` § 10) : usage → rôle → réflexion →
repli → fichier:ligne. La synthèse du libraire (#7) passe au rôle **travail**
avec repli sur **discussion**.

## Ce que voit l'utilisateur (`/config` → Modèles)

- **Aide** sous le titre du groupe « Modèle de discussion »
  (`public/ui/config.js:176-184`, rendu `:1465-1472`, textes dans
  `public/ui/modeles-aide.js:15-18`) : « Le modèle de discussion est
  l'interface… Le modèle de travail exécute les tâches déléguées et les travaux
  de fond. »
- **Bandeau conditionnel** (`public/ui/config.html:194-202`,
  `public/ui/config.js:2029-2038`) : affiché **seulement** si la clé du rôle
  travail manque (`status.heavyKey === false`, même mesure que
  `src/llm/availability.ts:63-69`), masqué et vidé dès qu'elle est là.
  `textContent` seul, aucun style inline, CSP inchangée.
- Les **libellés** des deux groupes restent « Modèle de discussion » /
  « Modèle de travail » (`public/ui/config.js:179`, `:205`) ; ⚠️ les **clés**
  (`llm.light.*`, `llm.heavy.*`) sont intactes.

## Repli et réflexion

Repli centralisé dans `src/memory/write-model.ts:36-48`
(`memoryWriteModelReference`) : log `llm.fallback { usage, de, vers, raison }`
(jamais de contenu ni de clé). Utilisé par l'extraction mémoire
(`src/index.ts:2227-2237`), la synthèse du libraire (`:2380-2391`) et le
récapitulatif (`:2925-2938`).

`thinking` uniforme : les 5 `off` figés lisent `llm.<role>.thinking`, **sauf**
le juge du mode `auto` (fabrique `chatWriter`, `src/index.ts:1464` — `off` figé,
appel `:1875`) qui reste `off` : il tourne à chaque message. La consolidation
hebdo a le lourd **imposé** (aucun repli, `src/memory/consolidation-hebdo.ts:437`)
mais suit `llm.heavy.thinking`.

## Tests et preuve

- `tests/llm/discussion-travail.test.ts` : alias (lu / prioritaire / vide),
  exception du juge (`off` sous `heavy.thinking = high`), log sans contenu,
  table du runbook.
- `tests/ui/config-modeles.test.ts` : phrase d'aide rendue, règle pure
  `bandeauTravail(disponible)`, élément dans l'onglet Modèles, pas de style
  inline.
- `tests/agents/secret-tools.test.ts` : les alias de clés LLM ne sont **jamais**
  proposés par `lister_secrets` (le coffre ne les contient pas), même présents
  dans l'environnement.
- **Preuve d'échec sur l'origine** (HEAD insuffisant : lots non commités) :
  copie `tar` dans `/tmp/preuve-lot33` + `node_modules` lié, puis
  NEUTRALISATION chirurgicale (aide, table, bandeau, alias, log, branchement
  `thinking`) ⇒ **9 échecs / 29** sur les trois nouveaux fichiers, 20 réussites
  qui sont les garde-fous déjà vrais avant le lot.
- **Rendu mesuré** (Chromium headless + CDP, deux gateways réels) :
  - rôle travail indisponible ⇒ `#work-model-notice` visible, texte exact ;
  - rôle travail disponible ⇒ `#work-model-notice` `hidden` et texte vide ;
  - dans les deux cas, l'aide `.config-group__intro` est rendue et l'onglet
    Modèles est actif. (Script jetable hors dépôt.)

## Campagne (exécutée)

- `npm test` COMPLET : **370 fichiers passés / 3 ignorés** ; **4 082 tests
  passés / 5 ignorés / 0 échec**.
- `tsc` : `tsconfig.json` **et** `tsconfig.test.json`, 0 erreur.
- E2E : `sources` 41/41 · `ack` 44/44 · `memory` 23/23 · `chat-sessions` 36/36 ·
  `image` 124/124 · `files` 71/71 · `mobile-ui` 40/40 · `timestamp` 49/49 ·
  `secret` 28/28 · `pins-agents` 59/59 · `tts-ui` 108/108 — **CSP 0,
  connexion 0, exceptions 0** partout.
- 31 PNG suivis réécrits par les E2E : restaurés **un par un**
  (`git show "HEAD:<chemin>" > <chemin>`) ; `git status` identique avant/après.

## Invérifiable ici

- La qualité réelle des réponses du modèle quand le repli léger est utilisé
  (« qualité réduite » est un avertissement, pas une mesure).
- Le comportement d'un fournisseur qui refuse un niveau de réflexion : la
  dégradation est celle du SDK, non rejouée en E2E.
