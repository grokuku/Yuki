/**
 * Routes des IMAGES GÉNÉRÉES (ComfyUI) : import des workflows, test de connexion
 * et service SAME-ORIGIN de l'image.
 *
 * Ce que ce fichier PROUVE :
 *  - un workflow invalide est REFUSÉ à l'import, avec les étiquettes trouvées et
 *    manquantes (PIÈGE ⑦), et RIEN n'est écrit ;
 *  - un workflow valide est importé et listé SANS son graphe ;
 *  - la CLÉ du serveur n'est JAMAIS renvoyée par l'API (PIÈGE ④) ;
 *  - l'image est servie en `image/png` sur un chemin SAME-ORIGIN, avec refus de
 *    toute traversée de répertoire (PIÈGE ⑥ : aucune CSP élargie) ;
 *  - une écriture sans l'en-tête `x-yuki-config` est refusée (même garde-fou que
 *    `/api/config`).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ComfyWorkflowStore,
  GeneratedImagesStore,
  MAX_COMFY_DOCUMENTATION_CHARS,
  type ComfySystemStats,
} from "../../src/comfy/index.js";
import {
  IMAGES_API_PREFIX,
  handleImagesApiRequest,
  handleImagesServeRequest,
  isImagesApiPath,
  isImagesServePath,
  type ComfyServerOverride,
} from "../../src/gateway/routes/images.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const WRITE_HEADERS = { "x-yuki-config": "1" };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface Harness {
  workflows: ComfyWorkflowStore;
  images: GeneratedImagesStore;
  overrides: ComfyServerOverride[];
  call(input: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
  stats: { value: ComfySystemStats | null; error: Error | null };
}

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

function harness(): Harness {
  const dir = tempDir("yuki-images-api-");
  const workflows = new ComfyWorkflowStore({ path: join(dir, "workflows.json") });
  const images = new GeneratedImagesStore({ dir: join(dir, "images") });
  const overrides: ComfyServerOverride[] = [];
  const stats: { value: ComfySystemStats | null; error: Error | null } = {
    value: { version: "0.3.40", devices: ["cuda:0"] },
    error: null,
  };
  const deps = {
    workflows,
    images,
    clientFor: (override: ComfyServerOverride) => {
      overrides.push(override);
      return {
        async systemStats() {
          if (stats.error) throw stats.error;
          return stats.value as ComfySystemStats;
        },
      };
    },
  };
  return {
    workflows,
    images,
    overrides,
    stats,
    async call(input) {
      const response = await handleImagesApiRequest({
        method: input.method,
        path: input.path,
        headers: input.headers ?? WRITE_HEADERS,
        body:
          input.body === undefined
            ? ""
            : typeof input.body === "string"
              ? input.body
              : JSON.stringify(input.body),
        deps,
      });
      return { status: response.status, body: response.body };
    },
  };
}

describe("import d'un workflow", () => {
  it("accepte un workflow au FORMAT API et le liste SANS son graphe", async () => {
    const { call, workflows } = harness();
    const created = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      body: {
        name: "manga",
        description: "Manga / anime — traits marqués, trames",
        workflow: workflow(),
        isDefault: true,
      },
    });
    expect(created.status).toBe(200);
    const payload = created.body as {
      ok: boolean;
      workflow: { name: string; isDefault: boolean; found: string[]; missing: string[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.workflow.name).toBe("manga");
    expect(payload.workflow.isDefault).toBe(true);
    expect(payload.workflow.found).toEqual(["YUKI_PROMPT"]);

    const listed = await call({ method: "GET", path: `${IMAGES_API_PREFIX}/workflows` });
    expect(listed.status).toBe(200);
    const list = (listed.body as { workflows: unknown[] }).workflows;
    expect(list).toHaveLength(1);
    // ⚠️ Le graphe ne fuit JAMAIS par l'API.
    expect(JSON.stringify(listed.body)).not.toContain("class_type");
    expect(workflows.size).toBe(1);
  });

  it("REFUSE un workflow sans YUKI_PROMPT en montrant trouvées et manquantes", async () => {
    const { call, workflows } = harness();
    const refused = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      body: {
        name: "casse",
        description: "sans étiquette obligatoire",
        workflow: {
          3: { class_type: "KSampler", inputs: { seed: 1 }, _meta: { title: "YUKI_SEED" } },
          9: { class_type: "SaveImage", inputs: {} },
        },
      },
    });
    expect(refused.status).toBe(400);
    const payload = refused.body as {
      code: string;
      message: string;
      found: string[];
      missing: string[];
    };
    expect(payload.code).toBe("missing_required_label");
    expect(payload.found).toEqual(["YUKI_SEED"]);
    expect(payload.missing).toContain("YUKI_PROMPT");
    expect(payload.message).toContain("YUKI_PROMPT");
    // Rien n'a été écrit.
    expect(workflows.size).toBe(0);
  });

  it("REFUSE un export au format INTERFACE en expliquant l'export API", async () => {
    const { call } = harness();
    const refused = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      body: { name: "ui", description: "export éditeur", workflow: { nodes: [], links: [] } },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { code: string }).code).toBe("unsupported_format");
    expect((refused.body as { message: string }).message).toContain("Save (API Format)");
  });

  it("REFUSE un corps JSON invalide", async () => {
    const { call } = harness();
    const refused = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      body: "{ pas du json",
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toBe("invalid_json");
  });

  it("REFUSE une écriture sans l'en-tête de configuration", async () => {
    const { call, workflows } = harness();
    const refused = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      headers: {},
      body: { name: "manga", description: "x", workflow: workflow() },
    });
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe("missing_config_header");
    expect(workflows.size).toBe(0);
  });
});

describe("suppression et « par défaut »", () => {
  it("marque un workflow par défaut puis le supprime", async () => {
    const { call, workflows } = harness();
    for (const name of ["manga", "realiste"]) {
      await call({
        method: "POST",
        path: `${IMAGES_API_PREFIX}/workflows`,
        body: { name, description: name, workflow: workflow() },
      });
    }
    const setDefault = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows/manga/defaut`,
    });
    expect(setDefault.status).toBe(200);
    expect(workflows.list().filter((entry) => entry.isDefault).map((entry) => entry.name)).toEqual([
      "manga",
    ]);

    const removed = await call({ method: "DELETE", path: `${IMAGES_API_PREFIX}/workflows/manga` });
    expect(removed.status).toBe(200);
    expect(workflows.size).toBe(1);

    const missing = await call({ method: "DELETE", path: `${IMAGES_API_PREFIX}/workflows/manga` });
    expect(missing.status).toBe(404);
    expect((missing.body as { message: string }).message).toContain("manga");
  });
});

describe("consignes d'écriture (documentation) d'un workflow", () => {
  const DOC = "Commence par le sujet et le cadrage, puis le décor et la lumière.";

  async function withManga() {
    const ctx = harness();
    await ctx.call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/workflows`,
      body: { name: "manga", description: "Manga / anime", workflow: workflow() },
    });
    return ctx;
  }

  it("s'enregistre par PUT, se relit dans la liste, et ne touche pas au graphe", async () => {
    const { call, workflows } = await withManga();
    const saved = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      body: { documentation: DOC },
    });
    expect(saved.status).toBe(200);
    expect((saved.body as { workflow: { documentation: string } }).workflow.documentation).toBe(DOC);
    expect(workflows.get("manga")?.documentation).toBe(DOC);
    // Le graphe est INTACT (seule la documentation a changé).
    expect(workflows.get("manga")?.workflow["6"]).toBeDefined();

    const listed = await call({ method: "GET", path: `${IMAGES_API_PREFIX}/workflows` });
    expect(JSON.stringify(listed.body)).toContain(DOC);
    // ⚠️ …mais le graphe ne fuit toujours pas par l'API.
    expect(JSON.stringify(listed.body)).not.toContain("class_type");

    // Effacer est explicite (chaîne vide).
    const cleared = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      body: { documentation: "" },
    });
    expect(cleared.status).toBe(200);
    expect(workflows.get("manga")?.documentation).toBe("");
  });

  it("REFUSE un texte au-delà de la borne en disant la longueur réelle", async () => {
    const { call, workflows } = await withManga();
    const tooLong = "a".repeat(MAX_COMFY_DOCUMENTATION_CHARS + 100);
    const refused = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      body: { documentation: tooLong },
    });
    expect(refused.status).toBe(400);
    const payload = refused.body as { code: string; message: string };
    expect(payload.code).toBe("invalid_documentation");
    expect(payload.message).toContain("8100 caractères");
    expect(payload.message).toContain("8000");
    // Rien n'a été écrit (aucune troncature silencieuse).
    expect(workflows.get("manga")?.documentation).toBe("");
  });

  it("la borne vaut 8 000 : 7 500 caractères sont ACCEPTÉS par l'API", async () => {
    const { call, workflows } = await withManga();
    const long = "b".repeat(7_500);
    const saved = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      body: { documentation: long },
    });
    expect(saved.status).toBe(200);
    expect(workflows.get("manga")?.documentation.length).toBe(7_500);
  });

  it("exige un corps avec `documentation` et des garde-fous d'écriture", async () => {
    const { call } = await withManga();
    const noField = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      body: {},
    });
    expect(noField.status).toBe(400);
    expect((noField.body as { error: string }).error).toBe("invalid_body");

    const noGuard = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/manga`,
      headers: {},
      body: { documentation: DOC },
    });
    expect(noGuard.status).toBe(403);
  });

  it("répond 404 pour un workflow inconnu", async () => {
    const { call } = harness();
    const missing = await call({
      method: "PUT",
      path: `${IMAGES_API_PREFIX}/workflows/inconnu`,
      body: { documentation: DOC },
    });
    expect(missing.status).toBe(404);
  });
});

describe("test de connexion", () => {
  it("teste les valeurs SAISIES (non enregistrées) et rapporte la version", async () => {
    const { call, overrides } = harness();
    const result = await call({
      method: "POST",
      path: `${IMAGES_API_PREFIX}/test`,
      body: { baseUrl: "http://10.10.0.5:8188", apiKey: "clef-tapée" },
    });
    expect(result.status).toBe(200);
    expect(overrides).toEqual([{ baseUrl: "http://10.10.0.5:8188", apiKey: "clef-tapée" }]);
    const payload = result.body as { ok: boolean; message: string; version: string };
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain("joignable");
    expect(payload.message).toContain("0.3.40");
    expect(payload.version).toBe("0.3.40");
    // ⚠️ La clé n'est jamais réaffichée dans la réponse (PIÈGE ④).
    expect(JSON.stringify(result.body)).not.toContain("clef-tapée");
  });

  it("rapporte l'échec RÉEL sans inventer de cause", async () => {
    const { call, stats } = harness();
    const { ComfyError } = await import("../../src/comfy/index.js");
    stats.error = new ComfyError(
      "unreachable",
      "Serveur ComfyUI INJOIGNABLE à l'adresse http://x : connexion refusée.",
      { causeCode: "ECONNREFUSED" },
    );
    const result = await call({ method: "POST", path: `${IMAGES_API_PREFIX}/test` });
    expect(result.status).toBe(200);
    const payload = result.body as { ok: boolean; code: string; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("unreachable");
    expect(payload.message).toContain("INJOIGNABLE");
  });
});

describe("service SAME-ORIGIN de l'image (PIÈGE ⑥)", () => {
  it("sert l'image en `image/png` sur un chemin relatif à la même origine", () => {
    const { images } = harness();
    const record = images.save({
      data: PNG,
      mimeType: "image/png",
      promptId: "prompt-1",
      width: 1,
      height: 1,
    });
    if (!record) throw new Error("enregistrement attendu");
    // Le chemin servi est RELATIF : aucune origine externe ⇒ CSP inchangée.
    expect(record.imageSrc.startsWith("/images/")).toBe(true);

    const response = handleImagesServeRequest({
      method: "GET",
      path: record.imageSrc,
      deps: { workflows: new ComfyWorkflowStore({ path: join(tempDir("yuki-img-serve-"), "w.json") }), images, clientFor: () => ({ systemStats: async () => ({ devices: [] }) }) },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(response.body as Buffer).equals(PNG)).toBe(true);
  });

  it("sert l'image CONSERVÉE puis répond 404 une fois la rétention dépassée", () => {
    // ⚠️ Horloge INJECTABLE : on n'attend pas 30 jours. C'est la MÊME règle de
    // rétention que les pièces jointes (`retentionDays`).
    let now = Date.UTC(2026, 0, 1);
    const images = new GeneratedImagesStore({
      dir: join(tempDir("yuki-img-retention-"), "images"),
      now: () => now,
      retentionDays: () => 30,
    });
    const deps = {
      workflows: new ComfyWorkflowStore({
        path: join(tempDir("yuki-img-retention-w-"), "w.json"),
      }),
      images,
      clientFor: () => ({ systemStats: async () => ({ devices: [] }) }),
    };
    const record = images.save({ data: PNG, mimeType: "image/png", promptId: "p" });
    if (!record) throw new Error("enregistrement attendu");
    expect(handleImagesServeRequest({ method: "GET", path: record.imageSrc, deps }).status).toBe(200);

    now += 30 * 86_400_000;
    // Expirée : la route répond 404 ET le fichier a été supprimé (PIÈGE ④).
    expect(handleImagesServeRequest({ method: "GET", path: record.imageSrc, deps }).status).toBe(404);
    expect(existsSync(record.file)).toBe(false);
  });

  it("refuse une traversée de répertoire et une méthode d'écriture", () => {
    const { images } = harness();
    const deps = {
      workflows: new ComfyWorkflowStore({ path: join(tempDir("yuki-img-serve2-"), "w.json") }),
      images,
      clientFor: () => ({ systemStats: async () => ({ devices: [] }) }),
    };
    for (const path of [
      "/images/../../etc/passwd.png",
      "/images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html",
      "/images/sans-extension",
      "/images/00000000000000000000000000000000.png",
    ]) {
      expect(handleImagesServeRequest({ method: "GET", path, deps }).status).toBe(404);
    }
    expect(handleImagesServeRequest({ method: "POST", path: "/images/x.png", deps }).status).toBe(
      405,
    );
  });

  it("reconnaît ses préfixes, et EUX SEULS", () => {
    expect(isImagesServePath("/images/a.png")).toBe(true);
    expect(isImagesServePath("/captures/a.png")).toBe(false);
    expect(isImagesServePath("/fichiers/a.png")).toBe(false);
    expect(isImagesApiPath(`${IMAGES_API_PREFIX}/workflows`)).toBe(true);
    expect(isImagesApiPath(IMAGES_API_PREFIX)).toBe(true);
    expect(isImagesApiPath("/api/imagesx")).toBe(false);
    expect(isImagesApiPath("/api/config")).toBe(false);
  });
});
