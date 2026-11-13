# Lot 47 — personnalité séparée, outils générés, plus de nom en dur

Trois défauts de COMPOSITION du prompt système, signalés le 2026-11-13.

## Les trois défauts

| Défaut | Ce qui se passait | Ce qui est fait |
|---|---|---|
| **Personnalité non séparée** | le paragraphe d'identité vivait dans le TEXTE de `prompts.light` : éditer le prompt pouvait effacer sans qu'on le voie les consignes d'outils | clé dédiée **`prompts.personnalite`** (portée `mixte`, fusion `surcharge`), composée dans son PROPRE bloc |
| **Liste d'outils figée** | la liste (`read`, `ls`, `grep`, `find`…) était écrite dans le prompt : un bot déjà en place n'apprenait jamais un ajout ou un retrait d'outil | bloc **`<outils>` GÉNÉRÉ** à chaque composition depuis l'`allowlistFinale` réelle du bot |
| **Nom en dur** | « tu es Yuki » était écrit dans les prompts par défaut | bloc **`<identite>`** alimenté par le NOM du bot (registre), un seul endroit |

## Point unique d'assemblage

`composerPromptSysteme` — **`src/llm/prompt-systeme.ts:185`**.

Appelé par les trois seuls endroits qui construisent un prompt système :

| Appelant | `fichier:ligne` | Rôle |
|---|---|---|
| host du bot de la pile | `src/index.ts:3929` | `light` |
| worker lourd (par bot) | `src/index.ts:3249` | `heavy` |
| host d'un bot secondaire | `src/bots/hosts.ts:228` | `light` |

Ordre des blocs : `<identite>` → `<personnalite>` → prompt système → `<outils>` →
(consigne de voix, ajoutée ensuite par `appendVoiceInstruction`). Le rôle `heavy`
ne reçoit PAS de personnalité : le worker n'est pas le bot qui converse.

## Ce que la composition garantit

- **éditer la personnalité ne change jamais la liste d'outils** (test dédié) ;
- **deux allowlists ⇒ deux listes générées différentes**, un outil retiré disparaît,
  un outil ajouté apparaît (aucune réédition de texte) ;
- chaque outil est annoncé avec son **nom ET sa phrase** (`PHRASES_OUTILS`) ; un
  outil sans phrase apparaît quand même, avec un repli explicite ;
- allowlist **vide** ⇒ le prompt le dit franchement (jamais un bloc muet) ;
- allowlist **inconnue** (`undefined`, appelant qui ne sait pas) ⇒ aucun bloc :
  on n'invente pas de liste.

## Récupération de la personnalité existante (rien perdu, rien dupliqué)

- le paragraphe d'identité et la section « Comportement » de l'ancien prompt sont
  déplacés dans **`config/pi/personnalite.md`** (défaut livré de la nouvelle clé,
  comme `config/pi/system-prompt.md` l'est pour `prompts.light`) ;
- une configuration **déjà stockée** dont `prompts.light` contient encore ce
  paragraphe est **signalée au démarrage** (`pi.prompt.personnalite_dupliquee`)
  ET le bloc n'est **pas composé une seconde fois** : le texte n'apparaît qu'une
  fois, et le journal dit quoi déplacer. **Aucune réécriture** du texte de
  l'utilisateur ;
- un texte qui nomme encore le bot en dur est signalé (`pi.prompt.nom_en_dur`) ;
- deux personnalités remplies (champ du bot + fichier partagé `personality.md`)
  sont signalées (`personality.deux_sources`).

## Interface

Page **Bot · Personnalité** : « Personnalité » / « Prompt système — léger » /
« Prompt système — lourd » (trois zones nommées et distinctes), plus un bloc
**lecture seule** « Outils générés à chaque tour » alimenté par la MÊME allowlist
que celle qui part au host (`outilsGeneres`, `GET /api/config` et
`GET /api/bots/<id>/config`).

## Ce qui n'est PAS couvert par les tests

`main()` n'est jamais exécuté par la suite de tests (le module lance `main()` au
chargement) : le CÂBLAGE n'est couvert que par `tsc` (les deux configurations) et
par les **gardes statiques** de `tests/llm/prompt-composition.test.ts` (le bot de
la pile, le worker lourd et les hosts secondaires passent tous par
`composerPromptSysteme`, et l'allowlist annoncée est celle posée sur le host).
