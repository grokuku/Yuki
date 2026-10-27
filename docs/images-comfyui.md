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

## Les SIX étiquettes

| Étiquette | Rôle | Obligatoire | Où elle s'écrit |
| --- | --- | --- | --- |
| `YUKI_PROMPT` | prompt positif | **oui** | titre du nœud qui reçoit la scène (champ `text`/`prompt`) |
| `YUKI_NEGATIVE` | prompt négatif **neutre** | non | titre d'un nœud texte (champ `text`/`prompt`) |
| `YUKI_SEED` | graine (neuve à chaque génération) | non | titre du nœud sampler (champ `seed`/`noise_seed`) |
| `YUKI_WIDTH` | largeur demandée | non | titre du nœud de latent (champ `width`) |
| `YUKI_HEIGHT` | hauteur demandée | non | titre du nœud de latent (champ `height`) |
| `YUKI_OUTPUT` | **nœud qui produit l'IMAGE FINALE** | non | titre du nœud de sortie (**aucun champ à écrire**) |

⚠️ Un titre d'étiquette ne peut désigner **qu'un seul nœud** : un doublon est
refusé à l'import (`duplicate_label`), `YUKI_OUTPUT` compris.

⚠️ Le **style** ne figure dans aucune de ces étiquettes : il ne sert qu'à
**choisir** le workflow (`src/comfy/selection.ts`) et n'est jamais recopié dans le
prompt (`src/comfy/generator.ts`).

## `YUKI_OUTPUT` : l'image finale, et seulement elle

Comportement exact (`src/comfy/client.ts:generate`, `src/comfy/generator.ts`) :

| Cas | Comportement |
| --- | --- |
| `YUKI_OUTPUT` **présente** | seule l'image de **ce** nœud est lue (`outputs[<nœud>].images[]`) ; un aperçu intermédiaire du graphe est ignoré. |
| `YUKI_OUTPUT` **présente**, aucune image produite | **erreur explicite** (`no_image`) : « Le nœud étiqueté « YUKI_OUTPUT » (id …) n'a produit AUCUNE image ». **Aucun repli** sur un autre nœud. |
| `YUKI_OUTPUT` **absente** | comportement historique : **première image produite** — et c'est **dit** : journal `comfy.generation.output_unlabeled` + phrase dans le résultat de l'outil (modèle **et** humain) + mention sur la fiche du workflow dans `/config`. |

Rien à changer dans un workflow existant : l'étiquette est **facultative**.

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
3. Enregistrer au **format API**, importer dans `Paramètres → Système → Images
   générées` : le panneau affiche les étiquettes trouvées / manquantes, workflow
   par workflow.

## Fichiers concernés

| Fichier | Rôle |
| --- | --- |
| `src/comfy/validate.ts` | liste des six étiquettes, résolution par titre, refus explicites |
| `src/comfy/client.ts` | `POST /prompt`, `GET /history/{id}`, `GET /view` ; `findImageRef` (repli) et `findImageRefForNode` (`YUKI_OUTPUT`) |
| `src/comfy/generator.ts` | passage du nœud de sortie, repli **annoncé** |
| `src/pi/sdk/image-tools.ts` | phrase remontée au modèle quand le workflow n'a pas `YUKI_OUTPUT` |
| `public/ui/images-panel.js` | aide d'import, badges trouvées/absentes, mention du repli par workflow |
| `_tools/e2e-image.mjs` (+ `e2e-image-serve.ts`) | preuve navigateur : un `PreviewImage` étiqueté est bien l'image servie |
