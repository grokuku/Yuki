# Lot 36 — multi-bot : quels bots TOURNENT (L1 + L2)

Approche **B** (décision utilisateur) : **un seul processus**, N `PiHost`.
Ce document couvre les deux premiers lots du plan ; les suivants sont listés en
fin, avec ce qui reste à faire.

## Ce qui est livré

### L1 — Résolution au démarrage

`src/bots/actifs.ts` (nouveau, pur : aucune écriture, aucun démarrage) :

| Symbole | Rôle |
|---|---|
| `botsAActiver(registre)` (`:84`) | tous les bots `actif: true`, triés `ordre` puis `id` (ordre déterministe) |
| `resoudreDemarrageBots(registre, {maxActifs})` (`:109`) | rend `{principal, aDemarrer, refuses, plafond}` |
| `normaliserPlafond(valeur)` (`:50`) | entier borné `[1, MAX_BOTS]`, défaut 3, jamais `NaN` |
| `lirePlafondActifs(env, processEnv)` (`:72`) | précédence `défaut (3) < store < environnement` |
| `messageRefusPlafond(bot, plafond)` (`:124`) | message français nommant le bot refusé |

⚠️ **« Principal » ≠ « doit tourner ».** `principal` vient de `botActif`
(`src/bots/registry.ts:297`) qui privilégie **toujours** `yuki` ; `aDemarrer` ne
contient que les `actif: true`. Éteindre `yuki` ne change donc pas l'identité de
l'instance, seulement ce qui tourne.

`preparerMultiBot` (`src/bots/index.ts:235`) rend désormais `principal`,
`aDemarrer`, `refusesActifs`, `plafondActifs` :

- plafond dépassé ⇒ les bots en trop **ne démarrent pas** et sont nommés un par
  un dans `avertissements` (journalisés `bots.avertissement`) ;
- **aucun** bot actif ⇒ `DemarrageRefuseError("AUCUN_BOT_ACTIF")` ;
- principal éteint ⇒ la pile construite est celle du **premier bot actif**, et
  c'est dit (`avertissements`) ;
- **garde de non-régression** : un seul bot actif (`yuki`) ⇒ `bot`, `env` et
  chemins **identiques** à avant (test dédié).

Réglage : `bots.maxActifs` (`src/config/schema.ts:813`), portée `instance`,
`int` 1..6, défaut **3**, `apply: restart`, surchargeable par
`YUKI_BOTS_MAX_ACTIFS`. Lecture au démarrage via `lireValeurInstance`
(`src/config/runtime.ts`), pour ne pas créer un second lecteur du store commun
(`ConfigStore` reste la propriété de `src/config/`, verrouillé par
`tests/config/schema-scope.test.ts`).

Journal de démarrage : `bots.demarrage` (`src/index.ts:341`) →
`{mode, principal, pile, a_demarrer, refuses, plafond}`.

### L2 — On/off réel du bot

`definirActif` (`src/bots/admin.ts:635`) : **première** écriture du drapeau
`actif` (jusque-là posé seulement à la création et à la promotion après
suppression).

| Cas | Effet |
|---|---|
| déjà dans l'état demandé | `inchange: true`, **aucune écriture** |
| allumer sous le plafond | écrit `actif: true`, `demarrageRequis: true` |
| allumer au-delà du plafond | `409 plafond_actifs` — message nommant le plafond **et** les bots allumés |
| éteindre s'il reste ≥ 2 actifs | écrit `actif: false`, `arretRequis: true` |
| éteindre le **dernier** actif | `409 dernier_bot_actif` (sinon plus de démarrage possible) |
| `actif` non booléen | `400 actif_invalide` |
| bot inconnu | `404 bot_inconnu` |

Route : `PATCH /api/bots/<id>/actif`, corps `{ actif: boolean }`
(`src/gateway/routes/config.ts:1035`). Exige `X-Yuki-Config: 1` + même origine
(`guardWrite`), met à jour le registre **en mémoire** (sinon `GET /api/bots`
mentirait), journalise `bot.actif` et répond
`{bot, bots, actif, inchange, actifs, plafond, redemarrageRequis}`.

⚠️ **L'effet est au redémarrage** (`redemarrageRequis: true`) : le processus en
cours a résolu ses bots au démarrage. Le drapeau décrit ce qui **doit** tourner,
pas ce qui tourne déjà — c'est exactement ce que L8 rendra observable.

## Ce qui n'est PAS livré (et pourquoi)

**L3 → L10 ne sont pas commencés.** L3 (composition par bot, XL) exige
d'extraire `creerPileBot(botId)` de `main()` (`src/index.ts:277-3833`) : ~1 100
lignes de câblage imbriqué (`if (gate.passed)` ligne 2419 → 3518) où le `PiHost`,
la mémoire, les envois, la bibliothèque, les jobs et les canaux partagent des
fermetures et des `let` lus plus tard par les routes (`getSubsystems`,
`src/index.ts:3518`). Un lot commencé sans être fini laisserait l'UI et le
runtime à moitié recâblés — c'est précisément l'état interdit. L3 demande donc
une passe complète à lui seul ; les lots L4 (transport), L5 (canaux), L6
(agents), L7 (workers), L8 (`/bots` réel), L9 (arrêt ciblé) et L10 (jetons par
bot) en dépendent dans cet ordre.

Ce qui **reste vrai** en l'état : une seule pile est construite (`pile` =
principal s'il tourne, sinon premier actif). Allumer un second bot écrit le
registre et le journal, sans construire sa pile.

## Tests

| Fichier | Contenu |
|---|---|
| `tests/bots/actifs.test.ts` (12) | plafond (normalisation, lecture env/store), liste triée, **principal ≠ doit tourner**, plafond nommant le refus, **non-régression 1 bot**, tous éteints ⇒ refus |
| `tests/bots/actif.test.ts` (13) | `definirActif` (écriture, `inchange`, plafond, dernier actif, types) + route (403 sans en-tête, registre mémoire, 409, 405/404/400, mode mono) |
| `tests/config/schema-scope.test.ts` | compteur 89 → **90** clés et 66 → **67** `instance`, avec la clé nommée (l'ajout est **délibéré**) |

Preuve d'échec sur l'origine (arbre gelé `14f77dd`, `/tmp/preuve-lot36/origine`,
contenu `src/` vérifié : 325 entrées, `tests/` : 451) : **12/12** et **13/13**
tests en échec. Les autres suites (`tests/bots`, `tests/config`, `tests/gateway`,
`tests/ui`, `tests/sources`, `tests/agents`, `tests/integration`) restent vertes.

`tsc` vert sur **les deux** projets (`tsconfig.json` et `tsconfig.test.json`).
