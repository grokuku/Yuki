/**
 * MODÈLE DE VISION DE REPLI — appel effectif (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ CE QUE CE MODULE FERME : un modèle déclaré texte seul (`llm.<rôle>.vision =
 * non`) ne reçoit aucune image ; jusqu'ici la seule issue était de la refuser.
 * Ici, un MODÈLE DE VISION DÉDIÉ — le sien, avec SON adresse, SON nom et SA clé
 * (`/config` → onglet « Modèles », bloc « Vision de repli », soit
 * `llm.vision.baseUrl` / `llm.vision.model` / `llm.vision.apiKey`) — REGARDE
 * l'image et rend une DESCRIPTION, que le modèle actif reçoit à la place de
 * l'image (bloc balisé, `src/files/vision-fallback.ts`).
 *
 * ⚠️ POURQUOI UN MODÈLE DÉDIÉ ET NON UN CHOIX PARMI LES DEUX EXISTANTS : si ni
 * le léger ni le lourd ne voit les images, un sélecteur entre ces deux-là ne
 * sert à rien (demande utilisateur du 2026-11-16). Ce modèle n'est donc PAS un
 * rôle de conversation/travail : il n'existe que pour décrire.
 *
 * ⚠️ INSTANCIÉ SANS RIEN AJOUTER À LA MAIN : `models.json` est DÉRIVÉ de la
 * configuration (`buildModelsConfigFrom`, `src/llm/models.ts`) et contient, dès
 * que `llm.vision.baseUrl` ET `llm.vision.model` sont renseignés, un provider
 * `llm-vision` avec ce modèle. Le SDK le résout comme les autres, par la
 * référence `llm-vision/<modèle>` — aucun fichier à éditer, et vider les deux
 * champs le retire.
 *
 * ⚠️ COÛT NUL QUAND TOUT VA BIEN : aucune requête n'est émise vers le repli
 * quand le modèle actif voit déjà les images — c'est l'APPELANT qui décide
 * (`planVision`), ce module ne fait qu'obéir.
 *
 * ⚠️ MÊME CHEMIN SDK QUE LES AUTRES USAGES (`createSdkPromptWriter` : session
 * éphémère EN MÉMOIRE, aucun outil, aucun accès à la session de l'utilisateur).
 * Le `ModelRuntime` est le runtime PARTAGÉ : un changement de modèle
 * (`apply: hot`) est donc vu au prochain usage, sans redémarrage.
 *
 * ⚠️ UNE SEULE DESCRIPTION PAR IMAGE : le modèle de repli est appelé UNE fois
 * par lot d'images (pas de re-description en boucle), et les images déjà
 * décrites sont mémorisées (LRU borné) pour ne jamais payer deux fois la même.
 */

import { createHash } from "node:crypto";

import type { PiLogger, PiThinkingLevel } from "../types.js";
import {
  VISION_DESCRIPTION_MAX_IMAGES,
  VISION_DESCRIPTION_PROMPT,
  VISION_DESCRIPTION_TIMEOUT_MS,
  type VisionDescriptionOutcome,
  type VisionDescriber,
} from "../../files/vision-fallback.js";
import type { FileImageContent } from "../../files/types.js";
import { getSharedModelRuntime, resolveSdkModel } from "./model-runtime.js";
import { createSdkPromptWriter } from "./prompt-writer.js";
import type { createEphemeralSession } from "./session-factory.js";

export interface SdkVisionDescriberConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /**
   * Référence `provider/modelId` du modèle de vision DÉDIÉ, RELUE À CHAQUE
   * USAGE (`llm.vision.baseUrl` + `llm.vision.model`) : un changement s'applique
   * sans redémarrage. Chaîne vide ⇒ aucun repli configuré (`not_configured`),
   * comportement actuel (l'image n'est pas envoyée et c'est DIT).
   */
  modelReference: () => string;
  /**
   * Niveau de réflexion du modèle de vision (`llm.vision.thinking`), relu à
   * chaque usage. Défaut `off` : décrire n'est pas raisonner.
   */
  thinking?: () => PiThinkingLevel;
  /** Délai maximal d'une description (ms), relu à chaud. */
  timeoutMs?: () => number;
  logger: PiLogger;
  /** Fabrique de session éphémère. Injectable pour les TESTS. */
  createSession?: typeof createEphemeralSession;
}

/**
 * Nombre de descriptions mémorisées. 32 = quelques tours d'une conversation
 * dense ; au-delà, la plus ancienne est oubliée (aucune fuite mémoire : les
 * images peuvent peser plusieurs Mo en base64).
 */
const CACHE_MAX = 32;

/** Empreinte d'une image (jamais journalisée : sert UNIQUEMENT de clé de cache). */
function empreinte(image: FileImageContent): string {
  return `${image.mimeType}:${createHash("sha256").update(image.data).digest("hex")}`;
}

/** Retire les blancs superflus d'une description (le modèle aère parfois trop). */
function normaliserDescription(texte: string): string {
  return texte.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Fabrique le describer : `images → description(s)`.
 *
 * Aucune exception ne sort d'ici : tout échec est un RÉSULTAT nommé
 * (`{ kind: "failed" }`) pour que l'appelant continue son tour au lieu de le
 * perdre.
 */
export function createSdkVisionDescriber(config: SdkVisionDescriberConfig): VisionDescriber {
  const writer = createSdkPromptWriter({
    cwd: config.cwd,
    agentDir: config.agentDir,
    authPath: config.authPath,
    modelsPath: config.modelsPath,
    systemPrompt: VISION_DESCRIPTION_PROMPT,
    modelReference: config.modelReference,
    // ⚠️ Réflexion RELUE À CHAQUE APPEL (`llm.vision.thinking`), `off` par
    // défaut : décrire n'est pas raisonner, et un modèle à réflexion longue
    // doublerait le délai d'un tour pour un gain nul sur une image.
    thinking: config.thinking ?? (() => "off"),
    timeoutMs: config.timeoutMs ?? (() => VISION_DESCRIPTION_TIMEOUT_MS),
    logger: config.logger,
    label: "vision de repli",
    ...(config.createSession ? { createSession: config.createSession } : {}),
  });
  /** Une seule description par image, même image rejouée dans un tour suivant. */
  const memo = new Map<string, string>();

  const memoriser = (cle: string, description: string): void => {
    memo.set(cle, description);
    while (memo.size > CACHE_MAX) {
      const plusAncienne = memo.keys().next().value;
      if (plusAncienne === undefined) break;
      memo.delete(plusAncienne);
    }
  };

  return async (images: readonly FileImageContent[]): Promise<VisionDescriptionOutcome> => {
    const reference = config.modelReference().trim();
    if (reference === "") return { kind: "not_configured" };
    if (images.length === 0) return { kind: "not_configured" };

    // ⚠️ BORNE : un lot démesuré est TRONQUÉ et le reste est DIT (jamais un
    // appel de modèle à dix images, jamais un silence sur les manquantes).
    const retenues = images.slice(0, VISION_DESCRIPTION_MAX_IMAGES);
    const ignorees: string[] = [];
    if (images.length > retenues.length) {
      ignorees.push(
        `${images.length - retenues.length} image(s) au-delà de ${VISION_DESCRIPTION_MAX_IMAGES} non décrite(s)`,
      );
    }

    let runtime;
    let modele;
    try {
      runtime = await getSharedModelRuntime({
        authPath: config.authPath,
        modelsPath: config.modelsPath,
      });
      modele = resolveSdkModel(runtime, reference);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      config.logger.warn("vision.repli.echec", {
        modele: reference,
        raison: "runtime_indisponible",
        error: cause,
      });
      return {
        kind: "failed",
        message: `le modèle de vision « ${reference} » est introuvable (${cause})`,
      };
    }
    if (!modele) {
      config.logger.warn("vision.repli.echec", {
        modele: reference,
        raison: "modele_introuvable",
      });
      return {
        kind: "failed",
        message:
          `le modèle de vision « ${reference} » est introuvable dans models.json — ` +
          "vérifiez « URL de base » et « Modèle » du bloc « Vision de repli » " +
          "(/config → onglet « Modèles »)",
      };
    }
    // ⚠️ PAS de contrôle de capacité ici (`sdkModelSupportsImages`) : ce modèle
    // n'est pas un modèle de chat dont la vision serait une DÉCLARATION
    // d'utilisateur, c'est l'emplacement même de la description. Son entrée
    // `models.json` porte TOUJOURS `input: ["text", "image"]` par construction
    // (`resolveVisionFrom`, `src/llm/models.ts`) : il voit l'image, sinon il
    // n'existerait pas.

    // ⚠️ ORDRE DES IMAGES PRÉSERVÉ : le résultat est indexé comme l'entrée, sinon
    // l'appelant associerait le nom d'un fichier à la description d'un autre.
    const resultats: ({ texte: string } | undefined)[] = new Array(retenues.length).fill(undefined);
    const aDecrire: FileImageContent[] = [];
    const indexDe = new Map<FileImageContent, number>();
    retenues.forEach((image, index) => {
      const connue = memo.get(empreinte(image));
      if (connue !== undefined) {
        resultats[index] = { texte: connue };
        return;
      }
      aDecrire.push(image);
      indexDe.set(image, index);
    });

    if (aDecrire.length > 0) {
      const octets = aDecrire.reduce((total, image) => total + image.data.length, 0);
      config.logger.info("vision.repli.utilise", {
        modele: reference,
        raison: "modele_actif_sans_vision",
        images: aDecrire.length,
        // Base64 : c'est ce qui pèse réellement sur le fil (cf. `src/files/vision.ts`).
        bytes: octets,
      });
      let texte: string;
      try {
        texte = await writer(
          aDecrire.length === 1
            ? "Décris cette image (une seule)."
            : `Décris chacune de ces ${aDecrire.length} images, dans l'ordre, ` +
                "en séparant les descriptions par une ligne « --- ».",
          { images: aDecrire },
        );
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        config.logger.warn("vision.repli.echec", {
          modele: reference,
          raison: "appel_echoue",
          error: cause.replace(/\s+/g, " ").slice(0, 300),
        });
        return {
          kind: "failed",
          message: `le modèle de vision de repli « ${reference} » n'a pas répondu (${cause})`,
        };
      }
      const brut = normaliserDescription(texte);
      if (brut === "") {
        config.logger.warn("vision.repli.echec", {
          modele: reference,
          raison: "reponse_vide",
        });
        return {
          kind: "failed",
          message: `le modèle de vision « ${reference} » n'a rien décrit (réponse vide)`,
        };
      }
      // Une description par image : le modèle les sépare par « --- » quand il y
      // en a plusieurs ; s'il n'a pas suivi, une description unique couvre le lot
      // (et c'est DIT, jamais dupliqué en boucle pour en obtenir une par image).
      const morceaux =
        aDecrire.length === 1
          ? [brut]
          : brut
              .split(/\n-{3,}\n/)
              .map((morceau) => morceau.trim())
              .filter((morceau) => morceau !== "");
      if (morceaux.length === aDecrire.length) {
        aDecrire.forEach((image, position) => {
          const morceau = morceaux[position] ?? brut;
          memoriser(empreinte(image), morceau);
          resultats[indexDe.get(image) ?? position] = { texte: morceau };
        });
      } else {
        // Le modèle n'a pas séparé : un texte unique couvre le lot (DIT, et jamais
        // une seconde passe pour forcer un découpage — « une seule description »).
        const premiere = aDecrire[0] as FileImageContent;
        memoriser(empreinte(premiere), brut);
        resultats[indexDe.get(premiere) ?? 0] = { texte: brut };
        const manquantes = aDecrire.length - 1;
        if (manquantes > 0) {
          ignorees.push(
            `${manquantes} image(s) décrite(s) en un seul texte (le modèle n'a pas séparé les descriptions)`,
          );
        }
      }
    }

    const descriptions = resultats.filter((resultat): resultat is { texte: string } =>
      resultat !== undefined,
    );
    if (descriptions.length === 0) {
      return {
        kind: "failed",
        message: `le modèle de vision « ${reference} » n'a produit aucune description`,
      };
    }
    return { kind: "described", modele: reference, descriptions, ignorees };
  };
}
