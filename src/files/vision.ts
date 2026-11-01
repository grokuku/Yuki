/**
 * VISION — préparation ÉPHÉMÈRE des images destinées AU MODÈLE.
 *
 * ⚠️ RÈGLE PRODUIT (décision utilisateur) : **l'original n'est JAMAIS
 * transformé**. Ce module ne touche ni au dépôt, ni au stockage, ni au collage :
 * il reçoit les octets d'un fichier déjà stocké et rend une version **réduite à
 * la volée**, qui part dans le message du modèle et **n'est conservée nulle
 * part** (ni disque, ni cache, ni base). Ce que l'utilisateur télécharge reste
 * l'original, intact.
 *
 * ⚠️ POURQUOI RÉDUIRE PLUTÔT QUE REFUSER : une photo de téléphone fait
 * couramment 5 Mo et part en base64 (×1,33) ⇒ ~6,7 Mio sur le fil, avec un coût
 * réseau et de TTFT que l'utilisateur paie à chaque tour. Le fournisseur, lui,
 * la réduirait de toute façon (souvent à ~1 500 px) — mais APRÈS le transfert.
 *
 * TROIS GARDE-FOUS, DANS CET ORDRE :
 *  1. **DIMENSION** (`VISION_MAX_EDGE`) : une image n'est jamais transmise
 *     au-delà de 2 000 px de côté, quelle que soit sa taille en octets ;
 *  2. **POIDS TRANSMIS** (`files.imageMaxWireBytes`) : la borne qui compte est
 *     la taille **base64** (×1,33 sur les octets d'origine) — c'est elle qui
 *     pèse sur le corps HTTP et que le fournisseur refuse (`500 « request
 *     entity too large »`). Au-delà, on RÉDUIT davantage (par le CÔTÉ) ;
 *  3. **POIDS DU FICHIER** (`files.imageMaxBytes`, garde-fou de lecture) : au-delà,
 *     on tente la réduction ; si elle n'aboutit pas, on REFUSE explicitement —
 *     jamais de troncature, jamais d'envoi muet d'une image démesurée.
 *
 * ⚠️ INCIDENT MESURÉ (2026-11-01) : ce module ne raisonnait QUE sur les octets
 * d'ORIGINE. Une image de 2 876 Ko / 2231×961 était donc réduite à `2000×861`
 * puis transmise en PNG (~3,1 Mio de base64), bien au-dessus de ce que le
 * fournisseur accepte : `500 « request entity too large »`, **0 jeton**, 17 s
 * perdues, et aucun moyen d'agir pour l'utilisateur. La réduction était juste ;
 * son UNITÉ ne l'était pas.
 *
 * ⚠️ LISIBILITÉ DU TEXTE : réduire une capture d'écran jusqu'à la rendre floue
 * serait une perte silencieuse. Si la réduction devrait descendre sous
 * `VISION_MIN_EDGE` (700 px de côté), on REFUSE et on le dit (recadrer la zone
 * utile, joindre une version plus petite) — on ne livre pas une image illisible
 * en prétendant l'avoir transmise.
 *
 * ⚠️ La réduction utilise `resizeImage` du SDK (Photon, WASM) : AUCUNE dépendance
 * nouvelle. Mesuré sur cette machine : ~100 ms par appel même sans réduction
 * (démarrage du worker + WASM), ~1,8 s pour une capture 2560×1440, ~2 à 4 s pour
 * une image de 5 à 9 Mo à réduire. D'où le CHEMIN RAPIDE (`needsResize`) : une
 * image déjà dans les bornes ne paie RIEN (son coût se limite au base64, ~1 ms
 * pour 543 Ko).
 */

import { modelImageMimeType } from "./analyze.js";
import { humanBytes } from "./frame.js";
import type { FileImageContent } from "./types.js";

/**
 * Côté MAXIMAL (pixels) d'une image transmise au modèle.
 *
 * 2 000 px : c'est la valeur par défaut du SDK et celle qui garde lisible une
 * capture d'écran, sans envoyer au fournisseur des définitions qu'il réduirait
 * de toute façon (en payant le transfert).
 */
export const VISION_MAX_EDGE = 2_000;

/**
 * Côté MINIMAL (pixels) jugé LISIBLE après réduction.
 *
 * En dessous de 700 px, un texte de capture ou une légende de schéma devient
 * illisible : mieux vaut REFUSER et le dire que transmettre une bouillie en
 * laissant croire que l'image a été vue.
 */
export const VISION_MIN_EDGE = 700;

/** Options passées au réducteur (mêmes noms que `resizeImage` du SDK). */
export interface VisionResizeOptions {
  maxWidth: number;
  maxHeight: number;
  /** Plafond en BASE64 (ce qui pèse sur le fil), pas en octets bruts. */
  maxBytes: number;
}

/** Résultat d'une réduction (forme de `resizeImage` du SDK). */
export interface VisionResizeResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  wasResized: boolean;
}

/** Réducteur injectable (les tests fournissent un double déterministe). */
export type VisionImageResizer = (
  bytes: Uint8Array,
  mimeType: string,
  options: VisionResizeOptions,
) => Promise<VisionResizeResult | null>;

export interface VisionImageInput {
  /** Nom d'affichage (assaini) — sert aux messages de refus, jamais au modèle. */
  name: string;
  /** Octets de l'ORIGINAL (jamais modifiés : ils restent sur le disque). */
  bytes: Buffer;
  /** Extension assainie du fichier (le type se déduit d'abord d'elle). */
  ext: string;
  /** Type MIME DÉCLARÉ (jamais cru sur parole pour un format de vision). */
  mimeType: string;
  /** Dimensions connues de l'analyse (absentes si non décodables). */
  width?: number;
  height?: number;
  /** Plafond en OCTETS BRUTS de l'image transmise (`files.imageMaxBytes`). */
  maxBytes: number;
  /**
   * Plafond en OCTETS TRANSMIS, c'est-à-dire en BASE64 (`files.imageMaxWireBytes`).
   *
   * ⚠️ C'est LA borne qui compte : le base64 est ce qui part dans le corps HTTP
   * (×1,33 sur les octets du fichier). `maxBytes` borne la lecture/réduction ;
   * `maxWireBytes` borne l'ÉMISSION.
   */
  maxWireBytes: number;
  /**
   * Réducteur INJECTÉ (`sdkVisionImageResizer`, exposé par la façade `src/pi`).
   *
   * ⚠️ `src/files` n'importe JAMAIS le SDK (frontière verrouillée par
   * `tests/pi/boundary.test.ts`). Absent ⇒ aucune réduction possible : une image
   * au-delà des bornes est REFUSÉE (garde-fou), jamais transmise telle quelle.
   */
  resize?: VisionImageResizer;
}

export type VisionImageOutcome =
  | {
      ok: true;
      /** Pièce jointe prête pour le modèle (`ImageContent` : base64 + MIME). */
      image: FileImageContent;
      /** `true` ⇒ une version RÉDUITE éphémère a été produite (jamais stockée). */
      resized: boolean;
      /** Octets BRUTS de l'image transmise (base64 décodé). */
      bytes: number;
      /** Octets RÉELLEMENT transmis (longueur du base64, ×1,33 les octets bruts). */
      wireBytes: number;
      /** Dimensions de l'image transmise (celles de l'original si intacte). */
      width?: number;
      height?: number;
      /** Durée de la réduction (ms) — `0` quand le chemin rapide a été pris. */
      resizeMs: number;
    }
  | { ok: false; code: string; message: string };

/** Taille lisible en français (« 3,5 Mo », « 700 Ko »). */
export function visionSize(bytes: number): string {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024 * 1024) return humanBytes(n);
  const mo = n / (1024 * 1024);
  // Une décimale sous 10 Mo : sinon « 3 Mo dépasse 3 Mo » serait incompréhensible.
  return `${mo >= 10 ? Math.round(mo) : mo.toFixed(1).replace(".", ",")} Mo`;
}

/** Taille BASE64 (ce qui part réellement sur le fil) d'un contenu de `n` octets. */
export function base64Size(bytes: number): number {
  const n = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
  return Math.ceil(n / 3) * 4;
}

/**
 * Prépare UNE image pour le modèle : laisse passer l'original quand il tient
 * dans les bornes, le RÉDUIT à la volée sinon, et refuse explicitement plutôt
 * que de livrer quelque chose d'illisible ou de démesuré.
 */
export async function prepareVisionImage(
  input: VisionImageInput,
): Promise<VisionImageOutcome> {
  const mimeType = modelImageMimeType(input.ext, input.mimeType);
  if (mimeType === undefined) {
    // ⚠️ Ni conversion ni invention de type : un fournisseur rejetterait une
    // partie image qu'il ne sait pas décoder, par une erreur opaque.
    return {
      ok: false,
      code: "file_image_unsupported",
      message:
        `L'image « ${input.name} » n'est pas dans un format de vision ` +
        "(PNG, JPEG, GIF ou WebP) : elle n'est pas transmise au modèle. " +
        "Convertissez-la, ou retirez-la du message.",
    };
  }

  const limit = Math.max(1, Math.trunc(input.maxBytes));
  const wireLimit = Math.max(1, Math.trunc(input.maxWireBytes));
  const originalCount = input.bytes.length;
  const knownEdge = Math.max(input.width ?? 0, input.height ?? 0);

  // ⚠️ CHEMIN RAPIDE : rien à réduire. Aucun appel au réducteur (mesuré ~100 ms
  // même pour une image déjà conforme : on ne le paie pas).
  // ⚠️ La taille TRANSMISE (base64) est testée AUSSI : une image légère mais
  // incompressible peut dépasser le plafond du fil alors qu'elle tient en octets.
  if (
    originalCount <= limit &&
    base64Size(originalCount) <= wireLimit &&
    knownEdge > 0 &&
    knownEdge <= VISION_MAX_EDGE
  ) {
    return {
      ok: true,
      image: { data: input.bytes.toString("base64"), mimeType },
      resized: false,
      bytes: originalCount,
      wireBytes: base64Size(originalCount),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      resizeMs: 0,
    };
  }

  const resize = input.resize;
  // ⚠️ LE BUDGET DONNÉ AU RÉDUCTEUR EST EN BASE64, et c'est le PLUS PETIT des
  // deux plafonds : le plafond du fil (octets transmis) et le plafond du fichier
  // traduit en base64 (×4/3). Avant le correctif, seul le second était utilisé :
  // un plafond de 3 500 000 octets laissait donc partir 4 666 668 octets de
  // base64 — exactement ce que le fournisseur a refusé.
  const budget = Math.min(base64Size(limit), wireLimit);
  // Message de refus UNIQUE (deux causes : réducteur sans résultat, ou résultat
  // encore trop lourd) — même cause utile pour l'humain : « cette image ne peut
  // pas tenir sous le plafond ».
  const tooLarge = {
    ok: false as const,
    code: "file_image_too_large",
    message:
      `L'image « ${input.name} » (${visionSize(originalCount)}) ne peut pas être ` +
      `réduite sous le plafond de vision (${visionSize(budget)} transmis, en base64) : ` +
      "elle n'est pas transmise au modèle. Retirez-la, ou joignez une version plus petite.",
  };
  let reduced: VisionResizeResult | null = null;
  let resizeMs = 0;
  if (resize !== undefined) {
    const startedAt = Date.now();
    try {
      reduced = await resize(input.bytes, mimeType, {
        maxWidth: VISION_MAX_EDGE,
        maxHeight: VISION_MAX_EDGE,
        maxBytes: budget,
      });
    } catch {
      reduced = null;
    }
    resizeMs = Date.now() - startedAt;
  }

  if (reduced === null) {
    // Le réducteur n'a pas pu tenir le budget (ou n'est pas disponible ici).
    // GARDE-FOU ULTIME : refus explicite, français, sans cause inventée.
    return tooLarge;
  }

  const sentBytes = Buffer.byteLength(reduced.data, "base64");
  const wireBytes = Buffer.byteLength(reduced.data, "utf8");
  if (sentBytes > limit || wireBytes > wireLimit) {
    // ⚠️ Contrôle APRÈS coup sur la taille RÉELLEMENT émise : le réducteur peut
    // rendre un candidat au-dessus du budget demandé (ou lever silencieusement).
    return tooLarge;
  }

  if (reduced.wasResized && Math.max(reduced.width, reduced.height) < VISION_MIN_EDGE) {
    // ⚠️ Rien n'est livré « en silence » : une image réduite à ce point ne serait
    // plus lisible (texte, schéma), donc elle ne serait pas VUE.
    return {
      ok: false,
      code: "file_image_illegible",
      message:
        `L'image « ${input.name} » devrait descendre à ${reduced.width}×${reduced.height} px ` +
        `pour tenir sous le plafond de vision (${visionSize(budget)} transmis, en base64) : ` +
        "à cette taille, un texte ou un schéma ne serait plus lisible. Elle n'est pas " +
        "transmise au modèle : recadrez la zone utile, ou joignez une capture plus petite.",
    };
  }

  return {
    ok: true,
    image: { data: reduced.data, mimeType: reduced.mimeType },
    resized: reduced.wasResized,
    bytes: sentBytes,
    wireBytes,
    width: reduced.width,
    height: reduced.height,
    resizeMs,
  };
}
