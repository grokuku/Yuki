/**
 * `recuperer_fichier` MONTRER L'IMAGE AU MODÈLE (vision du worker lourd).
 *
 * ⚠️ Ce que le modèle reçoit VRAIMENT, cas par cas — jamais une promesse :
 *  - modèle déclaré multimodal ⇒ un bloc `{ type: "image", data, mimeType }` est
 *    joint au texte, avec le MÊME format que `generer_image`
 *    (`src/pi/sdk/image-tools.ts`) ;
 *  - modèle déclaré texte seul ⇒ AUCUN bloc image et le texte LE DIT (sinon le
 *    SDK remplacerait l'image par « (tool image omitted…) » et le worker
 *    croirait l'avoir vue) ;
 *  - image refusée par la politique de vision (trop petite ⇒ `file_image_illegible`)
 *    ⇒ aucun bloc image, le code et la raison sont DANS le résultat ;
 *  - fichier texte ⇒ aucun bloc image, la note « tu ne vois pas son contenu »
 *    reste vraie ;
 *  - préparation non branchée ⇒ aucun bloc image, et le résultat le dit.
 *
 * Ces tests ÉCHOUENT sur le code d'origine : l'outil ne rendait qu'un bloc
 * `text` (aucune notion de vision), donc l'assertion « un bloc image existe »
 * échoue, et le message « ce modèle ne reçoit pas les images » n'existait pas.
 */

import { describe, expect, it } from "vitest";

import type {
  FileGetRequest,
  FilePutRequest,
  TransferOutcome,
  TransferServicePort,
} from "../../src/agents/transfer.js";
import type { FileImagesOutcome, WireFile } from "../../src/files/types.js";
import {
  createFileTransferTools,
  type FileTransferVision,
} from "../../src/pi/sdk/execution-tools.js";

/** Base64 d'un PNG 1×1 — sert de contenu « déjà préparé » par le service. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9G0AAAAASUVORK5CYII=";

const IMAGE_FILE: WireFile = {
  id: "0".repeat(32),
  name: "capture", // ⚠️ pas d'extension : cas d'un fichier récupéré d'une machine
  mimeType: "image/png",
  bytes: 68,
  kind: "image",
  readable: false,
  url: `/fichiers/${"0".repeat(32)}.bin`,
  imageSrc: `/fichiers/${"0".repeat(32)}.bin`,
  createdAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
};

const TEXT_FILE: WireFile = {
  ...IMAGE_FILE,
  name: "temoin.txt",
  mimeType: "text/plain",
  kind: "text",
  readable: true,
  url: `/fichiers/${"0".repeat(32)}.txt`,
};

type ContentBlock = { type: string; text?: string; data?: string; mimeType?: string };

function stubService(options: {
  file?: WireFile;
  prepare?: (file: WireFile) => Promise<FileGetRequest extends never ? never : FileImagesOutcome>;
}): TransferServicePort {
  const file = options.file ?? IMAGE_FILE;
  return {
    get: async (request: FileGetRequest): Promise<TransferOutcome> => ({
      status: "completed",
      agentId: request.agentId,
      direction: "get",
      path: request.path,
      file,
      bytes: file.bytes,
      sha256: "a".repeat(64),
      message: "Fichier récupéré.",
    }),
    put: async (request: FilePutRequest): Promise<TransferOutcome> => ({
      status: "completed",
      agentId: request.agentId,
      direction: "put",
      path: request.path,
      bytes: 1,
      message: "déposé",
    }),
    ...(options.prepare ? { prepareImage: options.prepare } : {}),
  };
}

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: ContentBlock[]; details?: unknown }>;
};

function retrieveTool(
  service: TransferServicePort,
  vision?: FileTransferVision,
): AnyTool {
  const tools = createFileTransferTools(service, { approvalSessionId: () => "conv-1" }, vision);
  const tool = tools.find((candidate) => candidate.name === "recuperer_fichier");
  if (!tool) throw new Error("outil recuperer_fichier absent");
  return tool as unknown as AnyTool;
}

const CTX = { sessionManager: { getSessionId: () => "conv-1" } } as never;

async function run(tool: AnyTool): Promise<{ content: ContentBlock[]; details?: unknown }> {
  return tool.execute(
    "call-1",
    { agent: "nuc00", chemin: "/home/nico/capture" },
    undefined,
    undefined,
    CTX,
  );
}

function textOf(result: { content: ContentBlock[] }): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

describe("recuperer_fichier — l'image d'un fichier récupéré est VUE par le modèle", () => {
  it("joint un bloc image (base64 non vide + MIME) quand le modèle la reçoit", async () => {
    const tool = retrieveTool(
      stubService({
        prepare: async () => ({ ok: true, images: [{ data: PNG_B64, mimeType: "image/png" }] }),
      }),
      { imagesSupported: true, modelLabel: "llm-heavy/deepseek-v4.1-flash" },
    );

    const result = await run(tool);
    const images = result.content.filter((block) => block.type === "image");

    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    // ⚠️ Le base64 est RÉELLEMENT là (ce que le SDK transmet au fournisseur).
    expect(images[0]?.data).toBe(PNG_B64);
    expect(Buffer.from(images[0]?.data ?? "", "base64").length).toBeGreaterThan(0);
    // Le résumé JSON existant reste : l'UI et le worker le lisent.
    expect(textOf(result)).toContain('"file_id"');
    expect(textOf(result)).toContain("tu la VOIS");
    // `details` conservé et complété (l'UI s'en sert).
    const details = result.details as Record<string, unknown>;
    expect(details["status"]).toBe("completed");
    expect(details["image_attached"]).toBe(true);
    expect(details["image_mime_type"]).toBe("image/png");
  });

  it("n'envoie AUCUNE image à un modèle déclaré texte seul — et le DIT", async () => {
    let preparedCalls = 0;
    const tool = retrieveTool(
      stubService({
        prepare: async () => {
          preparedCalls += 1;
          return { ok: true, images: [{ data: PNG_B64, mimeType: "image/png" }] };
        },
      }),
      { imagesSupported: false, modelLabel: "llm-heavy/modele-texte" },
    );

    const result = await run(tool);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(0);
    // ⚠️ Aucune préparation inutile : on ne paie pas la réduction pour rien.
    expect(preparedCalls).toBe(0);

    const text = textOf(result);
    expect(text).toContain("ne reçoit PAS les images");
    expect(text).toContain("llm-heavy/modele-texte");
    // Le message dit le GESTE à faire (interface, jamais un fichier à éditer).
    expect(text).toContain("/config");
    expect((result.details as Record<string, unknown>)["image_error"]).toBe(
      "model_without_vision",
    );
  });

  it("refuse une image illisible (`file_image_illegible`) sans jamais la joindre", async () => {
    const tool = retrieveTool(
      stubService({
        prepare: async () => ({
          ok: false,
          code: "file_image_illegible",
          message:
            "L'image « capture » devrait descendre à 320×200 px pour tenir sous le " +
            "plafond de vision : à cette taille, un texte ne serait plus lisible.",
        }),
      }),
      { imagesSupported: true, modelLabel: "llm-heavy/deepseek-v4.1-flash" },
    );

    const result = await run(tool);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(0);
    const text = textOf(result);
    expect(text).toContain("file_image_illegible");
    expect(text).toContain("ne serait plus lisible");
    expect(text).toContain("n'est PAS transmise");
    const details = result.details as Record<string, unknown>;
    expect(details["image_attached"]).toBe(false);
    expect(details["image_error"]).toBe("file_image_illegible");
  });

  it("ne joint rien quand la préparation des images n'est pas branchée — et le dit", async () => {
    const tool = retrieveTool(stubService({}), {
      imagesSupported: true,
      modelLabel: "llm-heavy/deepseek-v4.1-flash",
    });

    const result = await run(tool);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(0);
    expect(textOf(result)).toContain("n'est PAS jointe ici");
    expect((result.details as Record<string, unknown>)["image_attached"]).toBe(false);
  });

  it("NON-RÉGRESSION : un fichier texte ne produit aucune image et garde sa note", async () => {
    const tool = retrieveTool(
      stubService({
        file: TEXT_FILE,
        prepare: async () => ({ ok: true, images: [{ data: PNG_B64, mimeType: "image/png" }] }),
      }),
      { imagesSupported: true, modelLabel: "llm-heavy/deepseek-v4.1-flash" },
    );

    const result = await run(tool);
    expect(result.content.filter((block) => block.type === "image")).toHaveLength(0);
    // La note historique reste vraie pour un fichier non image.
    expect(textOf(result)).toContain("Tu ne vois pas son contenu ici");
    expect((result.details as Record<string, unknown>)["image_attached"]).toBeUndefined();
  });
});
