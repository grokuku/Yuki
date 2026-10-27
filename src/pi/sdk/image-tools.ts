/**
 * Outil custom `generer_image` — Yuki GÉNÈRE une image via un serveur ComfyUI.
 *
 * ⚠️ RÈGLES TENUES ICI, ET VÉRIFIÉES PAR TEST :
 *  - `scene` est le SEUL texte envoyé au générateur. Le STYLE (paramètre
 *    `style`) ne sert QU'À choisir le workflow : il ne part JAMAIS dans le
 *    prompt du graphe (PIÈGE ①) ;
 *  - la scène est BORNÉE à 1 500 caractères : au-delà, le générateur REFUSE
 *    explicitement et rien n'est soumis (jamais de troncature silencieuse) ;
 *  - la génération est ASYNCHRONE (sondage borné) : la boucle d'événements reste
 *    libre pendant les 10 s à 3 min que prend une image (PIÈGE ③) ;
 *  - l'image est transmise AU MODÈLE (elle peut donc la JUGER et régénérer) et
 *    affichée à l'humain par une trame de contrôle, en SAME-ORIGIN
 *    (`/images/<id>.<ext>`) : la CSP n'est jamais élargie (PIÈGE ⑥) ;
 *  - ⚠️ L'image retenue est celle du nœud étiqueté `YUKI_OUTPUT` ; si le workflow
 *    n'a pas cette étiquette, le résultat le DIT (la première image produite
 *    peut être un aperçu intermédiaire) — jamais un repli tu ;
 *  - ⚠️ Le style retenu n'est JAMAIS annoncé au modèle : le résultat ne le porte
 *    pas (il reste dans les journaux, côté serveur).
 */

import {
  defineTool,
  resizeImage,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  MAX_IMAGE_SCENE_CHARS,
  isComfyError,
  type ComfyImageGenerationPort,
  type ComfyImageView,
  type GeneratedImage,
} from "../../comfy/index.js";

/**
 * Plafond de l'image transmise AU MODÈLE (octets bruts). Au-delà, on tente une
 * compression (`resizeImage` du SDK) ; si elle échoue (Photon indisponible),
 * l'image n'est PAS jointe au modèle (métadonnées seules) — jamais un puits non
 * borné dans le contexte (PIÈGE ⑤). MÊME règle que `capture_libraire`.
 */
export const MAX_GENERATED_IMAGE_MODEL_BYTES = 1_048_576;

export interface ImageToolPort {
  /** Génère une image (choix du workflow, injection, appel, stockage). */
  generate: ComfyImageGenerationPort["generate"];
  /** Émet la vue vers l'interface (trame de contrôle `image`). */
  onImage?: (view: ComfyImageView) => void;
}

/** Identifiant de la session (conversation) courante, ou `undefined`. */
function sessionIdFromContext(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    const id = ctx.sessionManager.getSessionId();
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Dimensions lisibles (jamais inventées : `undefined` si inconnues). */
function dimensionsOf(image: GeneratedImage): string {
  const { width, height } = image.record;
  return width !== undefined && height !== undefined ? `${width}×${height}` : "dimensions inconnues";
}

/** Taille lisible en français (« ~512 Ko », « 900 octets »). */
function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} octets`;
  if (bytes < 1024 * 1024) return `~${Math.round(bytes / 1024)} Ko`;
  return `~${(bytes / (1024 * 1024)).toFixed(1)} Mio`;
}

/**
 * Prépare l'image pour le MODÈLE : base64 borné (même doctrine que la capture
 * de page web). Renvoie `null` si l'image ne peut pas être jointe sans dépasser
 * le plafond — le résultat le DIT alors explicitement.
 */
async function boundImageForModel(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (bytes.byteLength <= MAX_GENERATED_IMAGE_MODEL_BYTES) {
    return { data: Buffer.from(bytes).toString("base64"), mimeType };
  }
  try {
    const resized = await resizeImage(bytes, mimeType, {
      maxBytes: MAX_GENERATED_IMAGE_MODEL_BYTES,
      maxWidth: 2_000,
      maxHeight: 2_000,
    });
    if (resized) return { data: resized.data, mimeType: resized.mimeType };
  } catch {
    // Photon indisponible : on retombe honnêtement sur « métadonnées seules ».
  }
  return null;
}

/** Construit l'outil `generer_image`. */
export function createImageTools(port: ImageToolPort): ToolDefinition[] {
  const tool = defineTool({
    name: "generer_image",
    label: "Générer une image",
    description:
      "Génère une IMAGE sur le serveur ComfyUI configuré et te la renvoie : tu " +
      "VOIS l'image produite, tu peux donc la juger et régénérer si elle ne " +
      "convient pas. Elle est aussi affichée dans la conversation.\n" +
      "• `scene` : décris la SCÈNE en TEXTE LIBRE, riche et concrète (sujet, " +
      "cadrage, décor, lumière, ambiance, couleurs). ⚠️ AUCUNE indication de " +
      "STYLE : jamais « manga », « photo », « rendu 3D », « à la manière de » — " +
      "c'est le workflow qui définit le style, pas toi. Maximum " +
      `${MAX_IMAGE_SCENE_CHARS} caractères : au-delà l'outil REFUSE et rien n'est ` +
      "généré (aucune troncature).\n" +
      "• `style` (facultatif) : sert UNIQUEMENT à choisir le workflow le plus " +
      "proche parmi ceux proposés dans tes consignes (libellé + description). " +
      "Omets-le quand l'utilisateur ne précise rien : la scène décide alors. Si " +
      "rien ne correspond, le workflow par défaut s'applique.\n" +
      "⚠️ N'annonce JAMAIS le style ni le workflow retenu : dis seulement ce que " +
      "montre l'image, ou pose une question sur ce qu'il faut changer.\n" +
      "Une image prend de 10 secondes à 3 minutes : l'attente est bornée et " +
      "n'interrompt pas la conversation ; en cas d'échec, le message dit " +
      "exactement ce que le serveur a répondu (inutile de le deviner).",
    promptSnippet:
      "generer_image(scene, style?) — génère une image via ComfyUI (scène en texte libre, SANS style) et te la montre",
    parameters: Type.Object({
      scene: Type.String({
        minLength: 1,
        maxLength: MAX_IMAGE_SCENE_CHARS,
        description:
          "Description LIBRE de la scène, SANS aucune indication de style " +
          `(maximum ${MAX_IMAGE_SCENE_CHARS} caractères).`,
      }),
      style: Type.Optional(
        Type.String({
          maxLength: 200,
          description:
            "Style souhaité, seulement pour CHOISIR le workflow le plus proche " +
            "(ex. « un truc style dessin animé japonais »). N'est jamais recopié " +
            "dans la scène et n'est jamais annoncé.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const input = params as { scene: string; style?: unknown };
      const scene = input.scene.trim();
      if (scene === "") {
        const payload = {
          status: "invalid",
          field: "scene",
          message: "La scène est vide : décris ce que l'image doit montrer.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
        };
      }
      if (scene.length > MAX_IMAGE_SCENE_CHARS) {
        // ⚠️ REFUS explicite (le schéma TypeBox refuse déjà, mais un client
        // malformé ou un `prepareArguments` ne doit pas passer pour autant).
        const payload = {
          status: "invalid",
          field: "scene",
          message:
            `La scène fait ${scene.length} caractères : la limite est de ` +
            `${MAX_IMAGE_SCENE_CHARS}. Raccourcis-la puis relance.`,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
        };
      }
      const style =
        typeof input.style === "string" && input.style.trim() !== ""
          ? input.style.trim()
          : undefined;
      const sessionId = sessionIdFromContext(ctx);

      try {
        const image = await port.generate({
          scene,
          ...(style !== undefined ? { style } : {}),
          ...(signal ? { signal } : {}),
        });

        // Affichage à l'HUMAIN : trame de contrôle (jamais dans l'historique).
        if (port.onImage) {
          try {
            port.onImage({
              id: image.record.id,
              imageSrc: image.record.imageSrc,
              mimeType: image.record.mimeType,
              bytes: image.record.bytes,
              createdAt: image.record.createdAt,
              promptId: image.promptId,
              ...(image.record.width !== undefined ? { width: image.record.width } : {}),
              ...(image.record.height !== undefined ? { height: image.record.height } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
            });
          } catch {
            // Un échec d'affichage ne doit PAS faire échouer la génération.
          }
        }

        const attached = await boundImageForModel(image.bytes, image.record.mimeType);
        const seconds = Math.max(1, Math.round(image.elapsedMs / 1000));
        // ⚠️ Aucune étiquette `YUKI_OUTPUT` dans le workflow ⇒ on le DIT (au
        // modèle ET à l'humain, qui lit ce résultat) : l'image retenue peut être
        // un aperçu intermédiaire du graphe.
        const outputNote = image.outputLabeled
          ? ""
          : " ⚠️ Ce workflow n'a pas d'étiquette YUKI_OUTPUT : l'image retenue " +
            "est la PREMIÈRE produite par le graphe (elle peut être un aperçu " +
            "intermédiaire). Pour garantir l'image finale, étiquette son nœud de " +
            "sortie YUKI_OUTPUT (Paramètres → Système → Images générées).";
        const text =
          `Image générée en ${seconds} s (${dimensionsOf(image)}, ` +
          `${humanBytes(image.record.bytes)}). Elle est affichée dans la ` +
          "conversation et tu la vois ci-dessous : juge-la et régénère si besoin." +
          outputNote +
          (attached === null
            ? " ⚠️ Elle est trop volumineuse pour t'être jointe ici : tu ne l'as " +
              "PAS vue — ne prétends pas l'avoir jugée. Réduis la définition dans " +
              "les réglages (paramètres → Système → Images générées) puis relance."
            : "");
        const details = {
          status: "ok",
          image_src: image.record.imageSrc,
          bytes: image.record.bytes,
          mime_type: image.record.mimeType,
          elapsed_ms: image.elapsedMs,
          image_attached: attached !== null,
          image_displayed_to_human: port.onImage !== undefined,
          /** Faux ⇒ l'image retenue est la première produite (pas de YUKI_OUTPUT). */
          output_labeled: image.outputLabeled,
          ...(image.record.width !== undefined ? { width: image.record.width } : {}),
          ...(image.record.height !== undefined ? { height: image.record.height } : {}),
        };
        const content: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        > = [{ type: "text", text }];
        if (attached) {
          content.push({ type: "image", data: attached.data, mimeType: attached.mimeType });
        }
        return { content, details };
      } catch (error) {
        // ⚠️ PIÈGE ⑧ : on rapporte la cause RÉELLE (déjà traduite en français par
        // la couche `src/comfy`), jamais une cause inventée.
        const payload = {
          status: "error",
          code: isComfyError(error) ? error.code : "internal_error",
          message: isComfyError(error)
            ? error.message
            : `La génération d'image a échoué : ${error instanceof Error ? error.message : String(error)}`,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      }
    },
  });

  return [tool];
}
