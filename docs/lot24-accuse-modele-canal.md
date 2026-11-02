# Lot 24 — l'accusé de canal est écrit par le MODÈLE

Décision utilisateur (2026-11-02, verbatim) : « je veux pas que le ack soit une table
fixe. c'est totalement inhumain comme comportement. » ⇒ combinaison **①+②** retenue :
le modèle écrit l'accusé comme en mode local, la table existante reste en **repli**.

## Livré

| Élément | Où |
|---|---|
| Consigne d'accusé **dans le prompt du run de canal**, paramétrée par SON allowlist (`ackRuleFor(tools)`, jamais `ACK_RULE` qui cite `run_command`) | `src/pi/sdk/ack-extension.ts:40` (paramètre `rule`), `src/pi/chat-run.ts:240-256` |
| Transport par le mécanisme existant (`extensionFactories` → `before_agent_start` → prompt système du tour), donc **zéro appel modèle supplémentaire** | `src/pi/sdk/prompt-writer.ts:161`, `src/pi/sdk/session-factory.ts:44` |
| Écrivain : `ackCandidat` remonte **brut** (le texte déjà écrit avant l'appel), la forme se décide ailleurs | `src/pi/sdk/prompt-writer.ts:49-66`, `:187-230` |
| `ReplyProgress` : **modèle d'abord**, table en repli ; texte non ack-shaped ⇒ **contenu** (aucun accusé) ; 1 accusé/run ; bornes inchangées | `src/chat/reply/progress.ts:164-204` |
| Rotation du repli **par conversation** (déjà portée par le générateur) et **source journalisée** (`modele`/`repli`, jamais le texte) | `src/chat/reply/generate.ts:142-171`, `src/chat/reply/progress.ts:202` |
| Transport inchangé : `ReplyRun.extensionFactories` est une **liste**, l'écrivain attend une **fabrique** relue à chaque tour (la lambda de `generate.ts` fait la conversion) | `src/chat/reply/generate.ts:185-188`, `src/pi/chat-run.ts:256` |

## Ce qui ne change pas

- **Mode local** : `createAckExtensionFactory()` sans argument garde `ACK_RULE`, et
  `maybeAcknowledge` (`src/pi/sdk-host.ts:683`) est intact — c'est la référence.
- Bornes : `ACK_MAX_CHARS` (90) reste le critère de reconnaissance, la consigne vise 60
  (`ACK_RULE_MAX_CHARS`), 3 résultats/run, rappel > 90 s, 1 accusé/run.
- **Aucun outil après l'accusé** ⇒ le texte est la réponse : rien n'est publié, et
  l'adaptateur ne poste pas de bulle vide (`src/chat/mattermost/adapter.ts:822`,
  `src/chat/discord/adapter.ts:822`).
- Backfill D1 (`historique:true`) : **zéro run**, chemin inchangé.

## Coût

La consigne vit dans le prompt système du tour existant : **aucun appel LLM
supplémentaire** (`tests/chat/reply-ack-modele.test.ts`, « ZÉRO appel modèle
supplémentaire »). Le prix réel est le texte d'accusé lui-même — quelques tokens par
message de canal qui déclenche une action longue.

## Preuve d'échec sur l'origine

Arbre HEAD reconstitué dans `/tmp/preuve-lot24` (`git show HEAD:<f>` par fichier
suivi, `node_modules` lié), tests recopiés ⇒ **31 échecs / 6 passants** sur les 4
fichiers concernés (`reply-ack-modele`, `reply-progress`, `prompt-writer-tool-events`,
`remote-delegation-rule`).

Les 6 passants sont les non-régressions attendues (sans `onTool`, observateur qui lève,
défaut `chat.remoteAgents`). Sur le fichier neuf, 5 échecs sont des **assertions**
(« expected [] to deeply equal [{ text: … }] ») — les 3 passants y verrouillent des
NON-publications, que l'origine satisfait trivialement ; `reply-progress.test.ts`
échoue, lui, sur le **module absent** (`src/chat/reply/progress.ts` n'existe pas à HEAD).

## Invérifiable ici

- Le **taux de repli réel** en production : on le lira dans `chat.progress.ack`
  (`source: "repli"`). Aucun test ne dit si le modèle consent à écrire l'accusé.
- Le **coût exact** en tokens de la consigne sur le modèle léger configuré : il dépend
  du fournisseur, pas du code.
