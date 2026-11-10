# Lot 35e — Ajouter / supprimer un bot (multi-bot, étape 5)

Ce lot rend la scission Instance / Bot **utile** : on peut créer un bot (de zéro ou
par clone), le voir dans le sélecteur, et le supprimer **sans rien effacer**.

## ① Créer

- `POST /api/bots` (`requireWriteGuards` + `X-Yuki-Config: 1`) — `src/gateway/routes/config.ts:780`.
- Corps : `{ nom, slug, profil?, avatar?, cloneDe?, elements? }`.
- Effets : `mkdir <state>/bots/<slug>/` + entrée du registre + `config.overlay.json`
  (vide en création de zéro, copié si « capacités » est cochée) — `src/bots/admin.ts:327` (`creerBot`).
- Ordre volontaire : **dossier d'abord, registre ensuite** ; une création qui échoue
  est annulée (dossier retiré), un dossier orphelin n'est jamais listé.
- Bornes : nom 1..40, **slug immuable** `^[a-z0-9][a-z0-9-]{1,30}$` (plus strict que
  `ID_BOT_PATTERN` : ni `_`), profils `complet | lecture | accueil`, **`MAX_BOTS = 6`**
  ⇒ `409 max_bots` **nommant la limite**.
- Après création, l'interface remplit le sélecteur puis navigue sur
  `/bots?b=<slug>` (`public/ui/config.js:creerBotDepuisModale`) : le nouveau bot est
  affiché et sélectionné.

## ② Cloner — les cases et leurs défauts

| Élément | Défaut | Copie |
|---|---|---|
| Identité | ✅ | `personality.md`, `rules.md`, `avatar/` |
| Capacités | ✅ | profil (entrée du registre) + `config.overlay.json` |
| Mémoire | ❌ | `memory.jsonl`, `memory-archive/`, `memory-heritage/`, `memory-consolidation.json` |
| Déclencheurs | ❌ | `sources.json`, `sources-inbox.json`, `declencheurs-journal.jsonl` |
| Agents autorisés | ❌ | **rien** (champ inexistant — voir ③) |

> **Pourquoi la mémoire est décochée** : un bot cloné **avec** la mémoire de Yuki
> **croirait avoir vécu la même chose** — ses souvenirs seraient ceux d'un autre, et
> il les raconterait à la première personne.

**Jamais copié** (liste noire `JAMAIS_COPIES`, `src/bots/admin.ts:187`) :
`chat-mirror.json` / `chat-mirror/` (un canal appartient à **un seul** bot),
`conversations-archive*`, `jobs.jsonl`, `preautorisations.json`,
`envois-programmes.json`, `session-pins.json`, `reactions.jsonl`, `librarian-*`,
`memory-index.sqlite` (index **dérivé**, reconstruit au démarrage — une copie à chaud
serait déchirée). Un élément qui oserait un de ces chemins **lève** (garde
`copierElements`). Les **sessions Pi** ne sont pas copiées non plus : autre volume.

## ③ Supprimer — n'efface rien

- `DELETE /api/bots/<id>` — `src/gateway/routes/config.ts:843`.
- `state/bots/<slug>/` est **déplacé** (`rename`, même volume) vers
  `state/bots-supprimes/<slug>-<AAAAMMJJ-HHMM>/` (UTC) puis l'entrée du registre est
  retirée — `src/bots/admin.ts:545` (`supprimerBot`). Les fichiers restent **intacts** ;
  deux suppressions dans la même minute ⇒ suffixe `-2`.
- Refus `409 last_bot` sur le **dernier** bot (une instance sans bot refuserait de
  démarrer : `AUCUN_BOT_ACTIF`).
- Si le bot supprimé était **actif** : le premier bot restant est promu (`actif`), et
  la réponse porte `rechargementRequis: true` — **le gateway en cours applique encore
  les chemins du bot supprimé**, l'interface le dit et demande un redémarrage.
  Côté page, `?b=` bascule sur le premier bot restant.
- **Point d'extension** « agents autorisés » : `OptionsSuppressionBot.retirerDesListesDAgents`
  (`src/bots/admin.ts`, branché sur le même champ dans `ConfigApiDeps.bots`). La
  décision utilisateur est que les agents sont **globaux** et portent la **liste** des
  bots autorisés ; ce champ **n'existe pas encore**, donc **rien n'est inventé** :
  sans rappel, la suppression ne touche à aucune liste d'agents.
- **Confirmation** : `GET /api/bots/<id>/donnees` rend les compteurs **réels**
  (conversations archivées, souvenirs, déclencheurs, taille du dossier) ; la modale
  affiche ces nombres, exige une **case à cocher** qui active le bouton destructeur
  (motif du lot 30, `onOpen` + `.holaf-modal-btn-danger.disabled`).

## ④ Rétention 3 mois

Les archives de bots supprimés sont purgées après **90 jours** par le **balayeur
existant** (`DeclencheurBalayeur`, port `archivesBots` — `src/sources/scheduler.ts`),
**aucun `setInterval` nouveau**. Purge **réelle** et **journalisée**
(`bot.archive.purged`, âge et rétention). Un nom d'archive non datable n'est **jamais**
supprimé. L'intervalle effectif est d'une passe par heure au maximum
(`src/index.ts`), pour ne pas parcourir le dossier à chaque tick de 30 s. L'UI de
suppression écrit noir sur blanc : « conservées 3 mois (90 jours) puis effacées ».

## ⑤ Interface

- `public/ui/bots-admin.js` (nouveau) : les deux modales (`HolafModal` uniquement,
  `textContent`, **aucun** `innerHTML`, **aucun** style inline).
- `public/ui/config-pages.js` : libellés, défauts de clone, validations, textes de
  confirmation (module **pur**, testé sans navigateur).
- Onglet « Général » de `/bots` : identité en lecture seule (le slug est **immuable**)
  + **zone de danger** avec le bouton de suppression réel.
- Les gardes CSP/`innerHTML`/`.style.` s'appliquent **aussi** au nouveau fichier
  (`tests/integration/static-ui.test.ts`, `tests/ui/config-pages.test.ts`).
- Le bouton « + » du sélecteur n'utilise plus le glyphe « ＋ » (tofu dans la police
  servie) : le bouton affiche « + ».

## Tests

- `tests/bots/admin.test.ts` — création, clone (défauts + jamais copiés), suppression
  (déplacement, `dernier_bot`, promotion), rétention 90/89 jours, compteurs.
- `tests/gateway/config-bots-admin-api.test.ts` — `POST`/`DELETE`/`donnees` par les
  routes (gardes d'écriture, `409 max_bots`, `409 last_bot`, bascule du bot actif).
- `tests/sources/balayeur.test.ts` — le port `archivesBots` est appelé par le tick,
  et un échec de purge ne casse pas le balayage.
- `tests/ui/config-pages.test.ts` + `static-ui.test.ts` — UI et gardes.
- ⚠️ **Deux assertions de `tests/ui/config-pages.test.ts` ont été INVERSÉES** (et non
  supprimées) : elles verrouillaient le report (« bientôt disponible », « aucun bouton
  de suppression »). Elles vérifient désormais la création réelle et la suppression
  archivante, avec les mêmes intentions (ce que fait le bouton, ce que dit la zone).

## Ce qui n'est pas fait / limites connues

- **Avatar** : accepté à la création (`data:` URL PNG/JPEG/WebP, validé par
  `AvatarStore`), **recadré carrément au centre** côté navigateur en 512×512 JPEG
  (`avatar-recadrage.js`). L'éditeur interactif de `public/ui/avatar.js` n'est pas
  réutilisé ici : il **enregistre immédiatement** sur `AVATAR_API_URL`, qui sert le
  bot **actif**. Un avatar de bot non actif n'est **pas affiché** sur `/bots`
  (`/avatar` sert l'avatar du bot actif) — la page le dit au lieu de montrer l'image
  d'un autre.
- **Sessions Pi** d'un bot supprimé : elles vivent sur le volume `pi`
  (`<pi>/agent/sessions/<slug>`), **hors** de l'archive `state` — non déplacées, non
  purgées par la rétention de ce lot.
- **Le profil** est persisté mais n'a **aucun effet** pour l'instant (« lecture » /
  « accueil » sont des étiquettes : l'application des profils est un lot ultérieur).
- Supprimer le bot **affiché** jette ses saisies non enregistrées (le bot n'existe
  plus) ; la modale de confirmation ne propose pas les trois choix du changement de bot.
- Le corps de `POST /api/bots` est borné à 1 Mo (`MAX_CONFIG_BODY_BYTES`) : l'avatar
  est compressé côté navigateur pour rester bien en dessous.
