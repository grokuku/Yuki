# Lot 34 — Avatar de Yuki

## 1. Emplacements (A + B, jamais dans les bulles)

- **A** — l'état vide (`public/ui/index.html:266-271`) affiche l'avatar dans le
  cercle de 76 px à la place du flocon ; le flocon (`data-avatar-fallback`) est
  le **repli** et n'apparaît jamais en même temps.
- **B** — `header .brand` (`index.html:36-41`) place l'avatar **24 px avant** le
  nom « Yuki ». En téléphone le nom est masqué mais l'avatar **reste visible**
  (22 px) : `body.has-avatar .brand { display: flex }` dans la requête média
  (`public/ui/styles.css`, bloc `@media (max-width: 767px)…`). Sans avatar,
  toute la marque est masquée (aucun trou dans la barre).
- ⚠️ **Aucun avatar dans les bulles** : `.message__head` n'est pas touché
  (garde statique dans `tests/ui/avatar-ui.test.ts`).

## 2. Recadrage assisté

`public/ui/avatar-recadrage.js` est une géométrie **PURE** (aucun DOM), testée
par `tests/ui/avatar-recadrage.test.ts` :

| Fonction | Rôle |
|---|---|
| `creerEtat` | état initial : zoom « couvre » (1), image centrée |
| `bornes` / `appliquerBornes` | marges exactes : **l'image couvre toujours le cercle** |
| `zoomer(etat, facteur, point)` | zoom borné `[1, 5]`, **ancré sous le curseur** |
| `deplacer(etat, dx, dy)` | glissement borné |
| `recentrer(etat)` | retour au zoom « couvre » et au centre |
| `recadrer(etat)` | rectangle **source** carré exact du cercle |
| `dessiner(ctx, image, etat, 512)` | `drawImage` vers un carré **512×512** |

L'éditeur (`public/ui/avatar.js`, HolafModal) câble : **molette = zoom**, **clic
gauche glissé = déplacer**, **glisser/pincer au doigt** (pointer events), boutons
**+ / − / Recentrer** et **clavier** (flèches, `+`, `−`, `Origine`). L'aperçu est
un `<canvas>` **masqué en cercle par CSS** ; la sortie est un PNG produit par
`canvas.toBlob` puis envoyé en corps binaire. Aucune URL d'objet du navigateur,
aucun style inline, aucun nœud construit par chaîne HTML.

## 3. Stockage et routes

**Hors du magasin de fichiers** (qui purge à 30 jours) : `state/avatar/`
(`src/identity/avatar.ts`), `YUKI_AVATAR_DIR`, image + `avatar.json`
(`{sha256, bytes, updatedAt, largeur, hauteur, mime, fichier}`), écritures
**atomiques 0600** (temp + `rename`), image écrite **avant** les métadonnées.

| Route | Comportement |
|---|---|
| `GET /avatar` (`?v=<sha>`) | `image/png` (ou le format déposé), `public, max-age=31536000, immutable`, **404** si absent |
| `GET /api/avatar` | `{ existe, sha256, updatedAt, taille, largeur, hauteur }` |
| `POST /api/avatar` | `X-Yuki-Config: 1` + même origine, ≤ 2 Mio, ≤ 4096 px, **format déduit de la signature binaire** (un `.txt` renommé `.png` est refusé) |
| `DELETE /api/avatar` | retire l'avatar (retour au flocon) |
| `GET /favicon.ico` | l'avatar s'il existe, sinon `public/ui/icons/icon-192.png` |

## 4. Réglage, favicon et vérification

`/config` → **Personnalité** → section **« Avatar »** (`creerSectionAvatar` dans
`public/ui/avatar.js`) : aperçu 48 px, « Changer l'avatar » (éditeur HolafModal),
« Retirer » (confirmation **HolafModal**, jamais `window.confirm`).
`index.html` déclare `<link id="favicon" rel="icon" href="/favicon.ico">` ;
`appliquerAvatar` le remplace par `/favicon.ico?v=<sha>` **sans rechargement**.
La CSP est **inchangée** (`img-src 'self' data:`) : aucun `blob:`.

Tests : `tests/ui/avatar-recadrage.test.ts`, `tests/identity/avatar.test.ts`,
`tests/gateway/avatar-api.test.ts`, `tests/ui/avatar-ui.test.ts`. Vérification
visuelle : état vide avec/sans avatar, barre du haut (1440 px et 390 px), éditeur
ouvert.
