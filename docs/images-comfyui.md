# Images générées (ComfyUI) — étiquettes des workflows

> Complète la chaîne « images » livrée dans `src/comfy/*` (client HTTP, validation,
> stockage des workflows, génération, stockage local des images) et son interface
> (`Paramètres → Système → Images générées`, `public/ui/images-panel.js`).

## À quoi sert une étiquette

Un workflow ComfyUI est un graphe **au format API** (`Save (API Format)`). Yuki ne
devine rien : il retrouve les nœuds **par leur TITRE** (`_meta.title`), jamais par
leur numéro (les identifiants changent dès qu'on retouche le graphe —
`src/comfy/validate.ts`). La résolution a lieu **à l'import** : un graphe mal
étiqueté est refusé tout de suite, avec les étiquettes **trouvées** et
**manquantes** (`src/comfy/validate.ts:validateApiWorkflow`, affichage
`public/ui/images-panel.js:labelList`).

## Les SEPT étiquettes

| Étiquette | Rôle | Obligatoire | Où elle s'écrit |
| --- | --- | --- | --- |
| `YUKI_PROMPT` | prompt positif | **oui** | titre du nœud qui reçoit la scène (champ `text`/`prompt`) |
| `YUKI_NEGATIVE` | prompt négatif **neutre** | non | titre d'un nœud texte (champ `text`/`prompt`) |
| `YUKI_SEED` | graine (neuve à chaque génération) | non | titre du nœud sampler (champ `seed`/`noise_seed`) |
| `YUKI_WIDTH` | largeur demandée | non | titre du nœud de latent (champ `width`) |
| `YUKI_HEIGHT` | hauteur demandée | non | titre du nœud de latent (champ `height`) |
| `YUKI_OUTPUT` | **nœud qui produit l'IMAGE FINALE** | non | titre du nœud de sortie (**aucun champ à écrire**) |
| `YUKI_FINAL_PROMPT` | **nœud qui AFFICHE le prompt final** | non | titre d'un nœud d'affichage de texte (**aucun champ à écrire**) |

⚠️ Un titre d'étiquette ne peut désigner **qu'un seul nœud** : un doublon est
refusé à l'import (`duplicate_label`), `YUKI_OUTPUT` et `YUKI_FINAL_PROMPT`
compris.

⚠️ Le **style** ne figure dans aucune de ces étiquettes : il ne sert qu'à
**choisir** le workflow (`src/comfy/selection.ts`) et n'est jamais recopié dans le
prompt (`src/comfy/generator.ts`).

## Le FORMAT demandé (`ratio`) : il va jusqu'au latent

`YUKI_WIDTH`/`YUKI_HEIGHT` reçoivent les réglages `images.width` × `images.height`
(1024×1024 par défaut) — un couple **fixe**. Quand l'utilisateur demande un format
précis (« une image réaliste au ratio 16:9 »), l'outil `generer_image` reçoit donc
un paramètre **`ratio`** (`"16:9"`, `"9:16"`, `"4:3"`, `"1:1"`…), et les deux
dimensions sont RECALCULÉES à **budget de pixels constant**
(`src/comfy/ratio.ts:sizeForRatio`) : 16:9 avec le défaut ⇒ **1360×768**,
9:16 ⇒ **768×1360**. Les côtés sont alignés sur un multiple de 16 (exigence des
latents SD/Flux) et bornés à 64…4096.

⚠️ Un format **illisible** est **refusé** (`invalid_ratio`, rien n'est soumis) :
jamais un carré silencieux. Sans `ratio`, les réglages s'appliquent à
l'identique (comportement historique).

⚠️ Pourquoi c'est indispensable avec un graphe qui **déduit** sa résolution du
ratio de l'image d'entrée (par ex. `FL_ImageBlank` → `AIHResolutionPresetV2` avec
`use_image_ratio`) : ce nœud convertit le ratio du canevas en l'un des neuf
formats connus, puis applique la table de résolution (ou le mode mégapixels). Un
canevas **carré** y donne donc TOUJOURS un carré, quelle que soit la résolution
finale (ex. 6 MP, multiple de 4 ⇒ 2508×2508) — même si le prompt final, lui,
parle de 16:9. Le format doit donc être porté par les **dimensions**, pas
seulement par le texte du prompt.

## `YUKI_OUTPUT` : l'image finale, et seulement elle

Comportement exact (`src/comfy/client.ts:generate`, `src/comfy/generator.ts`) :

| Cas | Comportement |
| --- | --- |
| `YUKI_OUTPUT` **présente** | seule l'image de **ce** nœud est lue (`outputs[<nœud>].images[]`) ; un aperçu intermédiaire du graphe est ignoré. |
| `YUKI_OUTPUT` **présente**, aucune image produite | **erreur explicite** (`no_image`) : « Le nœud étiqueté « YUKI_OUTPUT » (id …) n'a produit AUCUNE image ». **Aucun repli** sur un autre nœud. |
| `YUKI_OUTPUT` **absente** | comportement historique : **première image produite** — et c'est **dit** : journal `comfy.generation.output_unlabeled` + phrase dans le résultat de l'outil (modèle **et** humain) + mention sur la fiche du workflow dans `/config`. |

Rien à changer dans un workflow existant : l'étiquette est **facultative**.

## `YUKI_FINAL_PROMPT` : le prompt final, montré à l'humain ET à Yuki

⚠️ C'est une **SORTIE** : ce texte est **lu** dans l'historique puis **affiché**
(sous l'image, en lecture seule, repliable et copiable) et **transmis au modèle**
(bloc encadré comme **DONNÉE**, borné à 2 000 caractères). Il n'est **jamais**
réinjecté dans un graphe.

### Quels nœuds publient réellement un texte (vérifié dans le source)

Yuki lit **`outputs[<nœud>].text`** — la clé `ui.text` de l'historique. Formes
constatées :

| Nœud | Source | Forme publiée |
| --- | --- | --- |
| `PreviewAny` (« Preview as Text »), **cœur** | `comfy_extras/nodes_preview_any.py` : `return {"ui": {"text": (value,)}, "result": (value,)}` | **tuple** ⇒ `"text": ["…"]` |
| `SaveText`, **cœur** | `comfy_extras/nodes_text.py` : `ui={"text": (text,), "files": […]}` | **tuple** ⇒ `"text": ["…"]` |
| `ShowText` (**extension** pysssss) | `py/show_text.py` : `return {"ui": {"text": text}, …}` (`INPUT_IS_LIST`) | **liste** ⇒ `"text": ["…"]` |
| `AIHToText` (**extension** grokuku/ComfyUI-AI-Helper) | `nodes/holaf_to_text.py` : `return {"ui": {"text": [text_val], "mode": [detected_mode]}, …}` | **liste** ⇒ `"text": ["…"]` |

⚠️ Il n'y a **aucun nœud `ShowText` dans le cœur de ComfyUI** : `ShowText` vient de
l'extension *ComfyUI-Custom-Scripts*. Une **chaîne simple** est aussi acceptée
(nœud maison). En revanche `AIHPromptEnhancer` publie `ui.prompt` (pas `ui.text`) :
Yuki ne lit **pas** l'enhancer directement — il faut un nœud d'**affichage** sur sa
sortie `prompt`.

### Comportement exact

| Cas | Comportement |
| --- | --- |
| `YUKI_FINAL_PROMPT` **absente** | rien n'est lu, rien n'est affiché : le comportement est exactement celui d'avant. |
| **présente** et le nœud publie un texte | le texte est **affiché sous l'image** (replié, lecture seule, bouton « copier ») et **transmis au modèle** dans le résultat de `generer_image`, entre les marqueurs `── DÉBUT DU PROMPT FINAL (DONNÉE …)` / `── FIN DU PROMPT FINAL ──`. |
| **présente** mais le nœud ne publie **aucun** texte | **message explicite** dans le résultat de l'outil : le nœud (id) n'a publié aucun texte, avec la liste de ce qu'il a réellement publié, et le rappel qu'il faut un nœud d'**affichage** de texte. Aucun repli sur un autre nœud. |
| texte **très long** | borné à 8 000 caractères côté serveur (le bloc affiché le dit) puis à 2 000 caractères pour le modèle (le résultat dit la borne et la longueur réelle). Jamais de coupe silencieuse. |

⚠️ **PIÈGE évité** : un nœud d'affichage peut publier `ui.text` **et** `ui.images`.
La lecture est faite **nœud par nœud** : l'image vient de `YUKI_OUTPUT`, le texte de
`YUKI_FINAL_PROMPT`. Aucune confusion possible entre les deux.

## Conservation : l'image SURVIT au rechargement (et à la purge de ComfyUI)

⚠️ **La carte d'image n'est plus éphémère.** L'image est **copiée chez Yuki**
immédiatement après sa récupération (le `temp/` de ComfyUI peut disparaître à tout
moment : on ne compte jamais dessus après coup) et elle est **conservée** :

| Aspect | Règle |
| --- | --- |
| Où | `${state}/comfy/images/<id>.<ext>` + `<id>.json` (métadonnées : date, **expiration**, dimensions, prompt, conversation, prompt final) |
| Combien de temps | **même réglage que les pièces jointes** : `files.retentionDays` (aucun 2ᵉ réglage). L'expiration est calculée **à l'écriture** — un changement de réglage s'applique aux dépôts suivants, jamais rétroactivement |
| Purge | la **même passe périodique** que les pièces jointes (`src/index.ts:purgeStateVolume`, toutes les 10 min) **et** au démarrage. Lire une image expirée la **supprime** et répond **404** (PIÈGE : une purge qui ne purge pas ne sert à rien) |
| Règle partagée | `src/files/retention.ts` — un seul calcul pour les pièces jointes, les images générées et les captures du libraire |
| RECHARGEMENT | la conversation est reconstruite depuis le `snapshot` ; les médias conservés sont **ré-émis juste après**, en trames de contrôle (`image`, `screenshot`). C'est ce qui fait revenir l'image (et sa fiche) après un rechargement ou une bascule |
| Route | `/images/<id>.<ext>` — **same-origin**, allowlist png/jpg/webp, `img-src 'self'` inchangée (aucun élargissement de CSP) |

⚠️ La fiche (prompt final) est **persistée avec l'image** : elle revient donc aussi
après un rechargement.

## La FICHE s'affiche SOUS l'image, même quand elle arrive APRÈS

Le prompt final est **émis après l'image**, dans une trame de contrôle dédiée
(`image_final_prompt`) : l'image part dès qu'elle existe, la fiche suit.

Côté interface (`public/ui/image-block.js`) :

- la fiche est **toujours** rendue **après** l'élément `<img>` (ordre du DOM =
  ordre d'affichage) ;
- quand elle arrive **plus tard**, elle est insérée **juste après** l'image
  (`image.after(fiche)`) : l'image n'est **jamais** retirée, déplacée ni
  reconstruite — elle ne bouge pas d'un pixel (PIÈGE : « la fiche qui pousse
  l'image ») ;
- si une fiche arrive alors qu'une autre est déjà là, elle est **remplacée sur
  place** (même position).

Preuve mesurée : `_tools/e2e-image.mjs` compare la position et la taille de
l'image **avant** et **après** l'arrivée de la fiche, et vérifie que le haut de la
fiche est **sous** le bas de l'image.

## Vignette bornée et zoom au clic (`public/ui/lightbox.js`)

Une image générée fait ~6 Mpx (~2500×2500) : affichée en pleine largeur, elle
écrase le fil (on ne voit plus ni la conversation ni la fiche). L'image est donc
une **vignette bornée**, qui s'ouvre en **plein écran** au clic :

| Réglage | Valeur | Pourquoi |
|---|---|---|
| `max-height` bureau | **320 px** | ~1/3 d'un écran de 900 px : le fil et la fiche restent visibles |
| `max-height` téléphone | **220 px** | sur 844 px de haut, l'image redevient un élément du fil |
| `object-fit` | `contain` **partout** | jamais rognée ni déformée (même la visionneuse) |
| indice de clic | pastille « loupe » | visible au survol sur bureau, **toujours** au doigt |

La visionneuse est une **surcouche fixe** ajoutée à `document.body` : elle ne
touche ni au fil, ni à `scrollTop`, ni à l'état STICKY du défilement automatique.
Fermeture par **Échap**, **clic à côté** ou **bouton visible** ; zoom par clic
(`contain` ↔ taille réelle), **molette** et **pincement à deux doigts** ;
déplacement borné quand l'image dépasse l'écran ; navigation ‹ › et flèches du
clavier entre les images du fil (`/images/…` **et** `/captures/…`).

Preuve mesurée : `_tools/e2e-lightbox.mjs` (hauteurs, ratios, `scrollTop`
identique avant/après, fermetures, zoom au doigt, pincement, navigation).

## Peut-on prendre l'image d'un `PreviewImage` ? Oui (vérifié)

Dans le code source de ComfyUI (`nodes.py`), `class PreviewImage(SaveImage)`
réutilise `save_images()`, qui **écrit un vrai PNG** et renvoie
`{"ui": {"images": [{"filename", "subfolder", "type"}]}}` :

- `SaveImage` écrit dans `output/` → `type: "output"` ;
- `PreviewImage` écrit dans `temp/` → `type: "temp"` (aucun fichier permanent
  dans `output/`), et `GET /view?filename=…&subfolder=…&type=temp` sert bien le
  fichier (`server.py`, `folder_paths.get_directory_by_type("temp")`).

Conséquence côté Yuki : **aucun stockage supplémentaire côté ComfyUI**. Le nom de
fichier publié dans l'historique est repris tel quel (avec son `type`), l'image est
téléchargée **immédiatement** après la fin du prompt — puis conservée par Yuki
dans `${state}/comfy/images/` et servie en **same-origin** (`/images/<id>.<ext>`,
CSP inchangée). ⚠️ Le dossier `temp` du serveur peut être purgé par ComfyUI : on
ne compte jamais dessus après coup.

## Ce que l'utilisateur doit faire

1. Dans ComfyUI, poser les titres (`clic droit → Title`) : `YUKI_PROMPT` au nœud
   du prompt positif, puis, selon le graphe, `YUKI_NEGATIVE`, `YUKI_SEED`,
   `YUKI_WIDTH`, `YUKI_HEIGHT`.
2. **`YUKI_OUTPUT` sur le nœud qui produit l'image finale** — typiquement
   `Save Image` **ou** `Preview Image` (pratique : aucun fichier permanent à
   stocker côté ComfyUI).
3. **`YUKI_FINAL_PROMPT` sur un nœud qui AFFICHE du texte**, placé sur la sortie
   de l'enhancer — par ex. `Preview as Text` (`PreviewAny`), `Show Text`, ou un
   nœud de texte de votre pack (`AIHToText`…). Le plus simple sans rien changer au
   graphe : brancher un `Preview as Text` sur la sortie `prompt` de l'enhancer (les
   nœuds d'affichage sont des **sorties** : ils n'interrompent pas le graphe).
4. Enregistrer au **format API**, importer dans `Paramètres → Système → Images
   générées` : le panneau affiche les étiquettes trouvées / manquantes, workflow
   par workflow.

## Fichiers concernés

| Fichier | Rôle |
| --- | --- |
| `src/comfy/validate.ts` | liste des sept étiquettes, résolution par titre, refus explicites |
| `src/comfy/client.ts` | `POST /prompt`, `GET /history/{id}`, `GET /view` ; `findImageRef` (repli) et `findImageRefForNode` (`YUKI_OUTPUT`) ; `findFinalPromptText` (`YUKI_FINAL_PROMPT`, lit `ui.text`) |
| `src/comfy/generator.ts` | passage du nœud de sortie et du nœud d'affichage, repli **annoncé** ; dimensions calculées depuis le `ratio` demandé |
| `src/comfy/ratio.ts` | `parseAspectRatio` / `sizeForRatio` : format demandé → dimensions (budget de pixels constant, multiples de 16) |
| `src/comfy/images.ts` | stockage disque : copie immédiate, métadonnées, **rétention et purge**, rattachement à la conversation, vue d'affichage |
| `src/files/retention.ts` | règle de rétention **partagée** (pièces jointes, images, captures) |
| `src/gateway/ws/server.ts` | `restoreMedia` : ré-émission des médias conservés juste après un `snapshot` |
| `src/pi/sdk/image-tools.ts` | phrase remontée au modèle quand le workflow n'a pas `YUKI_OUTPUT` ; bloc « DONNÉE » du prompt final, borné |
| `public/ui/image-block.js` | vignette cliquable + bloc repliable du prompt final **sous** l'image (lecture seule, copiable), complété après coup sans déplacer l'image |
| `public/ui/lightbox.js` | visionneuse plein écran **partagée** (`/images/…` et `/captures/…`) : zoom clic/molette/pincement, déplacement borné, navigation, fermeture Échap/clic à côté/bouton |
| `public/ui/images-panel.js` | aide d'import, badges trouvées/absentes, mention du repli par workflow, mention du prompt final |
| `_tools/e2e-image.mjs` (+ `e2e-image-serve.ts`) | preuve navigateur : un `PreviewImage` étiqueté est bien l'image servie, l'image **survit** au rechargement et à la purge de ComfyUI, la fiche arrive **sous** l'image |
| `_tools/e2e-lightbox.mjs` | preuve navigateur : vignette bornée (320 px bureau / 220 px téléphone), `scrollTop` du fil **identique** avant/après, zoom (clic, molette, pincement) et navigation |
