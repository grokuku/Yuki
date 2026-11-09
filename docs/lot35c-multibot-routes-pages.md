# Lot 35c — routes et pages multi-bot (1b-3 livré, 1b-4 non commencé)

## 1b-3 LIVRÉ — routes des bots, refus croisés, bascule des écrivains

### Routes (`src/gateway/routes/config.ts`)

| Route | Rôle |
|---|---|
| `GET /api/bots` | liste `id`, `nom`, `profil`, `actif`, `ordre` (triée par `ordre`) |
| `GET /api/bots/<id>/config` | valeurs effectives du bot demandé (`fields`, `status`, `voiceInstruction`) |
| `PUT /api/bots/<id>/config` | écriture des réglages du bot (`requireWriteGuards` identiques) |

- `isConfigPath` couvre désormais `/api/bots` et `/api/bots/…` (`app.ts:718`).
- **Refus croisés** (`ScopedFieldError`, `src/config/runtime.ts`) :
  - `PUT /api/config` sur une clé `bot` ⇒ `400 bot_scoped_field` ;
  - `PUT /api/bots/<id>/config` sur une clé `instance` ⇒ `400 instance_scoped_field` ;
  - une clé **`mixte` n'est jamais refusée** : elle a un côté sur chaque écran.
  - Le refus passe **avant** `locked_by_env`/`invalid_config` (problème de route, pas de valeur) et **rien n'est écrit**.
- **Clé `mixte`** : `portee: "instance"` sur `/api/config`, `portee: "bot"` sur `/api/bots/<id>/config`.
- **Bot inconnu** ⇒ `404 bot_not_found` avec `botId` et le message `Bot inconnu : « <id> ».`
- La liste de repli (aucun `bots.json`, gateway dégradé, tests) est **le bot actif du runtime**.

### Runtime (`src/config/runtime.ts`)

- Fusion **généralisée** : `effectif`/`origine`/`valeurBot`/`valeurConjonction` prennent l'overlay en paramètre ⇒ un seul chemin de fusion, quel que soit le bot.
- `snapshotPour(botId)` / `updatePour(botId, patch, options)` : l'overlay du bot **actif** reste en mémoire, celui d'un autre bot est lu/écrit **sur disque** (`<state>/bots/<id>/config.overlay.json`).
- `ConfigUpdateOptions.refuser?: "bot" | "instance"` et `ScopedFieldError`.
- Le snapshot porte désormais **`scope`** par champ : c'est ce qui permet à l'interface de découper son patch.

### Bascule des écrivains (⚠️ lot 30 préservé)

| Écrivain | Avant | Après |
|---|---|---|
| `public/ui/chat-mode.js:saveChatMode` | `PUT /api/config` | `PUT /api/bots/<id>/config` (`public/ui/bots-api.js`) |
| `public/ui/chat-panel.js` (agents/outils distants) | `PUT /api/config` | `PUT /api/bots/<id>/config` |
| `src/index.ts:saveMode` (lot 30) | `config.update({…})` | `config.update({…}, { portee: "bot" })` |
| `public/ui/voices-panel.js` (`tts.voice`) | `PUT /api/config` | `PUT /api/bots/<id>/config` |
| `public/ui/config.js` (barre « Enregistrer ») | 1 patch complet | **découpe par portée** (`splitConfigPatchByScope`) ⇒ 1 à 2 écritures |

`public/ui/bots-api.js` (nouveau) : `listerBots`, `idBotActif`, `cheminConfigBot` — repli `yuki` si la liste est illisible.

### Preuve d'échec sur l'origine

Arbre **propre** au départ (`HEAD = a43ae1f`) ⇒ `HEAD` **est** l'origine ; copie gelée dans `/tmp/preuve-1b34` **avant** toute modification. Rejeu des tests de 1b-3 sur cette copie : **13 échecs / 36 réussites** (`config-bots-api` 7/9 en échec, `config-api` 3/3 sur la route bot, `chat-mode` 1/1).

### Tests

- `tests/gateway/config-bots-api.test.ts` (nouveau, 9 tests) : liste, refus croisés + « rien n'est écrit », mixte des deux côtés puis relu, 404 nommant l'id, **garde du lot 30** (`saveChatMode` réel contre le vrai routeur), overlay d'un bot non actif.
- Mis à jour : `tests/gateway/config-api.test.ts` (`tts.speed` ⇒ route du bot), `tests/ui/chat-mode.test.ts` (URL + « aucune écriture sur `/api/config` »).

## 1b-4 NON COMMENCÉ

Reste à faire (inchangé) : `public/ui/bots.html` (6 onglets), `/config` réduit à 7 onglets,
éclatement de « Conversation » (`delegation`+`fichiers` → Instance · Exécution,
`memoire`+`chat-root` → Bot), sélecteur `<select>` + « ＋ », garde `HolafModal` sur
modifications non enregistrées, encarts de renvoi, mise à jour des 4 fichiers de test qui
verrouillent les 10 onglets et des 3 E2E critiques (`e2e-chat-sessions`, `e2e-tts-ui`,
`e2e-sources`), plus le lien `public/ui/index.html:376` ⇒ `/bots?b=yuki#declencheurs`.

⚠️ La page `/config` reste donc à **10 onglets** : elle n'affiche pas encore la séparation
Instance/Bot. Les écritures sont en revanche **déjà** aiguillées par portée (1b-3), donc la
page fonctionne sans changement visible.
