# Lot 35d (sous-lot 1b-4) — les DEUX pages de configuration

**Ce qui change pour l'utilisateur** : la configuration se lit désormais sur **deux
pages**. `/config` ne porte plus que ce qui est **commun à l'instance** (7 onglets) ;
`/bots?b=<slug>` porte ce qui est **propre à un bot** (6 onglets).

## ① Les deux pages

| Page | URL | Onglets |
|---|---|---|
| Instance | `/config` | Modèles · Exécution · Images · Agents · Secrets · Système · Maintenance |
| Bot | `/bots?b=<slug>#<ancre>` | Général · Personnalité · Voix · Mémoire · Plateformes · Déclencheurs |

Déclaration de la route : `src/gateway/routes/static.ts:85-90` (une branche, comme
`/config`). Les deux pages partagent **un seul module** (`public/ui/config.js`) ;
c'est `<body data-config-page="instance|bot">` (`config.html:16`, `bots.html:18`)
qui décide des onglets, des groupes rendus et de la destination des écritures.

## ② La règle : c'est la PORTÉE qui décide, pas la page

Chaque clé porte un `scope` (`instance` / `bot` / `mixte`, `src/config/schema.ts:135`)
servi par le snapshot. Une page ne rend que ce que sa portée autorise :

- **Instance** ⇒ `instance` + `mixte` (côté INSTANCE d'une clé mixte) → `PUT /api/config` ;
- **Bot** ⇒ `bot` + `mixte` (côté BOT d'une clé mixte) → `PUT /api/bots/<id>/config`.

Conséquence vérifiée par test : **65 clés** sur la page Instance, **15** sur la page
Bot, chaque clé rendue **une fois par page autorisée**, les **5 clés `mixte`** sur les
deux (`tests/ui/config-pages.test.ts`).

Déménagements demandés :

| Avant | Après |
|---|---|
| Conversation → délégation + fichiers | Instance · Exécution |
| Conversation → prompts | Instance · Modèles (valeur COMMUNE) **et** Bot · Personnalité (surcharge) |
| Conversation → mémoire | Bot · Mémoire (planification de la consolidation : Instance · Système) |
| Conversation → chat-root | Bot · Plateformes |
| Déclencheurs (id conservé) | Bot · Déclencheurs |
| Personnalité | Bot · Personnalité |
| Voix | Bot · Voix + **9 clés techniques** sur Instance · Système (`tts.enabled`, `engine`, `baseUrl`, `language`, `prefetchDepth`, `min/maxSentenceChars`, `timeoutMs`, `volume`) |
| Images / Agents / Secrets / Système / Maintenance | inchangés (Instance) |

Le catalogue des champs a été extrait de `config.js` vers **`public/ui/config-fields.js`**
(module pur) : chaque groupe déclare ses onglets par page (`tabs: { instance, bot })`.
La logique des pages vit dans **`public/ui/config-pages.js`** (module pur, testé sans
navigateur).

## ③ Sélecteur de bot

`bots.html:60` : `<select id="bot-select">` + bouton **« ＋ »** (`bots.html:62`, `#bot-add`).
L'état est porté par l'URL `?b=<slug>` (réécrite avec le bot réellement affiché :
lien partageable, rechargement sûr). Un slug **inconnu** retombe sur `yuki` **sans
erreur visible** (`config.js:1352`).

- **« ＋ »** ouvre une `HolafModal` « **bientôt disponible** » : l'écran d'ajout est un
  lot ultérieur (`config-pages.js:282`).
- **Modifications non enregistrées** ⇒ `HolafModal` à **3 choix** : « Enregistrer » /
  « Abandonner » / « Rester sur ce bot » (`config-pages.js:259`).
  Jamais de confirmation native du navigateur ; une fermeture par ✕/Échap vaut
  « rester » (on ne jette rien et on ne change pas de bot en silence).
- Zone **Général** : nom, slug **lecture seule**, profil, avatar, **zone de danger
  SANS bouton de suppression** (renommer/supprimer doit déplacer dossiers, chemins et
  conversations : lot ultérieur).
- Un bot **non actif** affiche un bandeau : ses clés de configuration s'affichent et
  s'enregistrent bien sur LUI, mais personnalité / voix / plateformes / déclencheurs
  restent ceux du bot actif et ne sont donc pas montés (aucune écriture au mauvais
  endroit).

## ④ Retrouver un réglage déplacé

- Une **ligne sous le titre** de chaque page (`#page-ligne`, remplie depuis
  `config-pages.js:243`).
- Un **encart de renvoi** dans chaque groupe éclaté (`config.js:621`), avec un
  lien vers l'autre page : prompts, mémoire, voix, notifications, borne des sources.
- Le lien de la barre latérale vise la page du bot : `index.html:378`
  (`/bots?b=yuki#declencheurs`), ainsi que les trois entrées déplacées du menu
  téléphone (`index.html:240`, `:241`, `:243`).

## ⑤ Tests mis à jour (aucune garde supprimée)

`tests/integration/static-ui.test.ts` (7 onglets Instance + nouvelle preuve `/bots` :
6 onglets, CSP, sélecteur, conteneurs), `tests/ui/sources-notifications.test.ts`,
`tests/ui/declencheurs-page.test.ts`, `tests/ui/chat-panel-remote-agents.test.ts`
(`#chat-root` désormais dans `panel-plateformes`), plus **5 fichiers** dont les
assertions lisaient le catalogue dans `config.js` : ils lisent maintenant **les deux**
fichiers (`config.js` + `config-fields.js`) — gardes inchangées, cible mise à jour.
Nouveau : `tests/ui/config-pages.test.ts`. Les gardes CSP (`innerHTML`,
`.style.`, `setAttribute("style"`, confirmation native) s'appliquent **aux deux pages**
et aux deux nouveaux modules.

Harnais E2E ajustés : `e2e-sources` (page du bot + borne vérifiée sur `/config#systeme`),
`e2e-tts-ui` (voix sur `/bots`, moteur sur `/config#systeme`, route d'écriture prouvée
par espionnage de `fetch`), `e2e-memory`, `e2e-memory-preview`, `e2e-heritage`.

## Limites connues (dites, pas cachées)

- L'édition **par bot** de la personnalité, des plateformes, de la voix et des
  déclencheurs n'est pas possible : leur API ne sert que le bot **actif**. La page
  l'annonce dans un bandeau au lieu d'écrire au mauvais endroit.
- Création, renommage et suppression d'un bot : **lots ultérieurs** (aucun bouton
  inerte n'est affiché).
- `memory.setAside.maxChars/maxChunks` et `chat.discord.*` n'ont **aucun contrôle**
  dans l'interface (état antérieur à ce lot, inchangé).
