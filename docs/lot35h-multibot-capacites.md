# Lot 35h — des CAPACITÉS à la place des profils

Décision utilisateur (2026-11-10 19:24) : « je ne veux pas de profil
préconfigurés. de base un bot ajouté ne peux rien faire. ses capacités évoluent
en fonction de ce que je l'autorise à faire ou pas ». Un bot peut **toujours
répondre** ; tout le reste est une autorisation explicite, décochée au départ.

## Le modèle

| Où | Ce qui change |
|---|---|
| `src/bots/registry.ts` | `BotRecord.profil` → `BotRecord.capacites: CapaciteBot[]` ; liste des clés connues `CAPACITES_BOT` (12) ; **une capacité inconnue est REFUSÉE** à la lecture comme à l'écriture |
| `src/llm/tool-policy.ts` | table `OUTILS_DES_CAPACITES` (`Record<CapaciteBot, {builtins, custom}>`) + `filtrerSelonCapacites` : règle unique `allowlistFinale = toolAllowlist(…) ∩ OUTILS_DES_CAPACITES` |
| `src/bots/profils.ts` | garde structurelle réécrite : `workerLourdAutorise(capacites)` — **`execution` ou `delegation` ⇒ worker lourd**, sinon il n'est jamais instancié |
| `src/bots/admin.ts` | `creerBot` ne demande plus que le NOM (slug dérivé et dédupliqué, capacités `[]`) ; `validerCapacitesBot` ; `modifierBot` (nom + capacités) |
| `src/gateway/routes/config.ts` | `GET /api/bots` renvoie `capacites` ; `POST /api/bots` = `{}` en capacités ; **`PATCH /api/bots/<id>`** = `{ nom?, capacites? }` |
| `public/ui/config-pages.js` + `config.js` | onglet **Général** de `/bots` : nom modifiable, slug en lecture seule, phrase fixe, **12 cases décochées**, bouton « Enregistrer les capacités » |
| `public/ui/bots-admin.js` | modale de création **simple** (nom + avatar facultatif ; clonage replié derrière une case secondaire) |

## Les 12 capacités

| Capacité | Outils |
|---|---|
| `fichiers` | `lister_fichiers`, `lire_fichier`, `recuperer_fichier`, `deposer_fichier` |
| `envoi` | `envoyer_message`, `envoyer_fichier`, `publier_dans_canal` |
| `libraire` | `recherche_libraire`, `liste_libraire`, `lire_libraire`, `archive_libraire`, `capture_libraire` |
| `web` | `lire_page_web` |
| `images` | `generer_image`, `consulter_workflow` |
| `agents` | `lister_agents`, `etat_agent` |
| `execution` | `run_command`, `capturer_ecran` |
| `delegation` | `delegate`, `job_status`, `cancel_job`, `steer_job` |
| `secrets` | `lister_secrets`, `demander_secret` |
| `programmation` | `programmer_envoi`, `planifier_tache` |
| `memoire` | `archive_vie_anterieure`, `chercher_conversations_archivees` |
| `builtins` | `read`, `ls`, `grep`, `find` |

Chaque outil custom appartient à **une seule** capacité (partition vérifiée par
test) : deux capacités qui se recouvriraient rendraient le réglage ambigu.

## Non-régression (le bot existant)

`bots.json` **sans** `capacites` (ou avec l'ancien `profil`) ⇒ **toutes** les
capacités à la lecture, et le champ `profil` disparaît à la première écriture.
Yuki conserve donc `run_command`, la délégation et la mémoire.

## Ce qui ne change pas

- l'intersection reste le **seul** point de filtrage : une capacité ne rouvre
  jamais ce que le câblage a fermé (`chat.remoteAgents = desactive` ⇒ `delegate`
  absent) ;
- la liste des **agents autorisés par bot** reste dans l'onglet « Agents »
  (`/config`, lot 35g) : capacités = familles d'outils, agents = quelles
  machines ;
- CSP, `HolafModal`, `textContent` uniquement (aucun `innerHTML`, aucun
  `.style.`).

## Un changement de capacités exige un redémarrage

Le gateway lit les capacités du **bot actif** à son démarrage : `PATCH` répond
`rechargementRequis: true` quand le bot modifié est le bot actif, et l'interface
le dit.

## Tests

- `tests/llm/tool-policy-capacites.test.ts` (réécriture de
  `tool-policy-profil.test.ts`, supprimé) — table de vérité capacité × outil,
  **bot neuf ⇒ allowlist vide** (léger, lourd, canal), intersections ;
- `tests/bots/profils.test.ts` (réécrit) — espion sur la fabrique du worker ;
- `tests/bots/registre-capacites.test.ts` — lecture tolérante, refus des
  inconnues, ordre canonique ;
- `tests/bots/admin.test.ts` — slug dérivé/dédupliqué, capacités vides à la
  création, `modifierBot`, `validerCapacitesBot` ;
- `tests/gateway/config-bots-api.test.ts` + `config-bots-admin-api.test.ts` —
  `GET` renvoie `capacites`, `POST` crée vide, `PATCH` valide et écrit ;
- `tests/ui/config-pages.test.ts` — les 12 cases, la phrase fixe, aucune trace
  de « Profil », création sans case ni slug.
