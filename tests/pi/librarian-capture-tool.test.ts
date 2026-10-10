/**
 * Outil `capture_libraire` — capture de page web via Libry.
 *
 * Prouve : les noms/paramètres, le refus LOCAL des URL non http/https (avant
 * tout réseau), le réglage d'activation (enum `off`), la transmission BORNÉE de
 * l'image AU MODÈLE, l'affichage à l'HUMAIN (émission d'une vue) et l'encadrement
 * `<libraire>` (page web = donnée non fiable).
 */

import { describe, expect, it } from "vitest";

import { LibrarianError } from "../../src/librarian/errors.js";
import { MAX_LIBRARIAN_SHOT_BYTES } from "../../src/librarian/shots.js";
import type {
  LibrarianArchivePort,
  LibrarianPort,
  LibrarianScreenshot,
  LibrarianScreenshotPort,
  LibrarianShotImage,
} from "../../src/librarian/types.js";
import type {
  LibrarianShotInput,
  LibrarianShotRecord,
  LibrarianShotView,
  LibrarianShotsPort,
} from "../../src/librarian/shots.js";
import { LIBRARIAN_TAG } from "../../src/librarian/output.js";
import { createLibrarianTools, MAX_LIBRARIAN_SHOT_MODEL_BYTES } from "../../src/pi/sdk/librarian-tools.js";

type Tool = ReturnType<typeof createLibrarianTools>[number];

type ContentPart = { type: string; text?: string; data?: string; mimeType?: string };

async function call(
  tool: Tool,
  params: Record<string, unknown>,
  ctx: unknown = CTX,
): Promise<{ content: ContentPart[]; text: string; details: unknown }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: ContentPart[]; details: unknown }>;
  const result = await fn("call", params, undefined, undefined, ctx);
  return {
    content: result.content,
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`Outil introuvable : ${name}`);
  return found;
}

const CTX = { sessionManager: { getSessionId: () => "conv-1" } };

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Sentinelle : une taille strictement supérieure au plafond de stockage. */
const MAX_LIBRARIAN_SHOT_BYTES_SENTINEL = MAX_LIBRARIAN_SHOT_BYTES + 1;

interface Harness {
  tools: Tool[];
  saved: LibrarianShotInput[];
  views: LibrarianShotView[];
  calls: string[];
  setScreenshot(value: () => Promise<LibrarianScreenshot>): void;
  setShot(value: () => Promise<LibrarianShotImage>): void;
}

function harness(options: { captureEnabled?: boolean; saveReturnsNull?: boolean } = {}): Harness {
  const saved: LibrarianShotInput[] = [];
  const views: LibrarianShotView[] = [];
  const calls: string[] = [];
  let screenshotImpl: () => Promise<LibrarianScreenshot> = async () => ({
    id: "shot-1",
    mimeType: "image/png",
    width: 1440,
    height: 900,
    bytes: PNG.byteLength,
    url: "https://example.com/",
  });
  let shotImpl: () => Promise<LibrarianShotImage> = async () => ({
    bytes: new Uint8Array(PNG),
    mimeType: "image/png",
  });

  const client: LibrarianPort = {
    status: async () => ({}),
    search: async () => ({ results: [] }),
    library: async () => ({ library: [] }),
    doc: async () => ({ raw: {} }),
    archive: async () => ({ name: "x", version: "1", status: 201 }),
  };
  const archive: LibrarianArchivePort = { schedule: () => ({ status: "launched", job_id: "j1" }) };
  const screenshot: LibrarianScreenshotPort = {
    screenshot: async () => {
      calls.push("screenshot");
      return screenshotImpl();
    },
    shot: async () => {
      calls.push("shot");
      return shotImpl();
    },
  };
  const shots: LibrarianShotsPort = {
    save: (input) => {
      saved.push(input);
      if (options.saveReturnsNull) return null;
      const ext = input.mimeType.includes("jpeg") ? "jpg" : "png";
      const record: LibrarianShotRecord = {
        id: "a".repeat(32),
        file: `/tmp/${"a".repeat(32)}.${ext}`,
        mimeType: input.mimeType,
        ext,
        bytes: input.data.byteLength,
        pageUrl: input.pageUrl,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
        imageSrc: `/captures/${"a".repeat(32)}.${ext}`,
        capturedAt: "2026-10-10T00:00:00.000Z",
      };
      return record;
    },
    read: () => null,
  };

  return {
    tools: createLibrarianTools({
      client,
      archive,
      screenshot,
      shots,
      onShot: (view) => views.push(view),
      captureEnabled: () => options.captureEnabled ?? true,
    }),
    saved,
    views,
    calls,
    setScreenshot: (value) => {
      screenshotImpl = value;
    },
    setShot: (value) => {
      shotImpl = value;
    },
  };
}

describe("libraire — outil capture_libraire", () => {
  it("expose l'outil supplémentaire quand la capture est câblée", () => {
    const names = harness().tools.map((tool) => tool.name);
    expect(names).toContain("capture_libraire");
    expect(names).toHaveLength(5);
  });

  it("sans port de capture, l'outil N'EXISTE PAS (les 4 outils restent)", () => {
    const client: LibrarianPort = {
      status: async () => ({}),
      search: async () => ({ results: [] }),
      library: async () => ({ library: [] }),
      doc: async () => ({ raw: {} }),
      archive: async () => ({ name: "x", version: "1", status: 201 }),
    };
    const tools = createLibrarianTools({
      client,
      archive: { schedule: () => ({ status: "launched", job_id: "j1" }) },
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "recherche_libraire",
      "liste_libraire",
      "lire_libraire",
      "archive_libraire",
    ]);
  });

  it("succès : capture, stockage local, image JOINTE au modèle, vue HUMAIN, cadrage", async () => {
    const h = harness();
    const { content, text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "https://example.com/",
      width: 1440,
      height: 900,
    });
    // Encadrement `<libraire>` infalsifiable.
    expect(text.split(`</${LIBRARIAN_TAG}>`).length - 1).toBe(1);
    expect(text).toContain("https://example.com/");
    // Image transmise AU MODÈLE (partie `image`, base64 borné).
    const imagePart = content.find((part) => part.type === "image");
    expect(imagePart).toBeTruthy();
    expect(imagePart?.mimeType).toBe("image/png");
    expect(imagePart?.data).toBe(PNG.toString("base64"));
    // Stockage local + vue diffusée à l'humain.
    expect(h.saved).toHaveLength(1);
    expect(h.views).toHaveLength(1);
    expect(h.views[0]?.imageSrc).toBe(`/captures/${"a".repeat(32)}.png`);
    expect(h.views[0]?.sessionId).toBe("conv-1");
    expect(details).toMatchObject({ status: "ok", image_attached: true, image_displayed_to_human: true });
  });

  it("REFUSE une URL non http/https AVANT tout réseau (file://)", async () => {
    const h = harness();
    const { text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "file:///etc/passwd",
    });
    expect(JSON.parse(text)).toMatchObject({ status: "invalid", field: "url" });
    expect(h.calls).toEqual([]);
    expect(details).toMatchObject({ status: "invalid" });
  });

  it("refus EXPLICITE quand la capture est désactivée (librarian.screenshot = off)", async () => {
    const h = harness({ captureEnabled: false });
    const { text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "https://example.com/",
    });
    expect(JSON.parse(text)).toMatchObject({ status: "disabled" });
    expect(h.calls).toEqual([]);
    expect(details).toMatchObject({ status: "disabled" });
  });

  it("image VOLUMINEUSE : PAS de partie image au modèle (métadonnées seules)", async () => {
    const h = harness();
    const big = new Uint8Array(MAX_LIBRARIAN_SHOT_MODEL_BYTES + 1);
    h.setShot(async () => ({ bytes: big, mimeType: "image/png" }));
    const { content, text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "https://example.com/",
    });
    expect(content.some((part) => part.type === "image")).toBe(false);
    expect(text).toContain("n'est PAS jointe");
    expect(details).toMatchObject({ image_attached: false });
  });

  it("capture trop volumineuse pour le STOCKAGE (au-delà du plafond) : métadonnées + honnêteté", async () => {
    const h = harness({ saveReturnsNull: true });
    const big = new Uint8Array(MAX_LIBRARIAN_SHOT_BYTES_SENTINEL);
    h.setShot(async () => ({ bytes: big, mimeType: "image/png" }));
    const { content, text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "https://example.com/",
    });
    expect(content.some((part) => part.type === "image")).toBe(false);
    expect(text).toContain("n'est PAS jointe");
    expect(details).toMatchObject({ image_attached: false, image_displayed_to_human: false });
  });

  it("erreur du client (403 SSRF) : code distinct remonté, aucun mensonge", async () => {
    const h = harness();
    h.setScreenshot(async () => {
      throw new LibrarianError("target_refused");
    });
    const { text, details } = await call(toolByName(h.tools, "capture_libraire"), {
      url: "http://127.0.0.1/",
    });
    expect(JSON.parse(text)).toMatchObject({ status: "error", code: "target_refused" });
    expect(details).toMatchObject({ code: "target_refused" });
  });
});
