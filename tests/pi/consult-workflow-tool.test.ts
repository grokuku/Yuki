/**
 * `consulter_workflow` — les CONSIGNES D'ÉCRITURE d'un workflow, et la MESURE de
 * leur consultation avant génération.
 *
 * ⚠️ Ce que ce fichier PROUVE (demande utilisateur) :
 *  ① `consulter_workflow` rend la BONNE documentation : celle du workflow retenu
 *    par PROXIMITÉ (et pas celle d'un autre) ;
 *  ② un workflow SANS documentation répond explicitement (« aucune consigne
 *    particulière ») — ce n'est PAS une erreur, et il reste générable ;
 *  ③ la documentation n'apparaît JAMAIS dans la SCÈNE ni dans le JSON réellement
 *    posté à ComfyUI (assertion sur le graphe soumis) ;
 *  ④ la documentation n'est PAS dans le prompt système : elle n'est pas portée
 *    par `candidates()`, donc pas par le bloc `<styles_image>` ;
 *  ⑤ `generer_image` fonctionne SANS consultation (aucun refus) ;
 *  ⑥ la borne de documentation est respectée (8 000) ;
 *  ⑦ le compteur « le style a-t-il été consulté AVANT la génération ? » est
 *    instrumenté (résultat de l'outil + journal), sans taux inventé.
 *
 * Chaîne RÉELLE : store de workflows sur disque → outil → générateur → client
 * ComfyUI double (le graphe posté est CAPTURÉ tel quel).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ComfyWorkflowStore,
  GeneratedImagesStore,
  MAX_COMFY_DOCUMENTATION_CHARS,
  MAX_IMAGE_SCENE_CHARS,
  WorkflowConsultationTracker,
  createComfyGenerator,
  formatImageStylesBlock,
  type ComfyImageBytes,
  type ComfyImageClientPort,
  type ComfyLogger,
} from "../../src/comfy/index.js";
import { createImageTools, formatWorkflowDocumentation } from "../../src/pi/sdk/image-tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Marqueur repérable : il ne doit JAMAIS atterrir dans le graphe. */
const DOC_MANGA =
  "Commence par le SUJET et le cadrage en une phrase, puis le décor et la lumière. " +
  "Deux phrases suffisent ; pas de listes ; n'écris jamais le nom du style dans la scène.";
const DOC_REALISTE =
  "Décris une scène photographique : objectif, distance, source de lumière réelle, " +
  "textures de peau et de tissu. Pas d'adjectifs de style.";

function workflow(): Record<string, unknown> {
  return {
    "enc-positif": {
      class_type: "CLIPTextEncode",
      inputs: { text: "text" },
      _meta: { title: "YUKI_PROMPT" },
    },
    "save-1": { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
  };
}

const CTX = { sessionManager: { getSessionId: () => "conv-1" } };

type Tool = ReturnType<typeof createImageTools>[number];

async function call(
  tool: Tool,
  params: Record<string, unknown>,
  ctx: unknown = CTX,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const fn = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
  const result = await fn("call", params, undefined, undefined, ctx);
  return { text: result.content.map((part) => part.text ?? "").join("\n"), details: result.details };
}

interface Harness {
  store: ComfyWorkflowStore;
  tools: Tool[];
  /** JSON RÉELLEMENT soumis à ComfyUI (une entrée par génération). */
  submitted: string[];
  /** Événements journalisés (preuve de l'exposition du compteur). */
  events: Array<{ event: string; data?: Record<string, unknown> }>;
  tracker: WorkflowConsultationTracker;
}

function harness(options: { documentation?: string } = {}): Harness {
  const dir = tempDir("yuki-consult-");
  const store = new ComfyWorkflowStore({ path: join(dir, "comfy", "workflows.json") });
  store.importWorkflow({
    name: "manga",
    description: "Manga / anime — traits marqués, trames",
    documentation: options.documentation ?? DOC_MANGA,
    workflow: workflow(),
    isDefault: true,
  });
  store.importWorkflow({
    name: "realiste",
    description: "Photo réaliste — rendu naturel, profondeur",
    documentation: DOC_REALISTE,
    workflow: workflow(),
  });

  const submitted: string[] = [];
  const client: ComfyImageClientPort = {
    async systemStats() {
      return { devices: [] };
    },
    async generate(graph): Promise<ComfyImageBytes> {
      submitted.push(JSON.stringify(graph));
      return {
        bytes: PNG,
        mimeType: "image/png",
        filename: "Yuki_00001_.png",
        subfolder: "",
        type: "output",
        promptId: "prompt-1",
      };
    },
  };
  const images = new GeneratedImagesStore({ dir: join(dir, "images") });
  const generator = createComfyGenerator({
    client,
    workflows: store,
    images,
    sizes: () => ({ width: 512, height: 512 }),
  });

  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const logger: ComfyLogger = {
    info: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
    warn: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
    error: (event, data) => events.push({ event, ...(data ? { data } : {}) }),
  };
  const tracker = new WorkflowConsultationTracker();
  const tools = createImageTools({
    generate: generator.generate,
    workflows: {
      candidates: () => store.candidates(),
      documentationOf: (name) => store.get(name)?.documentation ?? "",
    },
    consultation: tracker,
    logger,
  });
  return { store, tools, submitted, events, tracker };
}

describe("consulter_workflow : la BONNE documentation, par proximité", () => {
  it("rend la documentation du workflow retenu (proximité), et pas celle d'un autre", async () => {
    const { tools } = harness();
    const result = await call(tools[1]!, { style: "un truc style dessin animé japonais" });
    expect(result.text).toContain("Commence par le SUJET");
    expect(result.text).not.toContain("scène photographique");
    expect(result.details.status).toBe("ok");
    expect(result.details.has_documentation).toBe(true);
    expect(result.details.documentation_chars).toBe(DOC_MANGA.length);
  });

  it("sans style : c'est le workflow PAR DÉFAUT qui est consulté", async () => {
    const { tools } = harness();
    const result = await call(tools[1]!, {});
    expect(result.text).toContain("Commence par le SUJET");
  });

  it("choisit le bon workflow pour une demande d'un AUTRE style", async () => {
    const { tools } = harness();
    const result = await call(tools[1]!, { style: "une photo réaliste" });
    expect(result.text).toContain("scène photographique");
    expect(result.text).not.toContain("Commence par le SUJET");
  });

  it("présente les consignes comme des CONSIGNES (jamais recopiées dans la scène)", async () => {
    const { tools } = harness();
    const result = await call(tools[1]!, {});
    expect(result.text).toContain("à SUIVRE");
    expect(result.text).toContain("JAMAIS être recopiées");
    // Les bornes utiles sont dites.
    expect(result.text).toContain(String(MAX_IMAGE_SCENE_CHARS));
    expect(result.details.scene_limit).toBe(MAX_IMAGE_SCENE_CHARS);
    // Le nom du workflow n'est pas annoncé (même doctrine que `generer_image`).
    expect(result.text).not.toContain("manga");
    expect(JSON.stringify(result.details)).not.toContain("manga");
  });

  it("n'ouvre AUCUN appel réseau : deux consultations de suite sont identiques", async () => {
    const { tools, submitted } = harness();
    const first = await call(tools[1]!, {});
    const second = await call(tools[1]!, {});
    expect(second.text).toBe(first.text);
    expect(submitted).toHaveLength(0);
  });
});

describe("workflow SANS documentation : réponse explicite, pas une erreur", () => {
  it("dit « aucune consigne particulière » et reste générable", async () => {
    const { tools } = harness({ documentation: "" });
    const consulted = await call(tools[1]!, { style: "manga" });
    expect(consulted.details.status).toBe("empty");
    expect(consulted.details.has_documentation).toBe(false);
    expect(consulted.text).toContain("Aucune consigne particulière");
    expect(consulted.text).not.toContain("erreur");
    expect(() => JSON.parse(consulted.text)).toThrow(); // une phrase, pas un JSON d'échec

    // …et la génération fonctionne (aucun refus).
    const generated = await call(tools[0]!, { scene: "Un phare isolé." });
    expect(generated.details.status).toBe("ok");
  });

  it("ne casse pas quand aucun workflow n'est importé (message actionnable)", async () => {
    const dir = tempDir("yuki-consult-empty-");
    const store = new ComfyWorkflowStore({ path: join(dir, "w.json") });
    const tools = createImageTools({
      generate: async () => {
        throw new Error("non utilisé");
      },
      workflows: {
        candidates: () => store.candidates(),
        documentationOf: () => "",
      },
    });
    const result = await call(tools[1]!, {});
    expect(result.details.status).toBe("no_workflow");
    expect(result.text).toContain("Aucun workflow");
  });
});

describe("la documentation ne fuit ni dans la scène ni dans le graphe", () => {
  it("le JSON RÉELLEMENT posté à ComfyUI ne contient AUCUNE consigne", async () => {
    const { tools, submitted } = harness();
    await call(tools[1]!, { style: "un truc style dessin animé japonais" });
    const scene = "Une femme âgée arrose des tomates au soleil couchant.";
    const generated = await call(tools[0]!, { scene, style: "un truc style dessin animé japonais" });
    expect(generated.details.status).toBe("ok");

    expect(submitted).toHaveLength(1);
    const graph = submitted[0]!;
    // ① Le texte injecté est EXACTEMENT la scène.
    expect(JSON.parse(graph)).toMatchObject({
      "enc-positif": { inputs: { text: scene } },
    });
    // ② Aucun fragment de la documentation ne s'y trouve.
    expect(graph).not.toContain("Commence par le SUJET");
    expect(graph).not.toContain("scène photographique");
    expect(graph).not.toContain("cadrage en une phrase");
    expect(graph).not.toContain("manga");
  });

  it("la documentation n'est PAS portée par `candidates()` ⇒ absente du prompt système", () => {
    const { store } = harness();
    // Ce que reçoit le bloc injecté à CHAQUE tour :
    const candidates = store.candidates();
    expect(JSON.stringify(candidates)).not.toContain("Commence par le SUJET");
    expect(Object.keys(candidates[0]!).sort()).toEqual(["description", "isDefault", "name"]);

    const block = formatImageStylesBlock(candidates, { enabled: true }) as string;
    expect(block).toContain("manga");
    expect(block).not.toContain("Commence par le SUJET");
    expect(block).not.toContain("scène photographique");
  });

  it("la documentation n'est pas non plus dans le résultat de `generer_image`", async () => {
    const { tools } = harness();
    await call(tools[1]!, {});
    const generated = await call(tools[0]!, { scene: "Un phare isolé." });
    expect(generated.text).not.toContain("Commence par le SUJET");
    expect(JSON.stringify(generated.details)).not.toContain("Commence par le SUJET");
  });
});

describe("`generer_image` SANS consultation : aucun refus", () => {
  it("génère quand même, et le DIT côté mesure (pas côté refus)", async () => {
    const { tools, submitted } = harness();
    const result = await call(tools[0]!, { scene: "Un phare isolé." });
    expect(result.details.status).toBe("ok");
    expect(submitted).toHaveLength(1);
    // Aucune formule de refus dans le texte.
    expect(result.text.toLowerCase()).not.toContain("refus");
    expect(result.text).not.toContain("consulter_workflow");
    // La mesure est présente : ce style n'avait PAS été consulté avant.
    expect(result.details.workflow_consulted_before).toBe(false);
  });
});

describe("mesure : le style a-t-il été consulté AVANT la génération ?", () => {
  it("compte par génération, par conversation, et journalise le fait", async () => {
    const { tools, events } = harness();
    const consult = tools[1]!;
    const generate = tools[0]!;

    // 1) Consultation PUIS génération, même conversation ⇒ consulté avant.
    await call(consult, { style: "manga" }, CTX);
    const first = await call(generate, { scene: "Un phare.", style: "manga" }, CTX);
    expect(first.details.workflow_consulted_before).toBe(true);
    expect(first.details.consultation).toEqual({ generations: 1, consulted_before: 1 });

    // 2) Génération SANS consultation préalable (autre conversation) ⇒ non.
    const other = { sessionManager: { getSessionId: () => "conv-2" } };
    const second = await call(generate, { scene: "Un phare.", style: "manga" }, other);
    expect(second.details.workflow_consulted_before).toBe(false);
    expect(second.details.consultation).toEqual({ generations: 2, consulted_before: 1 });

    // 3) Les DEUX faits sont journalisés (exposition en production).
    const journal = events.filter((entry) => entry.event === "comfy.generation.consulted_before");
    expect(journal).toHaveLength(2);
    expect(journal[0]?.data).toMatchObject({ workflow: "manga", consulted: true, generations: 1 });
    expect(journal[1]?.data).toMatchObject({
      workflow: "manga",
      consulted: false,
      generations: 2,
      consulted_before: 1,
    });
    // La consultation elle-même est journalisée (avec la raison du choix).
    expect(events.some((entry) => entry.event === "comfy.workflow.consulted")).toBe(true);
  });

  it("une consultation d'un AUTRE workflow ne compte pas", async () => {
    const { tools } = harness();
    await call(tools[1]!, { style: "manga" });
    const result = await call(tools[0]!, { scene: "Un phare.", style: "une photo réaliste" });
    expect(result.details.workflow_consulted_before).toBe(false);
  });

  it("expose les compteurs sans fabriquer de taux (aucune clé « ratio »)", async () => {
    const { tools, tracker } = harness();
    await call(tools[0]!, { scene: "Un phare." });
    const stats = tracker.stats();
    expect(stats).toEqual({ generations: 1, consultedBeforeCount: 0, sessions: 1 });
    expect(Object.keys(stats)).not.toContain("ratio");
  });
});

describe("borne de la documentation", () => {
  it("accepte exactement la borne et la rend entière", async () => {
    const exact = "a".repeat(MAX_COMFY_DOCUMENTATION_CHARS);
    const { tools } = harness({ documentation: exact });
    const result = await call(tools[1]!, { style: "manga" });
    expect(result.details.status).toBe("ok");
    expect(String(result.text)).toContain(exact);
    expect(result.details.documentation_chars).toBe(MAX_COMFY_DOCUMENTATION_CHARS);
  });

  it("REFUSE au-delà de la borne à l'enregistrement (aucune troncature silencieuse)", () => {
    const { store } = harness();
    expect(() => store.updateMetadata("manga", { documentation: "a".repeat(MAX_COMFY_DOCUMENTATION_CHARS + 1) })).toThrow(
      /la limite est de 8000/,
    );
    // La documentation existante est INTACTE (rien n'a été écrit à moitié).
    expect(store.get("manga")?.documentation).toBe(DOC_MANGA);
  });

  it("la borne vaut 8 000 : 7 500 caractères sont ACCEPTÉS, 8 100 sont REFUSÉS en disant 8000", async () => {
    expect(MAX_COMFY_DOCUMENTATION_CHARS).toBe(8_000);
    const long = "a".repeat(7_500);
    const accepted = harness({ documentation: long });
    const result = await call(accepted.tools[1]!, { style: "manga" });
    expect(result.details.documentation_chars).toBe(7_500);
    expect(String(result.text)).toContain(long);
    const tooLong = harness();
    expect(() => tooLong.store.updateMetadata("manga", { documentation: "a".repeat(8_100) })).toThrow(/8000/);
  });

  it("le bloc rendu est borné par la même valeur que le store", () => {
    expect(MAX_COMFY_DOCUMENTATION_CHARS).toBe(8_000);
    expect(formatWorkflowDocumentation({ documentation: "", hasDocumentation: false })).toContain(
      "Aucune consigne particulière",
    );
  });
});
