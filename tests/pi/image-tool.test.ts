/**
 * Outil `generer_image` — génération d'image via ComfyUI.
 *
 * Prouve : le nom et les paramètres, la SCÈNE bornée (refus explicite au-delà de
 * 1 500 caractères, rien n'est généré), le STYLE jamais recopié dans la scène,
 * l'image transmise AU MODÈLE (bornée à 1 Mio, avec `resizeImage`), l'affichage à
 * l'humain (émission d'une vue same-origin) et le message HONNÊTE en cas d'échec.
 */

import { describe, expect, it } from "vitest";

import {
  ComfyError,
  MAX_IMAGE_SCENE_CHARS,
  type ComfyImageView,
  type GeneratedImage,
} from "../../src/comfy/index.js";
import { createImageTools, MAX_GENERATED_IMAGE_MODEL_BYTES } from "../../src/pi/sdk/image-tools.js";

type Tool = ReturnType<typeof createImageTools>[number];

type ContentPart = { type: string; text?: string; data?: string; mimeType?: string };

/** PNG 1×1 valide. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CTX = { sessionManager: { getSessionId: () => "conv-1" } };

async function call(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<{ content: ContentPart[]; text: string; details: Record<string, unknown> }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: ContentPart[]; details: Record<string, unknown> }>;
  const result = await fn("call", params, undefined, undefined, CTX);
  return {
    content: result.content,
    text: result.content.map((part) => part.text ?? "").join("\n"),
    details: result.details,
  };
}

interface Harness {
  tool: Tool;
  calls: Array<{ scene: string; style?: string }>;
  views: ComfyImageView[];
}

function harness(options: { bytes?: Uint8Array; error?: unknown; outputLabeled?: boolean } = {}): Harness {
  const calls: Array<{ scene: string; style?: string }> = [];
  const views: ComfyImageView[] = [];
  const image: GeneratedImage = {
    record: {
      id: "b".repeat(32),
      file: "/data/state/comfy/images/x.png",
      mimeType: "image/png",
      ext: "png",
      bytes: options.bytes?.byteLength ?? PNG.byteLength,
      imageSrc: `/images/${"b".repeat(32)}.png`,
      createdAt: new Date(0).toISOString(),
      promptId: "prompt-1",
      width: 1,
      height: 1,
    },
    bytes: options.bytes ?? PNG,
    promptId: "prompt-1",
    workflowName: "manga",
    elapsedMs: 12_500,
    outputLabeled: options.outputLabeled ?? true,
    labels: ["YUKI_PROMPT", "YUKI_SEED"],
  };
  const tools = createImageTools({
    async generate(input) {
      calls.push({
        scene: input.scene,
        ...(input.style !== undefined ? { style: input.style } : {}),
      });
      if (options.error) throw options.error;
      return image;
    },
    onImage: (view) => views.push(view),
  });
  return { tool: tools[0]!, calls, views };
}

describe("l'outil existe et son contrat est explicite", () => {
  it("se nomme `generer_image` et annonce les cinq étiquettes ? Non : il annonce la SCÈNE et le STYLE", () => {
    const { tool } = harness();
    expect(tool.name).toBe("generer_image");
    expect(tool.label).toContain("image");
    // La description dit ce qui est INTERDIT (le style dans le prompt)…
    expect(tool.description).toContain("AUCUNE indication de");
    expect(tool.description).toContain("STYLE");
    expect(tool.description).toContain(String(MAX_IMAGE_SCENE_CHARS));
    expect(tool.description).toContain("REFUSE");
    // …et ce qui ne doit JAMAIS être annoncé.
    expect(tool.description).toContain("N'annonce JAMAIS le style");
  });

  it("la scène est bornée par le schéma, et le style est facultatif", () => {
    const { tool } = harness();
    const schema = tool.parameters as unknown as {
      properties?: Record<string, { maxLength?: number }>;
      required?: string[];
    };
    expect(schema.properties?.scene?.maxLength).toBe(MAX_IMAGE_SCENE_CHARS);
    expect(schema.properties?.style).toBeDefined();
    expect(schema.required).toContain("scene");
    expect(schema.required).not.toContain("style");
  });
});

describe("génération et retour au modèle", () => {
  it("transmet la scène, renvoie l'image AU MODÈLE et émet la vue à l'humain", async () => {
    const { tool, calls, views } = harness();
    const scene = "Un phare isolé, battu par les vagues, au crépuscule.";
    const result = await call(tool, { scene, style: "un truc style dessin animé japonais" });

    // Le générateur reçoit la scène ET le style (il choisit le workflow)…
    expect(calls).toEqual([{ scene, style: "un truc style dessin animé japonais" }]);
    // …mais le modèle reçoit la partie image…
    const imagePart = result.content.find((part) => part.type === "image");
    expect(imagePart?.mimeType).toBe("image/png");
    expect(Buffer.from(imagePart?.data ?? "", "base64").equals(PNG)).toBe(true);
    // …et l'humain reçoit une vue SAME-ORIGIN, sans octet ni nom de fichier serveur.
    expect(views).toHaveLength(1);
    expect(views[0]?.imageSrc).toBe(`/images/${"b".repeat(32)}.png`);
    expect(views[0]?.imageSrc.startsWith("/")).toBe(true);
    expect(views[0]?.sessionId).toBe("conv-1");
    expect(JSON.stringify(views[0])).not.toContain("Yuki_00001_");
    // Le texte dit le délai et la taille, sans dévoiler le workflow retenu.
    expect(result.text).toContain("13 s");
    expect(result.text).toContain("1×1");
    expect(result.text).not.toContain("manga");
    expect(result.details.status).toBe("ok");
    expect(result.details.image_attached).toBe(true);
    expect(result.details.image_displayed_to_human).toBe(true);
  });

  it("sans YUKI_OUTPUT dans le workflow, le DIT (au modèle et à l'humain)", async () => {
    // ⚠️ Le repli « première image produite » ne doit jamais être tu : l'aperçu
    // intermédiaire d'un graphe peut sinon passer pour l'image finale.
    const { tool } = harness({ outputLabeled: false });
    const result = await call(tool, { scene: "une scène" });
    expect(result.text).toContain("YUKI_OUTPUT");
    expect(result.text).toContain("PREMIÈRE");
    expect(result.details.output_labeled).toBe(false);
    // Le style/workflow retenu reste confidentiel.
    expect(result.text).not.toContain("manga");
  });

  it("avec YUKI_OUTPUT, le résultat ne mentionne AUCUN repli", async () => {
    const { tool } = harness();
    const result = await call(tool, { scene: "une scène" });
    expect(result.text).not.toContain("YUKI_OUTPUT");
    expect(result.details.output_labeled).toBe(true);
  });

  it("le style n'est JAMAIS recopié dans la scène transmise", async () => {
    const { tool, calls } = harness();
    const scene = "Une place de village sous la neige.";
    await call(tool, { scene, style: "manga" });
    expect(calls[0]?.scene).toBe(scene);
    expect(calls[0]?.scene).not.toContain("manga");
  });

  it("omet le style quand il est vide ou absent (la scène décide)", async () => {
    const { tool, calls } = harness();
    await call(tool, { scene: "une scène" });
    await call(tool, { scene: "une scène", style: "   " });
    expect(calls).toEqual([{ scene: "une scène" }, { scene: "une scène" }]);
  });
});

describe("bornes et refus", () => {
  it("REFUSE une scène vide sans appeler le générateur", async () => {
    const { tool, calls } = harness();
    const result = await call(tool, { scene: "   " });
    expect(calls).toHaveLength(0);
    const payload = JSON.parse(result.text) as { status: string; field: string };
    expect(payload.status).toBe("invalid");
    expect(payload.field).toBe("scene");
  });

  it("REFUSE une scène au-delà de la borne, sans rien générer", async () => {
    const { tool, calls } = harness();
    const result = await call(tool, { scene: "a".repeat(MAX_IMAGE_SCENE_CHARS + 1) });
    expect(calls).toHaveLength(0);
    const payload = JSON.parse(result.text) as { status: string; message: string };
    expect(payload.status).toBe("invalid");
    expect(payload.message).toContain(String(MAX_IMAGE_SCENE_CHARS));
  });

  it("n'attache PAS au modèle une image au-delà du plafond, et le DIT", async () => {
    // ⚠️ Un buffer d'octets NON décodables : `resizeImage` échouera, donc l'image
    // ne doit pas être jointe (jamais un puits non borné dans le contexte).
    const tooBig = new Uint8Array(MAX_GENERATED_IMAGE_MODEL_BYTES + 1);
    const { tool } = harness({ bytes: tooBig });
    const result = await call(tool, { scene: "une scène" });
    expect(result.content.some((part) => part.type === "image")).toBe(false);
    expect(result.details.image_attached).toBe(false);
    expect(result.text).toContain("tu ne l'as");
    expect(result.text).toContain("PAS vue");
  });
});

describe("échec honnête (PIÈGE ⑧)", () => {
  it("rapporte le message RÉEL de la couche comfy, en français", async () => {
    const { tool } = harness({
      error: new ComfyError(
        "timeout",
        "La génération n'a pas abouti en 180 s (prompt abc). Elle est peut-être " +
          "encore en file sur ComfyUI : vérifiez la file du serveur avant de relancer.",
      ),
    });
    const result = await call(tool, { scene: "une scène" });
    const payload = JSON.parse(result.text) as { status: string; code: string; message: string };
    expect(payload.status).toBe("error");
    expect(payload.code).toBe("timeout");
    expect(payload.message).toContain("n'a pas abouti");
    expect(payload.message).toContain("file");
    // Aucun contenu d'image dans un échec.
    expect(result.content.some((part) => part.type === "image")).toBe(false);
  });

  it("n'invente pas de cause pour une erreur inconnue", async () => {
    const { tool } = harness({ error: new Error("boum interne") });
    const result = await call(tool, { scene: "une scène" });
    const payload = JSON.parse(result.text) as { code: string; message: string };
    expect(payload.code).toBe("internal_error");
    expect(payload.message).toContain("boum interne");
  });
});
