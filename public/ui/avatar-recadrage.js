/**
 * Géométrie PURE du recadrage d'avatar — aucune dépendance au DOM.
 *
 * Le cœur du recadrage assisté : l'image est DÉPLACÉE et ZOOMÉE derrière un
 * cercle d'aperçu, et la sortie est toujours un carré de 512 px. Toute la
 * géométrie vit ici pour être testée sans navigateur (`tests/ui/avatar-recadrage.test.ts`) :
 * le rendu (`canvas`) ne fait qu'appliquer `recadrer()`.
 *
 * Modèle d'état (aucune unité cachée) :
 *   - `largeurImage` / `hauteurImage` : dimensions NATURELLES de l'image (px) ;
 *   - `diametre` : diamètre du cercle d'aperçu, en px CSS ;
 *   - `echelle` : zoom RELATIF au « couvre » (1 = l'image couvre exactement le
 *     cercle par son petit côté) ;
 *   - `x` / `y` : décalage du CENTRE DE L'IMAGE par rapport au centre du cercle,
 *     en px CSS (positif = image déplacée vers la droite / le bas).
 *
 * ⚠️ INVARIANT CENTRAL : l'image couvre TOUJOURS le cercle. Il est garanti par
 * `appliquerBornes` (appelé après chaque zoom et chaque déplacement) : on ne
 * peut jamais faire apparaître un coin vide.
 */

/** Côté du carré produit (et donc de l'avatar stocké). */
export const TAILLE_SORTIE = 512;
/** Zoom minimal : l'image couvre tout juste le cercle (aucun coin vide). */
export const ZOOM_MIN = 1;
/** Zoom maximal : 5× le « couvre » (au-delà, les pixels deviennent flous). */
export const ZOOM_MAX = 5;
/** Diamètre par défaut du cercle d'aperçu (px CSS). */
export const DIAMETRE_APERCU = 240;

function nombreFini(value, nom) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${nom} doit être un nombre fini.`);
  }
  return value;
}

function borner(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * État initial : image centrée, au zoom « couvre ».
 *
 * @param {{ largeurImage: number, hauteurImage: number, diametre?: number }} dimensions
 */
export function creerEtat(dimensions) {
  const largeurImage = nombreFini(dimensions?.largeurImage, "largeurImage");
  const hauteurImage = nombreFini(dimensions?.hauteurImage, "hauteurImage");
  if (largeurImage <= 0 || hauteurImage <= 0) {
    throw new RangeError("L'image doit avoir des dimensions strictement positives.");
  }
  const diametre = nombreFini(dimensions?.diametre ?? DIAMETRE_APERCU, "diametre");
  if (diametre <= 0) throw new RangeError("Le diamètre d'aperçu doit être positif.");
  return { largeurImage, hauteurImage, diametre, echelle: ZOOM_MIN, x: 0, y: 0 };
}

/** Échelle ABSOLUE (px rendus par px source) à l'état donné. */
export function echelleAbsolue(etat) {
  const petitCote = Math.min(etat.largeurImage, etat.hauteurImage);
  return (etat.diametre / petitCote) * etat.echelle;
}

/** Taille rendue de l'image (px CSS) — toujours ≥ au diamètre du cercle. */
export function tailleRendue(etat) {
  const echelle = echelleAbsolue(etat);
  return {
    largeur: etat.largeurImage * echelle,
    hauteur: etat.hauteurImage * echelle,
  };
}

/**
 * Déplacements autorisés du centre de l'image : la marge est exactement ce qui
 * dépasse du cercle, donc la bordure de l'image ne peut jamais entrer dans le
 * cercle.
 */
export function bornes(etat) {
  const rendue = tailleRendue(etat);
  const margeX = Math.max(0, (rendue.largeur - etat.diametre) / 2);
  const margeY = Math.max(0, (rendue.hauteur - etat.diametre) / 2);
  return { minX: -margeX, maxX: margeX, minY: -margeY, maxY: margeY };
}

/** Ramène `x`/`y` dans les bornes (sans muter l'état d'entrée). */
export function appliquerBornes(etat) {
  const limite = bornes(etat);
  return {
    ...etat,
    x: borner(etat.x, limite.minX, limite.maxX),
    y: borner(etat.y, limite.minY, limite.maxY),
  };
}

/**
 * Zoome d'un FACTEUR (1 = aucun changement), en gardant immobile le point
 * `point` (px CSS relatifs au centre du cercle — la molette zoome sous le
 * curseur). Le zoom est borné à `[ZOOM_MIN, ZOOM_MAX]`, puis les décalages
 * sont ramenés dans les bornes.
 *
 * @param {object} etat
 * @param {number} facteur
 * @param {{ x: number, y: number }} [point]
 */
export function zoomer(etat, facteur, point = { x: 0, y: 0 }) {
  nombreFini(facteur, "facteur");
  if (facteur <= 0) throw new RangeError("Le facteur de zoom doit être strictement positif.");
  const echelleAvant = echelleAbsolue(etat);
  const echelleCible = borner(etat.echelle * facteur, ZOOM_MIN, ZOOM_MAX);
  if (echelleCible === etat.echelle) return appliquerBornes(etat);
  const echelleApres = echelleAbsolue({ ...etat, echelle: echelleCible });
  const ancreX = nombreFini(point?.x ?? 0, "point.x");
  const ancreY = nombreFini(point?.y ?? 0, "point.y");
  // Source sous l'ancre AVANT le zoom (px source depuis le centre de l'image).
  const sourceX = (ancreX - etat.x) / echelleAvant;
  const sourceY = (ancreY - etat.y) / echelleAvant;
  return appliquerBornes({
    ...etat,
    echelle: echelleCible,
    x: ancreX - sourceX * echelleApres,
    y: ancreY - sourceY * echelleApres,
  });
}

/** Déplace l'image de `(dx, dy)` px CSS (glissement), puis borne. */
export function deplacer(etat, dx, dy) {
  nombreFini(dx, "dx");
  nombreFini(dy, "dy");
  return appliquerBornes({ ...etat, x: etat.x + dx, y: etat.y + dy });
}

/** Revient à l'aperçu initial : zoom « couvre » et image centrée. */
export function recentrer(etat) {
  return { ...etat, echelle: ZOOM_MIN, x: 0, y: 0 };
}

/**
 * Rectangle SOURCE à découper dans l'image pour remplir le cercle.
 *
 * Comme le carré englobant du cercle a pour côté `diametre`, la fenêtre
 * source est de `diametre / échelle` px dans les deux axes : `sw === sh`
 * (carré) et les bornes garantissent `0 ≤ sx ≤ largeurImage - sw`.
 *
 * @returns {{ taille: number, sx: number, sy: number, sw: number, sh: number }}
 */
export function recadrer(etat) {
  const echelle = echelleAbsolue(etat);
  const cote = etat.diametre / echelle;
  const sx = etat.largeurImage / 2 - (etat.diametre / 2 + etat.x) / echelle;
  const sy = etat.hauteurImage / 2 - (etat.diametre / 2 + etat.y) / echelle;
  return {
    taille: TAILLE_SORTIE,
    sx: borner(sx, 0, Math.max(0, etat.largeurImage - cote)),
    sy: borner(sy, 0, Math.max(0, etat.hauteurImage - cote)),
    sw: cote,
    sh: cote,
  };
}

/**
 * Dessine le recadrage dans un contexte 2D (canvas) et renvoie le rectangle
 * source utilisé. Une image est TOUJOURS agrandie vers `taille` (512 par
 * défaut) : la sortie est donc un carré de côté `taille`, jamais la taille
 * naturelle de la source.
 *
 * @param {{ drawImage: Function }} contexte
 * @param {CanvasImageSource} image
 * @param {object} etat
 * @param {number} [taille]
 */
export function dessiner(contexte, image, etat, taille = TAILLE_SORTIE) {
  const rectangle = recadrer(etat);
  contexte.drawImage(
    image,
    rectangle.sx,
    rectangle.sy,
    rectangle.sw,
    rectangle.sh,
    0,
    0,
    taille,
    taille,
  );
  return rectangle;
}
