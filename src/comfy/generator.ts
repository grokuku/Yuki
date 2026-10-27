/**
 * GÉNÉRATION d'une image : choix du workflow, injection des étiquettes, appel
 * ComfyUI, enregistrement local.
 *
 * ⚠️ RÈGLES TENUES ICI :
 *  - la SCÈNE (texte libre) est la SEULE chose écrite dans `YUKI_PROMPT` ; le
 *    STYLE ne part JAMAIS dans le prompt — il ne sert qu'à CHOISIR le workflow ;
 *  - la scène est BORNÉE (`MAX_IMAGE_SCENE_CHARS`) : au-delà, on REFUSE
 *    explicitement (jamais une troncature silencieuse) ;
 *  - la génération est ASYNCHRONE (sondage borné côté client) : l'appel ne
 *    bloque pas la boucle d'événements et s'interrompt si le tour est annulé ;
 *  - l'image retenue est celle du nœud `YUKI_OUTPUT` QUAND le workflow porte
 *    cette étiquette (et seulement celle-là) ; sans elle, on garde le
 *    comportement historique — première image produite — et on le DIT
 *    (journal + indicateur `outputLabeled` remonté à l'outil) ;
 *  - le prompt FINAL (`YUKI_FINAL_PROMPT`) est une SORTIE : il est LÉGUÉ tel
 *    quel à l'appelant (affichage + modèle), jamais réinjecté dans un graphe.
 */

import { randomInt } from "node:crypto";

import type { ComfyImageClientPort, ComfyProgress } from "./client.js";
import type {
  GeneratedImageRecord,
  GeneratedImagesPort,
} from "./images.js";
import { pngDimensions } from "./images.js";
import { chooseWorkflow } from "./selection.js";
import type { ComfyFinalPromptResult, ComfyLogger } from "./types.js";
import { ComfyError } from "./types.js";
import { YUKI_DEFAULT_NEGATIVE, applyYukiValues, type YukiNodeLabel } from "./validate.js";
import type { ComfyWorkflowsPort } from "./workflows.js";

/** Longueur maximale de la SCÈNE (validée par l'utilisateur). */
export const MAX_IMAGE_SCENE_CHARS = 1_500;

/** Image générée, prête à être montrée et enregistrée. */
export interface GeneratedImage {
  record: GeneratedImageRecord;
  /**
   * Octets de l'image, pour la transmettre AU MODÈLE (bornés par l'appelant à
   * 1 Mio, avec `resizeImage`). ⚠️ Jamais stockés dans le transcript, jamais
   * journalisés : le disque et le chemin same-origin suffisent à l'affichage.
   */
  bytes: Uint8Array;
  /** Identifiant du prompt ComfyUI (diagnostic). */
  promptId: string;
  /**
   * Nom du workflow retenu. ⚠️ USAGE INTERNE (journaux) : il n'est jamais
   * transmis au modèle, qui ne doit pas annoncer le style choisi.
   */
  workflowName: string;
  elapsedMs: number;
  /**
   * Vrai si le workflow porte `YUKI_OUTPUT` (alors SEULE l'image de ce nœud a
   * été retenue). Faux ⇒ première image produite : l'appelant doit le DIRE.
   */
  outputLabeled: boolean;
  /** Étiquettes réellement écrites (preuve vérifiable). */
  labels: YukiNodeLabel[];
  /**
   * Texte du nœud étiqueté `YUKI_FINAL_PROMPT` (prompt final produit par le
   * workflow). ⚠️ C'est une SORTIE : elle est MONTRÉE (humain + modèle) et
   * jamais réécrite dans un graphe. `undefined` ⇒ le workflow n'a pas
   * l'étiquette (rien n'est lu, rien n'est affiché).
   */
  finalPrompt?: ComfyFinalPromptResult;
}

/** Port consommé par l'outil `generer_image`. */
export interface ComfyImageGenerationPort {
  generate(input: {
    scene: string;
    style?: string;
    signal?: AbortSignal;
    onProgress?: (progress: ComfyProgress) => void;
  }): Promise<GeneratedImage>;
}

export interface ComfyGeneratorOptions {
  /** Client HTTP (ou double de test) : soumission + historique + image. */
  client: ComfyImageClientPort;
  workflows: ComfyWorkflowsPort;
  images: GeneratedImagesPort;
  /** Dimensions demandées, relues à chaud (réglages `comfy.width/height`). */
  sizes: () => { width: number; height: number };
  logger?: ComfyLogger;
  now?: () => number;
  /** Graine aléatoire (injectable pour les tests). */
  seed?: () => number;
}

/** Graine sûre : entier positif sur 48 bits (accepté par ComfyUI). */
function defaultSeed(): number {
  return randomInt(1, 2 ** 48);
}

/** Fabrique le service de génération d'images. */
export function createComfyGenerator(
  options: ComfyGeneratorOptions,
): ComfyImageGenerationPort {
  const now = options.now ?? Date.now;
  const seed = options.seed ?? defaultSeed;

  return {
    async generate(input) {
      const scene = input.scene.trim();
      if (scene === "") {
        throw new ComfyError(
          "scene_too_long",
          "La scène est vide : décris ce que l'image doit montrer (sans style).",
        );
      }
      if (scene.length > MAX_IMAGE_SCENE_CHARS) {
        // ⚠️ REFUS explicite : on ne coupe JAMAIS en silence.
        throw new ComfyError(
          "scene_too_long",
          `La scène fait ${scene.length} caractères : la limite est de ` +
            `${MAX_IMAGE_SCENE_CHARS}. Raccourcis-la (garde l'essentiel de la scène) ` +
            "puis relance la génération.",
        );
      }

      // ⚠️ Le style (s'il est fourni) ne sert QU'ICI : choisir le workflow.
      const intent = (input.style ?? "").trim() !== "" ? input.style : scene;
      const candidates = options.workflows.candidates();
      if (candidates.length === 0) {
        throw new ComfyError(
          "no_workflow",
          "Aucun workflow d'image n'est importé. Dans Paramètres → Système → " +
            "Images générées, importez un workflow ComfyUI au FORMAT API contenant " +
            "au moins un nœud titré YUKI_PROMPT.",
        );
      }
      const choice = chooseWorkflow(candidates, intent);
      if (!choice) {
        throw new ComfyError(
          "no_matching_workflow",
          "Aucun workflow ne correspond à la demande et AUCUN workflow n'est " +
            "marqué « par défaut ». Cochez « par défaut » sur un workflow dans " +
            "Paramètres → Système → Images générées.",
        );
      }
      const entry = options.workflows.get(choice.name);
      if (!entry) {
        throw new ComfyError(
          "workflow_not_found",
          `Le workflow « ${choice.name} » n'existe plus : rechargez les paramètres.`,
        );
      }

      const sizes = options.sizes();
      const { workflow, injected } = applyYukiValues(entry.workflow, entry.labels, {
        prompt: scene,
        // Négatif NEUTRE (aucun style) : uniquement si le graphe a le nœud.
        ...(entry.labels.YUKI_NEGATIVE ? { negative: YUKI_DEFAULT_NEGATIVE } : {}),
        // Une graine NEUVE à chaque appel : régénérer donne une image différente.
        ...(entry.labels.YUKI_SEED ? { seed: seed() } : {}),
        ...(entry.labels.YUKI_WIDTH ? { width: sizes.width } : {}),
        ...(entry.labels.YUKI_HEIGHT ? { height: sizes.height } : {}),
      });

      const startedAt = now();
      // ⚠️ `YUKI_OUTPUT` désigne le nœud dont on LIT l'image finale (aucune
      // valeur à écrire). Absent ⇒ comportement historique, annoncé ensuite.
      const outputNodeId = entry.labels.YUKI_OUTPUT?.nodeId;
      // ⚠️ `YUKI_FINAL_PROMPT` désigne le nœud dont on LIT le TEXTE publié (aucune
      // valeur à écrire non plus). Absent ⇒ on ne lit ni n'affiche rien.
      const finalPromptNodeId = entry.labels.YUKI_FINAL_PROMPT?.nodeId;
      options.logger?.info("comfy.generation.start", {
        workflow: choice.name,
        reason: choice.reason,
        sceneChars: scene.length,
        width: entry.labels.YUKI_WIDTH ? sizes.width : undefined,
        height: entry.labels.YUKI_HEIGHT ? sizes.height : undefined,
        outputLabeled: outputNodeId !== undefined,
        outputNodeId,
        finalPromptLabeled: finalPromptNodeId !== undefined,
        finalPromptNodeId,
      });
      if (outputNodeId === undefined) {
        // ⚠️ On ne cache pas le repli : le journal ET le résultat de l'outil le
        // disent (l'image peut être un aperçu intermédiaire du graphe).
        options.logger?.warn("comfy.generation.output_unlabeled", {
          workflow: choice.name,
          reason:
            "aucune étiquette YUKI_OUTPUT : l'image retenue est la PREMIÈRE " +
            "produite par le graphe (elle peut être un aperçu intermédiaire).",
        });
      }
      const image = await options.client.generate(workflow, {
        ...(outputNodeId !== undefined ? { outputNodeId } : {}),
        ...(finalPromptNodeId !== undefined ? { finalPromptNodeId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });

      const dimensions = pngDimensions(image.bytes);
      const record = options.images.save({
        data: image.bytes,
        mimeType: image.mimeType,
        promptId: image.promptId,
        ...(dimensions ? dimensions : {}),
      });
      if (!record) {
        throw new ComfyError(
          "image_too_large",
          `L'image générée est trop volumineuse pour être conservée ` +
            `(${image.bytes.byteLength} octets). Réduisez la largeur/hauteur du ` +
            "workflow, ou la définition dans les réglages.",
        );
      }

      const elapsedMs = now() - startedAt;
      options.logger?.info("comfy.generation.done", {
        workflow: choice.name,
        promptId: image.promptId,
        nodeId: image.nodeId,
        bytes: record.bytes,
        elapsedMs,
      });
      return {
        record,
        bytes: image.bytes,
        promptId: image.promptId,
        workflowName: choice.name,
        elapsedMs,
        outputLabeled: outputNodeId !== undefined,
        labels: injected.map((item) => item.label),
        ...(image.finalPrompt !== undefined ? { finalPrompt: image.finalPrompt } : {}),
      };
    },
  };
}
