/**
 * VISION — ce qui part RÉELLEMENT sur le fil (base64 ×1,33), mesuré sur une image
 * de production.
 *
 * ⚠️ POURQUOI CE FICHIER EXISTE (incident mesuré, 2026-11-01) : une capture de
 * **2 876 Ko / 2231×961** jointe à un message faisait répondre au fournisseur
 * `500 « request entity too large »`, **0 jeton produit**, 17 s perdues. La cause
 * n'était ni le fournisseur ni le modèle (la MÊME image, avec le MÊME modèle,
 * arrive très bien quand le client la ré-encode) : c'était la POLITIQUE D'IMAGE de
 * Yuki, qui raisonnait en octets d'ORIGINE (`files.imageMaxBytes`, traduit en
 * budget base64 de 4 666 668 octets) au lieu de borner les octets TRANSMIS.
 *
 * Ce fichier prouve trois choses, avec de VRAIES images et le VRAI réducteur
 * (`sdkVisionImageResizer` → Photon/WASM) :
 *  1. l'image de production part **sous 1 Mo** de base64, côté ramené à ≤ 2 000 px ;
 *  2. **la requête PART** : un fournisseur SIMULÉ qui mesure le corps l'accepte ;
 *     le même fournisseur REFUSE (500 « request entity too large ») le corps que
 *     l'ancienne politique émettait — la panne de production est reproduite ;
 *  3. une image énorme qui ne peut pas descendre sous le plancher lisible est
 *     REFUSÉE **avant** l'appel (message clair, **zéro** requête émise).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  base64Size,
  prepareVisionImage,
  VISION_MAX_EDGE,
  VISION_MIN_EDGE,
} from "../../src/files/vision.js";
import { DEFAULT_IMAGE_MAX_BYTES } from "../../src/files/types.js";
import { sdkVisionImageResizer } from "../../src/pi/index.js";
import { detailedScreenshotPng } from "./png-fixture.js";

/** Image de production : 2231×961, quelques Mo (mesuré : 3 194 423 octets). */
const PRODUCTION = { width: 2_231, height: 961 };
/**
 * Plafond TRANSMIS de production — défaut de `files.imageMaxWireBytes`, verrouillé
 * par `tests/config/schema-files.test.ts` (valeur écrite ici pour que ce fichier
 * échoue PAR SON ASSERTION, et non au chargement, sur le code d'origine).
 */
const WIRE_LIMIT = 700_000;
/** Plafond du corps que le fournisseur simulé accepte (2 Mio). */
const PROVIDER_BODY_LIMIT = 2 * 1024 * 1024;

interface Stub {
  url: string;
  /** Longueurs des corps REÇUS (octets, tels quels, en-têtes exclus). */
  received: number[];
  close(): Promise<void>;
}

/**
 * Fournisseur OpenAI-compatible SIMULÉ qui MESURE le corps reçu.
 *
 * ⚠️ Il reproduit le refus observé en production : au-delà du plafond, il répond
 * `500 « request entity too large »` — exactement le texte que l'utilisateur a lu.
 */
async function startMeasuringProvider(): Promise<Stub> {
  const received: number[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // On continue de lire (le client doit recevoir SA réponse), mais on a
      // déjà décidé : c'est la taille du corps qui fait foi.
      if (size > PROVIDER_BODY_LIMIT) tooLarge = true;
    });
    req.on("end", () => {
      received.push(size);
      if (tooLarge) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "request entity too large" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-vision", choices: [{ message: { content: "vu" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const stubs: Stub[] = [];
afterEach(async () => {
  for (const stub of stubs.splice(0)) await stub.close();
});

/**
 * Envoie au fournisseur simulé le corps EXACT qu'un client compatible OpenAI
 * construit pour une image (data-URL base64), et rend le statut obtenu.
 */
async function sendAsProviderBody(
  stub: Stub,
  image: { data: string; mimeType: string },
): Promise<number> {
  const body = JSON.stringify({
    model: "gemma4:31b",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "regarde cette capture" },
          {
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          },
        ],
      },
    ],
  });
  const response = await fetch(stub.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await response.text();
  return response.status;
}

describe("vision — octets TRANSMIS (l'image de production, mesurée)", () => {
  it("la capture 2 876 Ko / 2231×961 part sous 1 Mo et la REQUÊTE PASSE", async () => {
    const original = detailedScreenshotPng(PRODUCTION.width, PRODUCTION.height);
    // Le cas de production : quelques Mo, et 2 231 px de côté (> 2 000).
    expect(original.length).toBeGreaterThan(2_800_000);
    expect(base64Size(original.length)).toBeGreaterThan(PROVIDER_BODY_LIMIT);

    const outcome = await prepareVisionImage({
      name: "cypher-2.png",
      bytes: original,
      ext: "png",
      mimeType: "image/png",
      width: PRODUCTION.width,
      height: PRODUCTION.height,
      maxBytes: DEFAULT_IMAGE_MAX_BYTES,
      maxWireBytes: WIRE_LIMIT,
      resize: sdkVisionImageResizer,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // ① Le côté est ramené sous 2 000 px (2 231 → 2 000).
    expect(Math.max(outcome.width ?? 0, outcome.height ?? 0)).toBeLessThanOrEqual(VISION_MAX_EDGE);
    // …et reste LISIBLE (on ne livre pas une vignette).
    expect(Math.max(outcome.width ?? 0, outcome.height ?? 0)).toBeGreaterThanOrEqual(VISION_MIN_EDGE);
    // ② ⚠️ LA mesure qui compte : ce qui part réellement, en base64.
    const wire = Buffer.byteLength(outcome.image.data, "utf8");
    expect(wire).toBeLessThan(1_000_000);
    expect(wire).toBe(outcome.wireBytes);
    expect(wire).toBeLessThanOrEqual(WIRE_LIMIT);
    // Une réduction de côté seule ne fait pas ÷6 sur un PNG : c'est le RÉ-ENCODAGE
    // qui fait passer de 3,1 Mo à quelques centaines de Ko.
    expect(outcome.resized).toBe(true);

    // ③ La requête PART : le fournisseur simulé mesure le corps et l'accepte.
    const stub = await startMeasuringProvider();
    stubs.push(stub);
    expect(await sendAsProviderBody(stub, outcome.image)).toBe(200);
    expect(stub.received).toHaveLength(1);
    expect(stub.received[0]).toBeLessThan(PROVIDER_BODY_LIMIT);
  }, 60_000);

  it("l'ANCIENNE politique (budget = base64 de imageMaxBytes) produisait bien le 500", async () => {
    // ⚠️ Contre-preuve : le MÊME réducteur, avec le budget d'AVANT le correctif,
    // garde le PNG et émet ~3,2 Mio — le fournisseur simulé refuse alors avec le
    // texte exact de la production. C'est la panne reproduite, pas une hypothèse.
    const original = detailedScreenshotPng(PRODUCTION.width, PRODUCTION.height);
    const oldBudget = base64Size(DEFAULT_IMAGE_MAX_BYTES);
    const old = await sdkVisionImageResizer(original, "image/png", {
      maxWidth: VISION_MAX_EDGE,
      maxHeight: VISION_MAX_EDGE,
      maxBytes: oldBudget,
    });
    expect(old).not.toBeNull();
    if (old === null) return;
    expect(old.wasResized).toBe(true);
    expect(Buffer.byteLength(old.data, "utf8")).toBeGreaterThan(PROVIDER_BODY_LIMIT);

    const stub = await startMeasuringProvider();
    stubs.push(stub);
    expect(
      await sendAsProviderBody(stub, { data: old.data, mimeType: old.mimeType }),
    ).toBe(500);
  }, 60_000);
});

describe("vision — une image impossible à rendre lisible est refusée AVANT l'appel", () => {
  it("image énorme + plafond transmis réglé bas ⇒ `file_image_illegible`, ZÉRO requête", async () => {
    // ⚠️ Ce qui déclenche un refus n'est pas le nombre de pixels mais le BUDGET
    // D'OCTETS : à 12 000 px de côté, l'image est de toute façon ramenée à 2 000 px
    // (le côté ne coûte donc rien) — c'est le poids transmis qui décide. On prend
    // donc une image réellement énorme (3 000 × 3 000, très détaillée) et le
    // plafond TRANSMIS réglé bas : la réduction devrait descendre sous le plancher
    // lisible, et c'est un refus explicite — pas un `500` après 17 s.
    const huge = detailedScreenshotPng(3_000, 3_000, 60);
    const stub = await startMeasuringProvider();
    stubs.push(stub);

    const outcome = await prepareVisionImage({
      name: "capture-ecran-8k.png",
      bytes: huge,
      ext: "png",
      mimeType: "image/png",
      width: 3_000,
      height: 3_000,
      maxBytes: DEFAULT_IMAGE_MAX_BYTES,
      maxWireBytes: 60_000,
      resize: sdkVisionImageResizer,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("file_image_illegible");
    // Message FRANÇAIS, actionnable, qui nomme le fichier et la conséquence.
    expect(outcome.message).toContain("capture-ecran-8k.png");
    expect(outcome.message).toContain("ne serait plus lisible");
    expect(outcome.message).toContain("n'est pas transmise au modèle");
    expect(outcome.message).toContain("recadrez");
    // ⚠️ PREUVE du « avant l'appel » : aucune requête n'a été émise.
    expect(stub.received).toHaveLength(0);
  }, 60_000);
});
