# Lot 30 — Débrancher / supprimer une connexion + sélecteur de mode conditionnel

Deux demandes utilisateur (2026-11-05) : pouvoir **supprimer une connexion**
Mattermost ou Discord, et ne montrer le sélecteur **Local · Mattermost · Discord**
que s'il y a **plus d'un type de discussion actif**.

## 1. Deux actions DISTINCTES (jamais une seule)

| Action | Effet | Réversible | Où |
| --- | --- | --- | --- |
| **Débrancher** | efface le **jeton** du coffre + **arrête la synchro** (WS fermé, balayeur arrêté) — ⚠️ **le miroir RESTE** | oui (remettre le jeton) | `DELETE /api/chat/<plateforme>/connexion` |
| **Supprimer la connexion** | efface le **jeton ET le miroir** (`chat-mirror.json` + les `chat-mirror/<id>.jsonl` de cette plateforme) | ⚠️ **non** | `DELETE /api/chat/<plateforme>/miroir` |

- Routes : `src/gateway/routes/chat.ts` (gardées par `requireWriteGuards` — même
  helper que `/api/config`, en-tête `X-Yuki-Config: 1`).
- Effacement du jeton : `SecretStore.delete` (`src/secrets/store.ts:146`) — le
  coffre **savait déjà** supprimer, aucune extension d'API n'a été nécessaire.
  Un coffre verrouillé **lève**, et la route rend `502` : on ne prétend jamais
  avoir effacé un jeton qu'on n'a pas pu effacer.
- Arrêt de la synchro : `adapter.disconnect()` (`src/chat/mattermost/adapter.ts:268`,
  `src/chat/discord/adapter.ts:329`) = `socket.stop()` + `sync.stop()` ; câblage
  `src/index.ts` (`deconnecter`, `miroir`, `supprimerMiroir` des deux ports).
- Suppression du miroir : `ChatMirrorStore.purgePlatform` (`src/chat/mirror/store.ts`)
  — **confinée** : seules les conversations dont l'index dit
  `platform === <plateforme>` (un `mm-…` n'emporte jamais un `dc-…`), et chaque
  chemin passe par `fileOf` (nom réduit à `[A-Za-z0-9_-]` + `join(messagesDir, …)`),
  donc aucune traversée `../`. L'annuaire des noms d'auteurs de la plateforme est
  purgé aussi (`AuthorDirectory.purge`).
- ⚠️ **Confirmation exigée par le serveur** : sans `{"confirmation": true}` dans le
  corps, `400 confirmation_requise` et **rien** n'est détruit.
- ⚠️ `chat.mode` **retombe sur `local`** si c'était la plateforme supprimée
  (`deps.saveMode`, câblé sur `config.update({"chat.mode"})`), sinon l'UI
  afficherait un mode mort.
- Journal : `chat.platform_disconnected` / `chat.platform_removed` — plateforme,
  compteurs, mode avant/après. **Aucun jeton, aucune URL complète.**

### UI (`/config` → Conversation → « Discussions — Mattermost » / « — Discord »)
Deux boutons : **« Débrancher »** (discret, `button--ghost`) et **« Supprimer la
connexion »** (rouge, `button--stop`). Avant la suppression, `HolafModal`
(case à cocher **explicite**, bouton destructeur **désactivé** tant qu'elle n'est
pas cochée) affiche **N conversations, N messages, taille du miroir**
(`vue.miroir`, `texteSuppression`). Jamais `window.confirm`, jamais `innerHTML`.

## 2. Sélecteur visible seulement si ≥ 2 types actifs

**Définition d'« actif » retenue** (`modesActifs`, `public/ui/chat-mode.js`) :
`local` est **toujours** actif ; une plateforme est active si un **jeton est au
coffre** (`jetonEnregistre`) **ou** si son **miroir garde ≥ 1 conversation**.

⚠️ Pourquoi pas `etat === "on"` (connectée seulement) : une plateforme configurée
mais en erreur (jeton refusé, serveur injoignable) est exactement le moment où
l'on veut **garder son onglet** pour lire la raison ; et une plateforme
**débranchée** garde ses conversations miroir — les masquer les rendrait
inaccessibles.

- `selectorVisible` : `< 2` types actifs ⇒ conteneur **masqué** (`hidden`, pas
  grisé), et un mode **inactif n'apparaît pas non plus dans** le sélecteur.
- État **inconnu** (gateway injoignable) ⇒ visible : on ne retire pas un contrôle
  à l'aveugle.
- **Mise à jour à chaud** : `initChatModeSelector().update(status)` recalcule à
  chaque statut (aucun rechargement). ⚠️ Le statut est relu à la connexion et après
  un changement de mode (`app.js`) : une modification faite dans un AUTRE onglet
  s'applique donc au prochain statut reçu, pas instantanément.
- Mode courant devenu inactif ⇒ `resolveActiveMode` + `applyChatStatus`
  (`public/ui/app.js`) redemandent le seul mode actif par `saveChatMode`
  (`PUT /api/config`) puis `chat_refresh` : la trame `sessions` reste autoritaire
  côté serveur.

## 3. Tests

- `tests/chat/deconnexion-plateformes.test.ts` (adaptateur Mattermost **réel**,
  serveur fixture HTTP+WS, miroir sur disque, coffre chiffré réel) : débrancher
  (jeton parti, WS fermé, `synchro.demarre === false`, miroir **intact**),
  supprimer (mm- effacé / dc- **intact**, jeton compris), refus sans confirmation,
  `chat.mode → local`, traversée `../` confinée.
- `tests/ui/deconnexion-plateformes.test.ts` : `modesActifs` / `selectorVisible` /
  `resolveActiveMode`, masquage DOM + mise à jour à chaud, textes de décompte,
  présence des **deux** boutons, case à cocher obligatoire, corps
  `{"confirmation": true}` envoyé au serveur.
- ⚠️ Preuve d'échec sur l'origine : copie de l'arbre dans `/tmp`, fichiers
  remplacés par `git show HEAD:` (HEAD **ne suffisait pas** : `src/index.ts`
  porte des lots non commités) ⇒ **30 tests sur 32 échouent**. Les 2 restants
  sont des gardes de régression (403 sans en-tête, `aria-pressed` du mode
  courant) qui passent aussi sur l'origine, par construction.

## 4. Ce qui n'est pas couvert

- Aucun test de bout en bout **Discord** pour l'arrêt de la passerelle : la
  symétrie est vérifiée dans le code (`discord/adapter.ts:329`, mêmes appels
  `socket.stop()` + `sync.stop()`), le test utilise un port Discord sans réseau.
- Le décompte « octets » est la taille des `.jsonl` de la plateforme ; il exclut
  l'index (`chat-mirror.json`) et l'annuaire des noms.
