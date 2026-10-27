/**
 * Générateur d'images : choix du workflow → injection → appel → stockage.
 *
 * ⚠️ Ce que ce fichier PROUVE :
 *  - la SCÈNE au-delà de 1 500 caractères est REFUSÉE (jamais tronquée en
 *    silence) et rien n'est soumis au serveur ;
 *  - le STYLE ne sert qu'à CHOISIR le workflow : le graphe transmis au client
 *    HTTP n'en garde AUCUNE trace (PIÈGE ①) ;
 *  - les étiquettes écrites sont celles RÉSOLUES PAR TITRE (PIÈGE ②) ;
 *  - aucune image produite / trop grosse / aucun workflow ⇒ erreur honnête.
 */

import { describe, expect, it } from "vitest";

import {
  ComfyError,
  MAX_IMAGE_SCENE_CHARS,
  createComfyGenerator,
  type ComfyImageBytes,
  type ComfyImageClientPort,
  type GeneratedImageInput,
  type GeneratedImageRecord,
  type GeneratedImagesPort,
  type ComfyWorkflowEntry,
  type ComfyWorkflowSummary,
  type ComfyWorkflowsPort,
} from "../../src/comfy/index.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Workflow étiqueté complet, identifiants volontairement NON numériques. */
function workflow(): Record<string, unknown> {
  return {
    "enc-positif": {
      class_type: "CLIPTextEncode",
      inputs: { text: "text" },
      _meta: { title: "YUKI_PROMPT" },
    },
    "enc-negatif": {
      class_type: "CLIPTextEncode",
      inputs: { text: "" },
      _meta: { title: "YUKI_NEGATIVE" },
    },
    "ks-1": {
      class_type: "KSampler",
      inputs: { seed: 0, steps: 20 },
      _meta: { title: "YUKI_SEED" },
    },
    "latent": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512 },
      _meta: { title: "YUKI_WIDTH" },
    },
    "latent-h": {
      class_type: "EmptyLatentImage",
      inputs: { height: 512 },
      _meta: { title: "YUKI_HEIGHT" },
    },
    "save": { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
  };
}

interface Harness {
  generate: ReturnType<typeof createComfyGenerator>;
  submitted: Array<Record<string, unknown>>;
  /** Options réellement passées au client (dont `outputNodeId`). */
  submitOptions: Array<{ outputNodeId?: string }>;
  saved: GeneratedImageInput[];
  summaries: Map<string, ComfyWorkflowEntry>;
  /** Événements journalisés (preuve du repli ANNONCÉ). */
  events: string[];
}

function harness(options: {
  candidates?: Array<{ name: string; description: string; isDefault: boolean }>;
  image?: Partial<ComfyImageBytes>;
  saveReturnsNull?: boolean;
  sizes?: { width: number; height: number };
  clientError?: Error;
} = {}): Harness {
  const submitted: Array<Record<string, unknown>> = [];
  const submitOptions: Array<{ outputNodeId?: string }> = [];
  const events: string[] = [];
  const saved: GeneratedImageInput[] = [];
  const names = options.candidates ?? [
    { name: "manga", description: "Manga / anime — traits marqués, trames", isDefault: false },
    { name: "realiste", description: "Photo réaliste — rendu naturel, profondeur", isDefault: false },
    { name: "infographie", description: "Infographie — aplats, formes nettes, lisible", isDefault: true },
  ];
  const summaries = new Map<string, ComfyWorkflowEntry>();
  const list: ComfyWorkflowSummary[] = names.map((candidate) => {
    summaries.set(candidate.name, {
      ...candidate,
      addedAt: new Date(0).toISOString(),
      bytes: 10,
      nodes: 6,
      found: ["YUKI_PROMPT", "YUKI_NEGATIVE", "YUKI_SEED", "YUKI_WIDTH", "YUKI_HEIGHT"],
      missing: [],
      workflow: workflow(),
      labels: {
        YUKI_PROMPT: { nodeId: "enc-positif", classType: "CLIPTextEncode", field: "text" },
        YUKI_NEGATIVE: { nodeId: "enc-negatif", classType: "CLIPTextEncode", field: "text" },
        YUKI_SEED: { nodeId: "ks-1", classType: "KSampler", field: "seed" },
        YUKI_WIDTH: { nodeId: "latent", classType: "EmptyLatentImage", field: "width" },
        YUKI_HEIGHT: { nodeId: "latent-h", classType: "EmptyLatentImage", field: "height" },
      },
    });
    const { workflow: _w, labels: _l, ...summary } = summaries.get(candidate.name) as ComfyWorkflowEntry;
    return summary;
  });
  const workflows: ComfyWorkflowsPort = {
    list: () => list,
    candidates: () =>
      list.map(({ name, description, isDefault }) => ({ name, description, isDefault })),
    get: (name) => summaries.get(name) ?? null,
    importWorkflow: () => {
      throw new Error("non utilisé");
    },
    remove: () => false,
    setDefault: () => false,
  };
  const client: ComfyImageClientPort = {
    async systemStats() {
      return { devices: [] };
    },
    async generate(graph, generateOptions) {
      submitted.push(JSON.parse(JSON.stringify(graph)) as Record<string, unknown>);
      submitOptions.push({ ...(generateOptions?.outputNodeId !== undefined ? { outputNodeId: generateOptions.outputNodeId } : {}) });
      if (options.clientError) throw options.clientError;
      return {
        bytes: PNG,
        mimeType: "image/png",
        filename: "Yuki_00001_.png",
        subfolder: "",
        type: "output",
        promptId: "prompt-1",
        ...options.image,
      };
    },
  };
  const images: GeneratedImagesPort = {
    save(input) {
      saved.push(input);
      if (options.saveReturnsNull) return null;
      const record: GeneratedImageRecord = {
        id: "a".repeat(32),
        file: "/data/state/comfy/images/x.png",
        mimeType: input.mimeType,
        ext: "png",
        bytes: input.data.byteLength,
        imageSrc: `/images/${"a".repeat(32)}.png`,
        createdAt: new Date(0).toISOString(),
        promptId: input.promptId,
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
      };
      return record;
    },
    read: () => null,
  };
  return {
    submitted,
    submitOptions,
    saved,
    events,
    summaries,
    generate: createComfyGenerator({
      client,
      workflows,
      images,
      sizes: () => options.sizes ?? { width: 1024, height: 1024 },
      seed: () => 4_242,
      logger: {
        info: (event) => events.push(event),
        warn: (event) => events.push(event),
        error: (event) => events.push(event),
      },
    }),
  };
}

describe("scène : texte libre, bornée, JAMAIS de style", () => {
  it("REFUSE une scène de plus de 1 500 caractères (aucune troncature silencieuse)", async () => {
    const { generate, submitted } = harness();
    const scene = "a".repeat(MAX_IMAGE_SCENE_CHARS + 1);
    const error = (await generate.generate({ scene }).catch((caught: unknown) => caught)) as ComfyError;
    expect(error).toBeInstanceOf(ComfyError);
    expect(error.code).toBe("scene_too_long");
    expect(error.message).toContain(String(MAX_IMAGE_SCENE_CHARS));
    expect(error.message).toContain("Raccourcis-la");
    expect(submitted).toHaveLength(0); // rien n'est parti au serveur
  });

  it("accepte une scène à la borne EXACTE", async () => {
    const { generate } = harness();
    const scene = "b".repeat(MAX_IMAGE_SCENE_CHARS);
    const result = await generate.generate({ scene });
    expect(result.labels).toContain("YUKI_PROMPT");
  });

  it("refuse une scène vide", async () => {
    const { generate } = harness();
    await expect(generate.generate({ scene: "   " })).rejects.toThrow(/scène est vide/);
  });
});

describe("étiquettes écrites aux BONS champs (PIÈGE ②)", () => {
  it("écrit les cinq valeurs, par TITRE, dans des nœuds aux identifiants non numériques", async () => {
    const { generate, submitted } = harness({ sizes: { width: 768, height: 512 } });
    const scene = "Un vieux phare battu par les vagues, au crépuscule.";
    const result = await generate.generate({ scene });
    expect(result.labels).toEqual([
      "YUKI_PROMPT",
      "YUKI_NEGATIVE",
      "YUKI_SEED",
      "YUKI_WIDTH",
      "YUKI_HEIGHT",
    ]);
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["enc-positif"]?.inputs.text).toBe(scene);
    expect(graph["enc-negatif"]?.inputs.text).toContain("flou");
    expect(graph["ks-1"]?.inputs.seed).toBe(4_242);
    expect(graph["latent"]?.inputs.width).toBe(768);
    expect(graph["latent-h"]?.inputs.height).toBe(512);
    // Les nœuds non étiquetés sont INTACTS.
    expect(graph.save?.inputs.filename_prefix).toBe("Yuki");
  });

  it("n'injecte QUE les étiquettes présentes dans le graphe", async () => {
    // Un SEUL workflow, qui ne porte QUE le prompt obligatoire.
    const { generate, summaries, submitted } = harness({
      candidates: [{ name: "manga", description: "Manga / anime", isDefault: true }],
    });
    const entry = summaries.get("manga") as ComfyWorkflowEntry;
    entry.labels = {
      YUKI_PROMPT: { nodeId: "enc-positif", classType: "CLIPTextEncode", field: "text" },
    };
    const result = await generate.generate({ scene: "une scène" });
    expect(result.labels).toEqual(["YUKI_PROMPT"]);
    const graph = submitted[0] as Record<string, { inputs: Record<string, unknown> }>;
    expect(graph["enc-negatif"]?.inputs.text).toBe(""); // négatif absent ⇒ intact
    expect(graph["ks-1"]?.inputs.seed).toBe(0); // graine ⇒ intacte
  });
});

describe("le STYLE choisit le workflow et ne part JAMAIS dans le prompt (PIÈGE ①)", () => {
  it("« dessin animé japonais » ⇒ workflow manga, et le style est ABSENT du graphe", async () => {
    const { generate, submitted } = harness();
    const scene = "Une écolière court sous la pluie en tenant son cartable au-dessus de sa tête.";
    const result = await generate.generate({ scene, style: "un truc style dessin animé japonais" });

    // Le workflow retenu (usage interne, jamais annoncé au modèle).
    expect(result.workflowName).toBe("manga");

    // ⚠️ Assertion sur le JSON RÉELLEMENT TRANSMIS.
    const serialized = JSON.stringify(submitted[0]);
    expect(serialized).toContain("cartable");
    for (const forbidden of ["dessin", "animé", "anime", "japonais", "manga", "style"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("sans style, choisit d'après la SCÈNE", async () => {
    const { generate } = harness();
    const result = await generate.generate({
      scene: "Un portrait aux traits marqués, avec des trames et des aplats noirs.",
    });
    expect(result.workflowName).toBe("manga");
  });

  it("rien ne correspond ⇒ le workflow PAR DÉFAUT", async () => {
    const { generate } = harness();
    const result = await generate.generate({ scene: "zzz qqq", style: "zzz qqq" });
    expect(result.workflowName).toBe("infographie");
  });
});

describe("échecs honnêtes", () => {
  it("aucun workflow importé ⇒ message qui explique quoi importer", async () => {
    const { generate } = harness({ candidates: [] });
    const error = (await generate
      .generate({ scene: "une scène" })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("no_workflow");
    expect(error.message).toContain("YUKI_PROMPT");
    expect(error.message).toContain("FORMAT API");
  });

  it("aucune correspondance ET aucun défaut ⇒ refus explicite (jamais au hasard)", async () => {
    const { generate } = harness({
      candidates: [
        { name: "manga", description: "Manga / anime", isDefault: false },
        { name: "realiste", description: "Photo réaliste", isDefault: false },
      ],
    });
    const error = (await generate
      .generate({ scene: "zzz qqq", style: "zzz" })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("no_matching_workflow");
    expect(error.message).toContain("par défaut");
  });

  it("propage l'erreur du client SANS la réécrire", async () => {
    const original = new ComfyError("timeout", "La génération n'a pas abouti en 180 s (prompt x).");
    const { generate } = harness({ clientError: original });
    const error = (await generate
      .generate({ scene: "une scène" })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error).toBe(original);
  });

  it("image non conservable ⇒ message qui dit quoi réduire", async () => {
    const { generate } = harness({ saveReturnsNull: true });
    const error = (await generate
      .generate({ scene: "une scène" })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error.code).toBe("image_too_large");
    expect(error.message).toContain("largeur/hauteur");
  });

  it("l'image est enregistrée avec ses dimensions réelles et le prompt_id", async () => {
    const { generate, saved } = harness();
    const result = await generate.generate({ scene: "une scène" });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.mimeType).toBe("image/png");
    expect(saved[0]?.promptId).toBe("prompt-1");
    expect(saved[0]?.width).toBe(1);
    expect(saved[0]?.height).toBe(1);
    expect(result.record.imageSrc.startsWith("/images/")).toBe(true);
  });
});

describe("YUKI_OUTPUT : l'image FINALE, et le repli ANNONCÉ (PIÈGE ①)", () => {
  /** Ajoute un nœud de sortie étiqueté `YUKI_OUTPUT` au workflow par défaut. */
  function withOutput(summaries: Map<string, ComfyWorkflowEntry>): ComfyWorkflowEntry {
    const entry = summaries.get("infographie") as ComfyWorkflowEntry;
    entry.workflow = {
      ...entry.workflow,
      "preview-final": {
        class_type: "PreviewImage",
        inputs: { images: ["save", 0] },
        _meta: { title: "YUKI_OUTPUT" },
      },
    };
    entry.labels = {
      ...entry.labels,
      YUKI_OUTPUT: { nodeId: "preview-final", classType: "PreviewImage" },
    };
    return entry;
  }

  it("transmet au client le nœud étiqueté — et SEULEMENT lui", async () => {
    const { generate, summaries, submitOptions, events } = harness();
    withOutput(summaries);
    const result = await generate.generate({ scene: "zzz qqq", style: "zzz" });
    expect(result.workflowName).toBe("infographie");
    expect(submitOptions[0]?.outputNodeId).toBe("preview-final");
    expect(result.outputLabeled).toBe(true);
    // Aucun repli annoncé : le workflow est étiqueté.
    expect(events).not.toContain("comfy.generation.output_unlabeled");
  });

  it("sans étiquette : comportement HISTORIQUE conservé, mais le repli est JOURNALISÉ", async () => {
    const { generate, submitOptions, events, submitted } = harness();
    const result = await generate.generate({ scene: "zzz qqq", style: "zzz" });
    // 1) Le comportement ne change pas : rien n'est imposé au client…
    expect(submitOptions[0]?.outputNodeId).toBeUndefined();
    expect(submitted).toHaveLength(1);
    // 2) …et l'image revient normalement.
    expect(result.outputLabeled).toBe(false);
    expect(result.record.imageSrc.startsWith("/images/")).toBe(true);
    // 3) ⚠️ Le repli est DIT (journal) : jamais un silence.
    expect(events).toContain("comfy.generation.output_unlabeled");
  });

  it("propage l'erreur du nœud étiqueté SANS repli ni réécriture", async () => {
    const original = new ComfyError(
      "no_image",
      "Le nœud étiqueté « YUKI_OUTPUT » (id preview-final) n'a produit AUCUNE image",
    );
    const { generate, summaries } = harness({ clientError: original });
    withOutput(summaries);
    const error = (await generate
      .generate({ scene: "zzz qqq", style: "zzz" })
      .catch((caught: unknown) => caught)) as ComfyError;
    expect(error).toBe(original);
    expect(error.code).toBe("no_image");
    expect(error.message).toContain("YUKI_OUTPUT");
  });
});
