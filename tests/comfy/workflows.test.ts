/**
 * STOCKAGE des workflows nommés (fichier SÉPARÉ du volume `state`) et des
 * IMAGES GÉNÉRÉES.
 *
 * ⚠️ Décisions verrouillées ici :
 *  - les workflows ne vivent PAS dans `config.json` (un graphe pèse des dizaines
 *    de Ko) : ils ont leur propre fichier, écrit de façon ATOMIQUE ;
 *  - un import INVALIDE est REFUSÉ et ne laisse RIEN derrière lui (PIÈGE ⑦) ;
 *  - les étiquettes sont RE-RÉSOLUES au chargement (un fichier retouché à la
 *    main ne peut pas passer pour valide) ;
 *  - l'image enregistrée porte un identifiant ALÉATOIRE (jamais le nom de
 *    fichier renvoyé par ComfyUI) et se relit sur une allowlist stricte.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  COMFY_WORKFLOWS_SCHEMA_VERSION,
  ComfyWorkflowError,
  ComfyWorkflowStore,
  GeneratedImagesStore,
  MAX_COMFY_DOCUMENTATION_CHARS,
  MAX_COMFY_WORKFLOWS,
  MAX_GENERATED_IMAGE_BYTES,
  pngDimensions,
} from "../../src/comfy/index.js";
import { ComfyWorkflowStore as DirectStore } from "../../src/comfy/workflows.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Workflow étiqueté, avec des identifiants paramétrables (PIÈGE ②). */
function workflow(ids: { prompt: string; save: string } = { prompt: "6", save: "9" }) {
  return {
    [ids.prompt]: {
      class_type: "CLIPTextEncode",
      inputs: { text: "text" },
      _meta: { title: "YUKI_PROMPT" },
    },
    [ids.save]: { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
  };
}

describe("store des workflows", () => {
  it("importe, liste et relit un workflow (fichier SÉPARÉ, schéma versionné)", () => {
    const dir = tempDir("yuki-comfy-wf-");
    const path = join(dir, "comfy", "workflows.json");
    const store = new ComfyWorkflowStore({ path });

    const summary = store.importWorkflow({
      name: "Manga",
      description: "Manga / anime — traits marqués, trames",
      workflow: workflow(),
      isDefault: true,
    });
    expect(summary.name).toBe("manga");
    expect(summary.isDefault).toBe(true);
    expect(summary.found).toEqual(["YUKI_PROMPT"]);
    expect(summary.missing).toEqual([
      "YUKI_NEGATIVE",
      "YUKI_SEED",
      "YUKI_WIDTH",
      "YUKI_HEIGHT",
      "YUKI_OUTPUT",
      "YUKI_FINAL_PROMPT",
    ]);
    expect(summary.nodes).toBe(2);
    expect(summary.bytes).toBeGreaterThan(0);

    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.schemaVersion).toBe(COMFY_WORKFLOWS_SCHEMA_VERSION);

    // Le résumé ne porte JAMAIS le graphe (l'API ne le renvoie pas par accident).
    expect(JSON.stringify(store.list())).not.toContain("class_type");
    // La relecture interne, elle, le porte.
    expect(store.get("manga")?.workflow["6"]).toBeDefined();
    expect(store.candidates()).toEqual([
      { name: "manga", description: "Manga / anime — traits marqués, trames", isDefault: true },
    ]);
  });

  it("refuse un import INVAlide et ne laisse RIEN sur le disque (PIÈGE ⑦)", () => {
    const dir = tempDir("yuki-comfy-wf-ko-");
    const path = join(dir, "workflows.json");
    const store = new ComfyWorkflowStore({ path });

    // Sans YUKI_PROMPT : refus, avec les étiquettes trouvées / manquantes.
    const error = (() => {
      try {
        store.importWorkflow({
          name: "sansprompt",
          description: "un workflow sans étiquette obligatoire",
          workflow: { 9: { class_type: "SaveImage", inputs: {} } },
        });
        return null;
      } catch (caught) {
        return caught as ComfyWorkflowError;
      }
    })();
    expect(error).toBeInstanceOf(ComfyWorkflowError);
    expect(error?.code).toBe("missing_required_label");
    expect(error?.missing).toContain("YUKI_PROMPT");
    expect(error?.found).toEqual([]);
    expect(store.size).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("refuse un workflow au format INTERFACE en le disant", () => {
    const store = new ComfyWorkflowStore({ path: join(tempDir("yuki-comfy-wf-if-"), "w.json") });
    expect(() =>
      store.importWorkflow({
        name: "interface",
        description: "export de l'éditeur",
        workflow: { nodes: [{ id: 1 }], links: [] },
      }),
    ).toThrow(/Save \(API Format\)/);
  });

  it("refuse un nom d'usage qui n'est pas un slug et une description vide", () => {
    const store = new ComfyWorkflowStore({ path: join(tempDir("yuki-comfy-wf-slug-"), "w.json") });
    expect(() =>
      store.importWorkflow({ name: "Mon Style", description: "x", workflow: workflow() }),
    ).toThrow(/nom d'usage/);
    expect(() =>
      store.importWorkflow({ name: "ok", description: "   ", workflow: workflow() }),
    ).toThrow(/OBLIGATOIRE/);
    // L'accent est refusé (le nom sert de clé, jamais un chemin).
    expect(() =>
      store.importWorkflow({ name: "réaliste", description: "x", workflow: workflow() }),
    ).toThrow(/lettres non accentuées/);
  });

  it("remplace un workflow existant et tient UN SEUL « par défaut »", () => {
    const store = new ComfyWorkflowStore({ path: join(tempDir("yuki-comfy-wf-def-"), "w.json") });
    store.importWorkflow({ name: "manga", description: "manga", workflow: workflow(), isDefault: true });
    store.importWorkflow({ name: "realiste", description: "photo", workflow: workflow() });
    expect(store.list().filter((entry) => entry.isDefault).map((entry) => entry.name)).toEqual([
      "manga",
    ]);

    store.setDefault("realiste");
    expect(store.list().filter((entry) => entry.isDefault).map((entry) => entry.name)).toEqual([
      "realiste",
    ]);

    // Réimporter « manga » sans `isDefault` ne lui retire pas la main : c'est
    // « realiste » qui reste par défaut.
    store.importWorkflow({ name: "manga", description: "manga v2", workflow: workflow() });
    expect(store.list().find((entry) => entry.name === "manga")?.description).toBe("manga v2");
    expect(store.list().find((entry) => entry.name === "manga")?.isDefault).toBe(false);
  });

  it("supprime un workflow et persiste la suppression", () => {
    const dir = tempDir("yuki-comfy-wf-del-");
    const path = join(dir, "w.json");
    const store = new ComfyWorkflowStore({ path });
    store.importWorkflow({ name: "manga", description: "manga", workflow: workflow() });
    expect(store.remove("manga")).toBe(true);
    expect(store.remove("manga")).toBe(false);
    const reloaded = new ComfyWorkflowStore({ path });
    expect(reloaded.size).toBe(0);
  });

  it("re-résout les étiquettes au CHARGEMENT (fichier retouché à la main)", () => {
    const dir = tempDir("yuki-comfy-wf-reload-");
    const path = join(dir, "w.json");
    // Fichier écrit à la main, avec le MÊME graphe mais des identifiants autres.
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: COMFY_WORKFLOWS_SCHEMA_VERSION,
        workflows: [
          {
            name: "manga",
            description: "manga",
            isDefault: false,
            addedAt: new Date(0).toISOString(),
            workflow: workflow({ prompt: "prompt-abc", save: "save-xyz" }),
          },
        ],
      }),
      "utf8",
    );
    const store = new ComfyWorkflowStore({ path });
    expect(store.get("manga")?.labels.YUKI_PROMPT?.nodeId).toBe("prompt-abc");
    // Un SECOND store sur le même fichier le relit à l'identique.
    expect(new DirectStore({ path }).get("manga")?.labels.YUKI_PROMPT?.nodeId).toBe("prompt-abc");
  });

  it("IGNORE une entrée devenue invalide, sans bloquer le démarrage", () => {
    const dir = tempDir("yuki-comfy-wf-bad-");
    const path = join(dir, "w.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: COMFY_WORKFLOWS_SCHEMA_VERSION,
        workflows: [
          {
            name: "casse",
            description: "sans étiquette obligatoire",
            isDefault: false,
            addedAt: new Date(0).toISOString(),
            workflow: { 1: { class_type: "SaveImage", inputs: {} } },
          },
        ],
      }),
      "utf8",
    );
    const warnings: string[] = [];
    const store = new ComfyWorkflowStore({
      path,
      logger: {
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
    });
    expect(store.size).toBe(0);
    expect(warnings).toContain("comfy.workflows.skipped");
    // Le fichier est CONSERVÉ (jamais effacé en silence).
    expect(existsSync(path)).toBe(true);
  });

  it("ne fait pas échouer le démarrage sur un fichier illisible ou d'un autre schéma", () => {
    const dir = tempDir("yuki-comfy-wf-unreadable-");
    const path = join(dir, "w.json");
    writeFileSync(path, "{ pas du json", "utf8");
    expect(new ComfyWorkflowStore({ path }).size).toBe(0);
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, workflows: [] }), "utf8");
    expect(new ComfyWorkflowStore({ path }).size).toBe(0);
  });

  it("borne le NOMBRE de workflows", () => {
    const store = new ComfyWorkflowStore({ path: join(tempDir("yuki-comfy-wf-max-"), "w.json") });
    for (let index = 0; index < MAX_COMFY_WORKFLOWS; index += 1) {
      store.importWorkflow({
        name: `wf${index}`,
        description: `workflow ${index}`,
        workflow: workflow(),
      });
    }
    expect(() =>
      store.importWorkflow({ name: "encore", description: "trop", workflow: workflow() }),
    ).toThrow(/nombre maximal/);
    // Remplacer un workflow EXISTANT reste possible une fois la borne atteinte.
    expect(() =>
      store.importWorkflow({ name: "wf0", description: "remplacé", workflow: workflow() }),
    ).not.toThrow();
  });
});

describe("documentation d'écriture par workflow", () => {
  const DOC =
    "Commence par le sujet et le cadrage en une phrase, puis le décor et la lumière. " +
    "Deux phrases suffisent ; pas de listes.";

  it("s'enregistre AVEC le workflow (même fichier) et se relit", () => {
    const dir = tempDir("yuki-comfy-doc-");
    const path = join(dir, "comfy", "workflows.json");
    const store = new ComfyWorkflowStore({ path });
    store.importWorkflow({
      name: "manga",
      description: "Manga / anime — traits marqués, trames",
      workflow: workflow(),
    });
    // Un workflow NEUF n'a aucune consigne : il reste utilisable tel quel.
    expect(store.get("manga")?.documentation).toBe("");

    const summary = store.updateMetadata("manga", { documentation: `  ${DOC}  ` });
    expect(summary?.documentation).toBe(DOC);
    // Persistée DANS le fichier des workflows (pas un nouveau fichier).
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
      workflows: Array<{ documentation?: string }>;
    };
    expect(onDisk.workflows[0]?.documentation).toBe(DOC);
    expect(new ComfyWorkflowStore({ path }).get("manga")?.documentation).toBe(DOC);

    // Effacer est EXPLICITE (""), jamais implicite.
    expect(store.updateMetadata("manga", { documentation: "" })?.documentation).toBe("");
    expect(new ComfyWorkflowStore({ path }).get("manga")?.documentation).toBe("");
  });

  it("n'est JAMAIS portée par `candidates()` (donc jamais dans le prompt système)", () => {
    const store = new ComfyWorkflowStore({
      path: join(tempDir("yuki-comfy-doc-cand-"), "w.json"),
    });
    store.importWorkflow({
      name: "manga",
      description: "Manga / anime",
      documentation: DOC,
      workflow: workflow(),
    });
    expect(JSON.stringify(store.candidates())).not.toContain("Commence par le sujet");
    // `list()` (API de configuration) la porte, elle : c'est l'éditeur du panneau.
    expect(store.list()[0]?.documentation).toBe(DOC);
  });

  it("est BORNÉE : refus au-delà, avec la longueur réelle (aucune troncature)", () => {
    const store = new ComfyWorkflowStore({
      path: join(tempDir("yuki-comfy-doc-max-"), "w.json"),
    });
    store.importWorkflow({ name: "manga", description: "manga", workflow: workflow() });
    expect(() =>
      store.importWorkflow({
        name: "manga",
        description: "manga",
        documentation: "a".repeat(MAX_COMFY_DOCUMENTATION_CHARS + 1),
        workflow: workflow(),
      }),
    ).toThrow(/8001 caractères/);
    expect(() => store.updateMetadata("manga", { documentation: "a".repeat(8_001) })).toThrow(/limite est de 8000/);
    // Un contenu non textuel est refusé aussi.
    expect(() => store.updateMetadata("manga", { documentation: 42 })).toThrow(/texte/);
    // Le workflow, lui, est INTACT et sans consignes.
    expect(store.get("manga")?.documentation).toBe("");
    expect(store.size).toBe(1);
  });

  it("TRONQUE au chargement une valeur trop longue d'un fichier retouché (et le journalise)", () => {
    const dir = tempDir("yuki-comfy-doc-reload-");
    const path = join(dir, "w.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: COMFY_WORKFLOWS_SCHEMA_VERSION,
        workflows: [
          {
            name: "manga",
            description: "manga",
            documentation: "b".repeat(MAX_COMFY_DOCUMENTATION_CHARS + 50),
            isDefault: false,
            addedAt: new Date(0).toISOString(),
            workflow: workflow(),
          },
        ],
      }),
      "utf8",
    );
    const warnings: string[] = [];
    const store = new ComfyWorkflowStore({
      path,
      logger: { info: () => {}, warn: (event) => warnings.push(event), error: () => {} },
    });
    // L'entrée reste UTILISABLE : seule la documentation est coupée, à la borne.
    expect(store.size).toBe(1);
    expect(store.get("manga")?.documentation.length).toBe(MAX_COMFY_DOCUMENTATION_CHARS);
    expect(warnings).toContain("comfy.workflow.documentation_truncated");
  });

  it("la borne vaut 8 000 : 7 500 caractères sont ACCEPTÉS, 8 100 sont REFUSÉS en disant 8000", () => {
    expect(MAX_COMFY_DOCUMENTATION_CHARS).toBe(8_000);
    const store = new ComfyWorkflowStore({
      path: join(tempDir("yuki-comfy-doc-8k-"), "w.json"),
    });
    store.importWorkflow({ name: "manga", description: "manga", workflow: workflow() });
    const accepted = store.updateMetadata("manga", { documentation: "a".repeat(7_500) });
    expect(accepted?.documentation.length).toBe(7_500);
    expect(() => store.updateMetadata("manga", { documentation: "a".repeat(8_100) })).toThrow(
      /8100 caractères[\s\S]*limite est de 8000/,
    );
    // Le contenu accepté reste INTACT (un refus n'écrit rien à moitié).
    expect(store.get("manga")?.documentation.length).toBe(7_500);
  });
});

describe("édition des métadonnées d'un workflow (description + consignes)", () => {
  function storeWithManga(): ComfyWorkflowStore {
    const store = new ComfyWorkflowStore({
      path: join(tempDir("yuki-comfy-meta-"), "w.json"),
    });
    store.importWorkflow({
      name: "manga",
      description: "Manga / anime",
      documentation: "Consignes d'origine",
      workflow: workflow(),
    });
    return store;
  }

  it("enregistre la DESCRIPTION COURTE (elle sert au choix par proximité) et se relit", () => {
    const store = storeWithManga();
    const summary = store.updateMetadata("manga", {
      description: "  Manga / anime — traits marqués,  trames  ",
    });
    // Normalisée (espaces compactés) comme à l'import.
    expect(summary?.description).toBe("Manga / anime — traits marqués, trames");
    // ⚠️ `candidates()` PORTE la description (c'est elle qui sert au choix).
    expect(store.candidates()[0]?.description).toBe("Manga / anime — traits marqués, trames");
    // Les consignes ne sont pas touchées par une édition de description seule.
    expect(store.get("manga")?.documentation).toBe("Consignes d'origine");
    // Le graphe non plus.
    expect(store.get("manga")?.workflow["6"]).toBeDefined();
  });

  it("édite description ET consignes en UNE écriture cohérente", () => {
    const store = storeWithManga();
    const summary = store.updateMetadata("manga", {
      description: "Infographie",
      documentation: "Nouvelle consigne",
    });
    expect(summary?.description).toBe("Infographie");
    expect(summary?.documentation).toBe("Nouvelle consigne");
  });

  it("une valeur REFUSÉE n'écrit RIEN (pas de description à moitié enregistrée)", () => {
    const store = storeWithManga();
    expect(() =>
      store.updateMetadata("manga", {
        description: "Description valide",
        documentation: "a".repeat(MAX_COMFY_DOCUMENTATION_CHARS + 100),
      }),
    ).toThrow(/8100 caractères/);
    // Ni l'un ni l'autre n'a bougé.
    expect(store.get("manga")?.description).toBe("Manga / anime");
    expect(store.get("manga")?.documentation).toBe("Consignes d'origine");
    // Une description VIDE est refusée de la même façon (elle est obligatoire).
    expect(() => store.updateMetadata("manga", { description: "   " })).toThrow(/OBLIGATOIRE/);
    expect(store.get("manga")?.description).toBe("Manga / anime");
  });

  it("ne trouve pas un workflow inconnu et ne change JAMAIS le nom (le nom est la clé)", () => {
    const store = storeWithManga();
    expect(store.updateMetadata("inconnu", { description: "x" })).toBeNull();
    // ⚠️ Le port n'expose AUCUN renommage : la clé reste le nom d'usage (elle
    // est utilisée par `PUT /workflows/<nom>`, `consulter_workflow` et
    // `generer_image`).
    store.updateMetadata("manga", { description: "Manga renommé ?" });
    expect(store.list().map((entry) => entry.name)).toEqual(["manga"]);
  });
});

describe("store des images générées", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("enregistre l'image sous un identifiant ALÉATOIRE et la relit", () => {
    const store = new GeneratedImagesStore({ dir: join(tempDir("yuki-comfy-img-"), "images") });
    const record = store.save({
      data: PNG,
      mimeType: "image/png",
      promptId: "prompt-1",
      // Les dimensions viennent de l'en-tête IHDR (le store ne LES DEVINE pas).
      ...(pngDimensions(PNG) ?? {}),
    });
    expect(record).not.toBeNull();
    if (!record) return;
    // Identifiant de 32 hexadécimaux : le nom renvoyé par ComfyUI n'est JAMAIS réutilisé.
    expect(record.id).toMatch(/^[a-f0-9]{32}$/);
    expect(record.imageSrc).toBe(`/images/${record.id}.png`);
    expect(record.imageSrc.startsWith("/")).toBe(true); // same-origin
    expect(record.bytes).toBe(PNG.byteLength);
    expect(pngDimensions(PNG)).toEqual({ width: 1, height: 1 });
    expect(record.width).toBe(1);
    expect(record.height).toBe(1);

    const read = store.read(record.id, "png");
    expect(read?.mimeType).toBe("image/png");
    expect(read?.bytes.equals(PNG)).toBe(true);
  });

  it("refuse une extension ou un identifiant hors allowlist (aucune traversée)", () => {
    const store = new GeneratedImagesStore({ dir: join(tempDir("yuki-comfy-img-bad-"), "images") });
    const record = store.save({ data: PNG, mimeType: "image/png", promptId: "p" });
    if (!record) throw new Error("enregistrement attendu");
    expect(store.read(record.id, "html")).toBeNull();
    expect(store.read("../../etc/passwd", "png")).toBeNull();
    expect(store.read(record.id, "svg")).toBeNull();
    expect(store.read("0".repeat(32), "png")).toBeNull();
  });

  it("refuse une image au-delà du plafond et n'écrit rien", () => {
    const dir = join(tempDir("yuki-comfy-img-max-"), "images");
    const store = new GeneratedImagesStore({ dir });
    const tooBig = Buffer.alloc(MAX_GENERATED_IMAGE_BYTES + 1, 0x41);
    expect(store.save({ data: tooBig, mimeType: "image/png", promptId: "p" })).toBeNull();
    store.ensureLayout();
    expect(store.read("a".repeat(32), "png")).toBeNull();
  });

  it("ne devine PAS les dimensions d'un format non PNG", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(pngDimensions(jpeg)).toBeUndefined();
    expect(pngDimensions(Buffer.alloc(4))).toBeUndefined();
  });
});
