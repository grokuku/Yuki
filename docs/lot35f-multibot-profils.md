# Lot 35f — Les profils de capacités deviennent RÉELS

**Le défaut corrigé.** Jusqu'ici `profil` (`complet | lecture | accueil`,
`src/bots/registry.ts:74`) était une **étiquette** : un bot créé en `lecture`
avait **exactement** les mêmes pouvoirs qu'un bot `complet` — `run_command`,
capture d'écran, délégation, agents, coffre, libraire, fichiers du système.
L'interface affichait « Lecture » et ne restreignait rien.

## ① La règle, écrite une fois

```
allowlistFinale = toolAllowlist(rôle, options) ∩ PROFIL
```

- Table : `PROFIL_OUTILS` (`src/llm/tool-policy.ts`), `complet: null` = aucun filtrage.
- Intersection : `filtrerSelonProfil(tools, profil)` — **le seul endroit** de la règle.
- Appliquée **dans** `toolAllowlist` (fin) et **dans** `toolAllowlistForChat`
  (**après** le socle `toujours`, sinon `programmer_envoi`/`planifier_tache`
  passeraient par cette porte).
- Le profil ne peut que **RETIRER** : `chat.remoteAgents = desactive` + profil
  `complet` ⇒ `delegate` reste absent (test dédié).

## ② Les trois profils

| Profil | Builtins | Outils custom |
|---|---|---|
| `complet` | `read, ls, grep, find` | inchangé (ce que le câblage active) |
| `lecture` | **aucun** | `envoyer_message`, `envoyer_fichier`, `lister_fichiers`, `lire_fichier`, `publier_dans_canal`, `recherche_libraire`, `liste_libraire`, `lire_libraire`, `lire_page_web`, `capture_libraire`, `generer_image`, `consulter_workflow` (12) |
| `accueil` | **aucun** | `envoyer_message`, `envoyer_fichier`, `lister_fichiers`, `lire_fichier`, `publier_dans_canal` (5) |

**Retirés aux deux** (17 pour `lecture`, 24 pour `accueil`) : `run_command`,
`capturer_ecran`, `recuperer_fichier`, `deposer_fichier`, `lister_agents`,
`etat_agent`, `lister_secrets`, `demander_secret`, `delegate` + `job_status` +
`cancel_job` + `steer_job`, `archive_vie_anterieure`,
`chercher_conversations_archivees`, `archive_libraire`, `programmer_envoi`,
`planifier_tache`. Raisons (dans `PROFIL_OUTILS`) : aucun builtin car
`read/ls/grep/find` ouvrent le **volume de travail** ; `programmer_envoi` et
`planifier_tache` sont des actes de **rédacteur de fond** (« un seul rédacteur »).

⚠️ L'intersection est réelle : `lister_fichiers`/`lire_fichier` sont autorisés
par le profil mais **pas portés** par le rôle léger local
(`TOOL_POLICY.light.fileList/fileRead: []`) — ils n'apparaissent qu'en canal,
via le socle `toujours`.

## ③ Le worker lourd : structurel

- Garde : `workerLourdAutorise` / `construireWorkerLourdSiAutorise`
  (`src/bots/profils.ts`).
- Point d'instanciation UNIQUE : `src/index.ts` (`construireWorkerLourdSiAutorise(profilBot, () => createSdkHeavyWorker({…}))`).
  `profil !== "complet"` ⇒ **aucune** instance ⇒ `run_command` ne peut pas
  exister, **même** par un job importé ou une tâche planifiée.
- Conséquences câblées : `delegation` n'est construit que si le worker existe,
  `delegationEnabled` suit, le port n'est pas donné au host local.
- **Les trois points d'intersection** : allowlist lourde (`toolAllowlist("heavy")`,
  `profil` passé aussi — redondance de ceinture), host local et run de canal
  (`lightToolOptions()` porte `profil`, donc `toolAllowlistForChat` filtre les deux).
- **Le profil vient du bot actif** : `bots.bot?.profil ?? "complet"`
  (`src/index.ts:333`, lu une fois au démarrage). **Aucune** valeur de requête ;
  le registre **refuse** un profil hors `PROFILS_BOT` (`src/bots/registry.ts:298-302`)
  et une valeur inconnue vaut refus total (`filtrerSelonProfil` → `[]`).

## ④ Ce qui reste possible

`lecture` : parler (local et canal), envoyer/lister/lire les fichiers de la
conversation, publier dans un canal suivi, libraire + pages web, images.
`accueil` : parler, fichiers de la conversation, publication dans un canal suivi.
Rien de plus : pas de commande, pas de capture, pas d'agents, pas de secrets, pas
de délégation, pas d'archivage, pas d'envoi programmé, pas de tâche planifiée.

## ⑤ Interface

Onglet **Général** de `/bots` (`public/ui/config.js:1436`, `renderBotGeneral`) : le
libellé **et** une phrase « Capacités : … » qui dit ce que le profil autorise
vraiment. Les phrases vivent dans `PROFILS_BOT_PAGE.capacites`
(`public/ui/config-pages.js`) et sont **vérifiées** contre la table d'outils
(`tests/ui/config-pages.test.ts` ⑦) : `textContent` seulement, aucun `innerHTML`,
aucun `.style.`, CSP inchangée.

## ⑥ Tests

- `tests/llm/tool-policy-profil.test.ts` — table de vérité **exhaustive**
  profil × outil (29 outils custom = `Object.keys(REMOTE_TOOL_GROUP_OF)`),
  profil × builtin, intersection vs remplacement, non-régression `complet`.
- `tests/bots/profils.test.ts` — **espion** : `profil !== "complet"` ⇒ fabrique
  jamais appelée ; + test de source : `createSdkHeavyWorker` n'est appelé qu'une
  fois, en argument de `construireWorkerLourdSiAutorise`.
- `tests/ui/config-pages.test.ts` ⑦ — phrases des profils cohérentes avec la table.
- **Preuve d'échec sur l'origine** : arbre gelé dans `/tmp/preuve-lot35f`
  (HEAD `968d513` + arbre de travail des lots 1a→1b-4/35e, copié **avant** toute
  écriture) : les 3 fichiers donnent **21 échecs / 39 succès**, contre
  **60 succès** sur le nouvel arbre.

## Invérifiable sans instance

Le comportement d'une vraie session de bot `lecture` (aucun `run_command` reçu par
le modèle, aucun job relancé au démarrage) n'a pas été exercé sur une instance :
la preuve est structurelle (worker non instancié) + table d'outils testée.
