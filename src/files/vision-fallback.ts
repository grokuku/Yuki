/**
 * VISION DE REPLI — quand le modèle actif ne voit pas les images.
 *
 * ⚠️ PROBLÈME RÉEL : la capacité vision est une DÉCLARATION
 * (`/config` `llm.<rôle>.vision`, produite en `input` dans `models.json`) ; un
 * modèle déclaré texte seul ne reçoit AUCUNE image (le SDK remplace la partie
 * image par « tool image omitted »). Jusqu'ici le seul comportement possible
 * était donc de refuser l'image et de le dire. Ce module ouvre la seule autre
 * issue honnête : faire DÉCRIRE l'image par un MODÈLE DE VISION DÉDIÉ
 * (le rôle « vision » du CATALOGUE : son fournisseur, son nom, sa clé — pas
 * un choix parmi les deux modèles existants), puis donner cette DESCRIPTION au
 * modèle actif — à la place de l'image, et clairement identifiée comme telle.
 *
 * ⚠️ Aucun SDK ici (données + texte purs, testables sans modèle) : l'appel au
 * modèle de repli vit dans `src/pi/sdk/vision-fallback.ts`. Ce fichier porte ce
 * que TOUS les chemins doivent dire de la même façon, sinon l'interface, le
 * prompt et les outils finiraient par raconter trois histoires différentes.
 *
 * ⚠️ RÈGLE DE FIDÉLITÉ : une description n'est PAS une image vue. Le texte
 * injecté le dit toujours, dans les deux sens :
 *  - pour l'UTILISATEUR (il doit comprendre que le bot voit une description) ;
 *  - pour le MODÈLE (il ne doit jamais prétendre avoir vu l'image).
 */

import type { FileImageContent } from "./types.js";

/**
 * Consigne du modèle de vision de repli — FACTUELLE, jamais interprétative.
 *
 * ⚠️ On demande ce qui est LISIBLE et VÉRIFIABLE (libellés, chiffres, ordre,
 * couleurs, positions) et on interdit explicitement l'interprétation : une
 * description romancée (« le graphique montre une croissance ») ferait prendre
 * une supposition pour une observation, et le modèle actif n'aurait aucun moyen
 * de faire la différence — il ne voit pas l'image.
 */
export const VISION_DESCRIPTION_PROMPT = [
  "Décris cette image de façon FACTUELLE et UTILE pour quelqu'un qui ne peut pas la voir.",
  "",
  "Ce que tu décris :",
  "- ce qui est visible, et où (disposition, zones, ordre de lecture) ;",
  "- TOUT texte lisible, recopié exactement (titres, libellés, boutons, menus, messages d'erreur) ;",
  "- les CHIFFRES, dates, unités, pourcentages, noms de fichiers et d'éléments ;",
  "- les couleurs et les états visibles (actif/grisé, coché, surligné, erreur).",
  "",
  "Ce que tu ne fais PAS :",
  "- aucune interprétation, aucune conclusion, aucune supposition sur ce que cela signifie ;",
  "- rien que tu n'aies pas réellement lu ou vu ;",
  "- pas de préambule (commence directement par la description).",
  "",
  "Sois précis mais concis. Si un texte est illisible ou coupé, dis-le au lieu de le deviner.",
  "Une description peut manquer de détails : signale ce qui te semble incertain.",
].join("\n");

/**
 * Délai MAXIMAL d'une description (ms). Au-delà, le repli est déclaré en échec
 * et le tour CONTINUE sans l'image : une image ne doit jamais coûter un tour.
 */
export const VISION_DESCRIPTION_TIMEOUT_MS = 60_000;

/**
 * Nombre MAXIMAL d'images décrites par appel (au-delà, les suivantes sont
 * signalées comme non décrites — jamais un appel de modèle démesuré).
 */
export const VISION_DESCRIPTION_MAX_IMAGES = 4;

/** Issue d'une demande de description (le contrat que tous les chemins consomment). */
export type VisionDescriptionOutcome =
  /** Aucun modèle de repli configuré : comportement ACTUEL, rien n'est inventé. */
  | { readonly kind: "not_configured" }
  /** Description(s) obtenue(s) ; `modele` est la référence réellement utilisée. */
  | {
      readonly kind: "described";
      readonly modele: string;
      readonly descriptions: readonly { readonly nom?: string; readonly texte: string }[];
      /** Images écartées (trop lourdes, au-delà du plafond) — dites, jamais tues. */
      readonly ignorees: readonly string[];
    }
  /** Le repli existe mais a ÉCHOUÉ (modèle introuvable, sans vision, délai, erreur). */
  | { readonly kind: "failed"; readonly message: string };

/** Demande de description d'images (implémentée par le côté SDK). */
export type VisionDescriber = (
  images: readonly FileImageContent[],
) => Promise<VisionDescriptionOutcome>;

/** Vrai si un repli est réellement configuré (le réglage n'est pas vide). */
export type RepliVisionConfigure = () => boolean;

/** En-tête commun : ce que la description EST, et ce qu'elle n'est pas. */
function enteteDescription(modele: string): string {
  return (
    `— Description d'image par le modèle de vision de repli « ${modele} » : le modèle ` +
    "actuel ne voit PAS les images et reçoit uniquement ce texte. Une description " +
    "peut manquer de détails (chiffres, petits libellés, couleurs)."
  );
}

/**
 * Bloc de texte destiné au MODÈLE **et** visible par l'utilisateur.
 *
 * ⚠️ C'est le même texte dans les deux cas, volontairement : l'utilisateur lit
 * exactement ce que le modèle a reçu. Écrire deux variantes (une pour l'un, une
 * pour l'autre) rendrait impossible de savoir ce que le bot a réellement vu.
 */
export function blocDescriptionVision(input: {
  modele: string;
  descriptions: readonly { nom?: string; texte: string }[];
  ignorees?: readonly string[];
}): string {
  const lignes: string[] = [enteteDescription(input.modele)];
  input.descriptions.forEach((description, index) => {
    const titre =
      description.nom !== undefined && description.nom !== ""
        ? `Image ${index + 1} — « ${description.nom} » :`
        : `Image ${index + 1} :`;
    lignes.push("", titre, description.texte.trim());
  });
  if (input.ignorees !== undefined && input.ignorees.length > 0) {
    lignes.push("", `Non décrite(s) : ${input.ignorees.join(" ; ")}.`);
  }
  return lignes.join("\n");
}

/**
 * Échec du repli : DIT explicitement, et le tour continue sans l'image.
 *
 * ⚠️ Jamais une invention : le message nomme la cause (modèle indisponible,
 * image trop lourde, délai dépassé) pour que l'utilisateur puisse agir.
 */
export function blocEchecVisionRepli(message: string): string {
  return (
    "— Impossible d'analyser l'image : " +
    message.replace(/\s+/g, " ").trim() +
    " Le message continue sans l'image (le bot ne l'a pas vue)."
  );
}

/** Message HONNÊTE quand aucun repli n'est configuré (comportement d'origine). */
export function messageSansVisionSansRepli(modele: string): string {
  return (
    `Le modèle « ${modele} » ne voit pas les images et aucun modèle de vision ` +
    "n'est configuré : l'image n'est pas transmise et elle n'est pas décrite. " +
    "Pour la voir : activer la vision du modèle dans /config (onglet « Modèles », " +
    "réglage « Reçoit les images »), ou renseigner un modèle de vision dédié " +
    "(onglet « Modèles », bloc « Vision de repli » : URL de base, Modèle, Clé d'API)."
  );
}

/**
 * Applique le repli à une liste d'images : rend le TEXTE à injecter et dit
 * s'il faut réellement appeler le modèle de repli.
 *
 * ⚠️ Point unique de décision « faut-il appeler le repli ? » : aucun chemin ne
 * doit rappeler le modèle de vision quand le modèle actif voit déjà les images
 * (coût nul, comportement inchangé).
 */
export interface PlanVisionInput {
  /** Le modèle actif reçoit-il les images ? (`sdkModelSupportsImages`) */
  readonly modeleVoitLesImages: boolean;
  /** Nombre d'images prêtes à partir. */
  readonly nombreImages: number;
  /** Un modèle de vision est-il sélectionné ? (rôle « vision » du catalogue) */
  readonly repliConfigure: boolean;
}

/** Décision PURE : `garder` (images telles quelles) ou `decrire` (repli). */
export function planVision(input: PlanVisionInput): "garder" | "decrire" | "refuser" {
  if (input.nombreImages === 0) return "garder";
  if (input.modeleVoitLesImages) return "garder";
  return input.repliConfigure ? "decrire" : "refuser";
}
