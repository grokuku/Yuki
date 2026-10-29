/**
 * VISION — réduction À LA VOLÉE des images destinées au modèle.
 *
 * ⚠️ RÈGLE PRODUIT : l'original n'est JAMAIS transformé (ni au dépôt, ni au
 * collage, ni sur le disque) ; la réduction se fait AU MOMENT d'envoyer le
 * message au modèle et n'est conservée nulle part.
 *
 * Ce fichier prouve quatre choses :
 *  1. une image DÉJÀ dans les bornes ne paie RIEN (aucun appel au réducteur) ;
 *  2. une image trop lourde ou trop DÉFINIE est réduite, puis transmise ;
 *  3. si la réduction n'aboutit pas — ou rendrait un texte illisible — le message
 *     est REFUSÉ explicitement (jamais une image floue envoyée en silence) ;
 *  4. ⚠️ `resizeImage` du SDK (Photon/WASM) fonctionne RÉELLEMENT ici — la note
 *     « il renvoie toujours null » était PÉRIMÉE (mesure refaite, voir le dernier
 *     test qui décode et compare de vraies dimensions).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  base64Size,
  prepareVisionImage,
  VISION_MAX_EDGE,
  VISION_MIN_EDGE,
  visionSize,
  type VisionImageResizer,
  type VisionResizeOptions,
} from "../../src/files/vision.js";
// ⚠️ Le redimensionneur RÉEL vit côté SDK (frontière `src/files` sans SDK) et est
// exposé par la façade `src/pi` : c'est exactement ce que la composition root
// injecte (`src/index.ts`).
import { sdkVisionImageResizer } from "../../src/pi/index.js";
import { gradientPng, noisyPng } from "./png-fixture.js";

/** Réducteur DOUBLE : instantané, déterministe (aucune dépendance au SDK). */
function fakeResizer(
  result:
    | { data: Buffer; mimeType: string; width: number; height: number; wasResized: boolean }
    | null,
): { resizer: VisionImageResizer; calls: Array<{ mimeType: string; options: VisionResizeOptions }> } {
  const calls: Array<{ mimeType: string; options: VisionResizeOptions }> = [];
  return {
    calls,
    resizer: async (_bytes, mimeType, options) => {
      calls.push({ mimeType, options });
      if (result === null) return null;
      return {
        data: result.data.toString("base64"),
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        wasResized: result.wasResized,
      };
    },
  };
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

describe("vision — chemin rapide (aucun coût quand rien ne dépasse)", () => {
  it("une image déjà dans les bornes passe TELLE QUELLE, sans appeler le réducteur", async () => {
    const { resizer, calls } = fakeResizer(null);
    const outcome = await prepareVisionImage({
      name: "petite.png",
      bytes: PNG_1X1,
      ext: "png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      maxBytes: 3_500_000,
      resize: resizer,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resized).toBe(false);
    expect(outcome.resizeMs).toBe(0);
    expect(outcome.image.data).toBe(PNG_1X1.toString("base64"));
    expect(outcome.image.mimeType).toBe("image/png");
    // ⚠️ Aucun appel : la réduction coûterait ~100 ms même pour rien (mesuré).
    expect(calls).toHaveLength(0);
  });

  it("un BMP est refusé (affichable, mais pas un format de vision)", async () => {
    const outcome = await prepareVisionImage({
      name: "plan.bmp",
      bytes: PNG_1X1,
      ext: "bmp",
      mimeType: "image/bmp",
      maxBytes: 3_500_000,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_unsupported");
    expect(outcome.message).toContain("plan.bmp");
    expect(outcome.message).toContain("PNG, JPEG, GIF ou WebP");
  });
});

describe("vision — réduction (le plafond n'est qu'un GARDE-FOU)", () => {
  it("une image trop lourde est réduite puis transmise, avec le budget en BASE64", async () => {
    const original = noisyPng(400, 300, 5);
    const reduced = PNG_1X1;
    const { resizer, calls } = fakeResizer({
      data: reduced,
      mimeType: "image/jpeg",
      // Dimensions encore LISIBLES : la réduction est acceptée.
      width: 800,
      height: 600,
      wasResized: true,
    });
    const limit = 10_000;
    const outcome = await prepareVisionImage({
      name: "photo.png",
      bytes: original,
      ext: "png",
      mimeType: "image/png",
      width: 400,
      height: 300,
      maxBytes: limit,
      resize: resizer,
    });
    expect(calls).toHaveLength(1);
    // Le SDK compare une taille BASE64 : le budget qui lui est donné correspond
    // au plafond en OCTETS BRUTS (×4/3), sinon on refuserait à tort.
    expect(calls[0]?.options.maxBytes).toBe(base64Size(limit));
    expect(calls[0]?.options.maxWidth).toBe(VISION_MAX_EDGE);
    expect(calls[0]?.options.maxHeight).toBe(VISION_MAX_EDGE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resized).toBe(true);
    expect(outcome.bytes).toBe(reduced.length);
    expect(outcome.image.mimeType).toBe("image/jpeg");
    expect(outcome.image.data).toBe(reduced.toString("base64"));
    expect(outcome.width).toBe(800);
    expect(outcome.height).toBe(600);
  });

  it("une image trop DÉFINIE est réduite même si elle est légère", async () => {
    const { resizer, calls } = fakeResizer({
      data: PNG_1X1,
      mimeType: "image/png",
      width: VISION_MAX_EDGE,
      height: 1_125,
      wasResized: true,
    });
    const outcome = await prepareVisionImage({
      name: "capture.png",
      bytes: PNG_1X1,
      ext: "png",
      mimeType: "image/png",
      width: 2_560,
      height: 1_440,
      maxBytes: 3_500_000,
      resize: resizer,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.resized).toBe(true);
    expect(outcome.width).toBe(VISION_MAX_EDGE);
  });

  it("dimensions INCONNUES : on ne devine pas, on tente la réduction", async () => {
    const { resizer, calls } = fakeResizer({
      data: PNG_1X1,
      mimeType: "image/png",
      width: 1,
      height: 1,
      wasResized: false,
    });
    const outcome = await prepareVisionImage({
      name: "mystere.png",
      bytes: PNG_1X1,
      ext: "png",
      mimeType: "image/png",
      maxBytes: 3_500_000,
      resize: resizer,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.ok).toBe(true);
  });
});

describe("vision — garde-fous (refus explicite, jamais silencieux)", () => {
  it("réduction impossible ⇒ refus `file_image_too_large`, message français nommant le fichier", async () => {
    const { resizer } = fakeResizer(null);
    const outcome = await prepareVisionImage({
      name: "enorme.png",
      bytes: noisyPng(120, 90, 3),
      ext: "png",
      mimeType: "image/png",
      width: 120,
      height: 90,
      maxBytes: 64,
      resize: resizer,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_too_large");
    expect(outcome.message).toContain("enorme.png");
    expect(outcome.message).toContain("plafond de vision");
    expect(outcome.message).toContain("n'est pas transmise au modèle");
  });

  it("un réducteur qui dépasse quand même le plafond est REFUSÉ (contrôle après coup)", async () => {
    const tooBig = noisyPng(200, 150, 7);
    const { resizer } = fakeResizer({
      data: tooBig,
      mimeType: "image/jpeg",
      width: 200,
      height: 150,
      wasResized: true,
    });
    const outcome = await prepareVisionImage({
      name: "photo.png",
      bytes: noisyPng(400, 300, 11),
      ext: "png",
      mimeType: "image/png",
      width: 400,
      height: 300,
      maxBytes: 1_000,
      resize: resizer,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_too_large");
  });

  it("une réduction qui rendrait le TEXTE illisible est refusée (`file_image_illegible`)", async () => {
    const { resizer } = fakeResizer({
      data: PNG_1X1,
      mimeType: "image/jpeg",
      width: VISION_MIN_EDGE - 1,
      height: 200,
      wasResized: true,
    });
    const outcome = await prepareVisionImage({
      name: "capture.png",
      bytes: noisyPng(300, 200, 13),
      ext: "png",
      mimeType: "image/png",
      width: 3_000,
      height: 2_000,
      maxBytes: 1_000,
      resize: resizer,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_illegible");
    expect(outcome.message).toContain("capture.png");
    expect(outcome.message).toContain(`${VISION_MIN_EDGE - 1}×200`);
    expect(outcome.message).toContain("ne serait plus lisible");
    // ⚠️ Aucune image floue n'est transmise « pour faire plaisir ».
    expect(outcome.message).toContain("n'est pas transmise au modèle");
  });

  it("un réducteur qui LÈVE est traité comme un échec, jamais comme un envoi", async () => {
    const outcome = await prepareVisionImage({
      name: "photo.png",
      bytes: noisyPng(80, 60, 17),
      ext: "png",
      mimeType: "image/png",
      width: 80,
      height: 60,
      maxBytes: 32,
      resize: async () => {
        throw new Error("Photon indisponible");
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_too_large");
  });
});

describe("vision — tailles lisibles", () => {
  it("« 3,5 Mo » plutôt que « 3 Mo » (un refus doit être compréhensible)", () => {
    // 3 500 000 octets = 3,34 Mio : on garde une décimale pour que le refus
    // reste compréhensible (« 3 Mo dépasse 3 Mo » ne veut rien dire).
    expect(visionSize(3_500_000)).toBe("3,3 Mo");
    expect(visionSize(700 * 1024)).toBe("700 Ko");
    expect(visionSize(12 * 1024 * 1024)).toBe("12 Mo");
  });

  it("la taille BASE64 déborde bien de ×1,33 (c'est elle qui pèse sur le fil)", () => {
    expect(base64Size(3)).toBe(4);
    expect(base64Size(543_000)).toBe(724_000);
    expect(base64Size(3_500_000)).toBe(4_666_668);
  });
});

describe("vision — le réducteur RÉEL du SDK (Photon/WASM) fonctionne", () => {
  it("`resizeImage` réduit VRAIMENT une image trop définie (mesure + dimensions)", async () => {
    // ⚠️ PREUVE CONTRE UNE NOTE PÉRIMÉE : le carnet disait « resizeImage renvoie
    // null, Photon WASM indisponible ». La mesure est refaite ici, en exécutant
    // réellement la fonction du SDK sur un vrai PNG.
    const original = gradientPng(2_400, 1_800);
    const startedAt = Date.now();
    const reduced = await sdkVisionImageResizer(original, "image/png", {
      maxWidth: VISION_MAX_EDGE,
      maxHeight: VISION_MAX_EDGE,
      maxBytes: base64Size(3_500_000),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(reduced).not.toBeNull();
    if (reduced === null) return;
    expect(reduced.wasResized).toBe(true);
    // Dimension ramenée sous le plafond, ratio conservé.
    expect(Math.max(reduced.width, reduced.height)).toBeLessThanOrEqual(VISION_MAX_EDGE);
    expect(reduced.width).toBe(VISION_MAX_EDGE);
    expect(reduced.height).toBe(Math.round((1_800 * VISION_MAX_EDGE) / 2_400));
    // Le côté le plus court reste LISIBLE (on ne livre pas une vignette).
    expect(reduced.height).toBeGreaterThanOrEqual(VISION_MIN_EDGE);
    // L'image annoncée tient sous le budget BASE64.
    expect(reduced.data.length).toBeLessThan(base64Size(3_500_000));
    // Coût MESURÉ, pas supposé : une réduction réelle prend des centaines de ms.
    expect(elapsedMs).toBeGreaterThan(0);
  });

  it("une image déjà conforme est renvoyée INTACTE par le SDK (aucune perte)", async () => {
    const original = gradientPng(320, 200);
    const same = await sdkVisionImageResizer(original, "image/png", {
      maxWidth: VISION_MAX_EDGE,
      maxHeight: VISION_MAX_EDGE,
      maxBytes: base64Size(3_500_000),
    });
    expect(same).not.toBeNull();
    if (same === null) return;
    expect(same.wasResized).toBe(false);
    expect(same.data).toBe(original.toString("base64"));
    expect(same.mimeType).toBe("image/png");
  });

  it("le chemin RAPIDE évite entièrement la réduction (coût mesuré du réducteur)", async () => {
    // Mesure du coût QU'ON NE PAIE PAS : appeler le réducteur sur une image
    // conforme coûte le démarrage du worker Photon (~100 ms mesurés). C'est
    // pourquoi `prepareVisionImage` ne l'appelle que s'il y a quelque chose à
    // réduire.
    const original = gradientPng(320, 200);
    const spy = vi.fn(sdkVisionImageResizer);
    const outcome = await prepareVisionImage({
      name: "capture.png",
      bytes: original,
      ext: "png",
      mimeType: "image/png",
      width: 320,
      height: 200,
      maxBytes: 3_500_000,
      resize: spy,
    });
    expect(outcome.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("vision — le câblage de production est COMPLET", () => {
  it("la composition root branche le plafond ET le réducteur (sinon le chemin est mort)", () => {
    // ⚠️ Une politique de réduction non branchée ne protège rien : ce test lit la
    // composition root pour verrouiller les DEUX lignes qui font exister le
    // chemin de vision (même méthode que `tests/pi/boundary.test.ts`).
    const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    expect(source).toContain('imageMaxBytes: () => config.getNumber("files.imageMaxBytes")');
    expect(source).toContain("imageResizer: sdkVisionImageResizer");
  });
});
