/**
 * API des VERSIONS de la consolidation hebdomadaire (lot 29, amendement ②).
 *
 * Ce qui est verrouillé :
 *  - `GET /api/memory` expose l'état de la consolidation et les versions ;
 *  - `GET /api/memory/versions` liste, `GET …/<nom>/download` renvoie le JSONL ;
 *  - `POST …/<nom>/restore` exige les garde-fous d'écriture et restaure ;
 *  - un nom de version hors format (`../`) est REFUSÉ (400), jamais résolu.
 *
 * ⚠️ Ces tests échouent sur le code d'origine : la route ne connaît que
 * `GET /api/memory` et `POST /api/memory/reset` (`git show HEAD:src/gateway/routes/memory.ts`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleMemoryRequest,
  isMemoryPath,
  type MemoryApiDeps,
} from "../../src/gateway/routes/memory.js";
import {
  ConsolidationArchiveStore,
  ConsolidationHebdo,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  MEMORY_FILE_HEADER,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

interface Harness {
  deps: MemoryApiDeps;
  store: MemoryStore;
  hebdo: ConsolidationHebdo;
  cheminMemoire: string;
  avant: string;
  nomVersion: string;
  dir: string;
}

function ecrireMemoire(chemin: string, nombre: number): void {
  const lignes = [MEMORY_FILE_HEADER];
  for (let index = 0; index < nombre; index += 1) {
    lignes.push(
      JSON.stringify({
        v: 1,
        t: "add",
        id: `mem-${String(index).padStart(2, "0")}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        text: `Souvenir ${index} unique${index}.`,
        source: "test",
        cat: "fait",
      }),
    );
  }
  writeFileSync(chemin, `${lignes.join("\n")}\n`, "utf8");
}

/** Une passe RÉELLE (supprime mem-11) archive une version, puis on interroge l'API. */
async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-versions-api-"));
  tempDirs.push(dir);
  const quiet = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  const cheminMemoire = join(dir, "memory.jsonl");
  ecrireMemoire(cheminMemoire, 12);
  const avant = readFileSync(cheminMemoire, "utf8");
  const store = MemoryStore.open({ path: cheminMemoire, logger: quiet });
  const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger: quiet });
  index.open();
  index.rebuild(store.entries);
  const admin = new MemoryService({
    store,
    index,
    logger: quiet,
    enabled: () => true,
    bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 500 }),
  });
  const hebdo = new ConsolidationHebdo({
    store,
    index,
    logger: quiet,
    archive: new ConsolidationArchiveStore({
      dir: join(dir, "memory-archive", "consolidation"),
      logger: quiet,
    }),
    statePath: join(dir, "memory-consolidation.json"),
    settings: () => ({
      enabled: true,
      cron: "0 3 * * 0",
      fuseau: "Europe/Paris",
      budgetTokens: 200_000,
      retention: 12,
    }),
    extractor: () => async (prompt: string) => {
      const lot = Number(/"lot":(\d+)/.exec(prompt)?.[1] ?? 1);
      const ids = [...prompt.matchAll(/^- (mem-[a-z0-9-]+)/gm)].map((match) => String(match[1]));
      return JSON.stringify({
        version: 1,
        lot,
        operations: ids.map((id) =>
          id === "mem-11" ? { op: "supprimer", id, raison: "transitoire" } : { op: "garder", id },
        ),
      });
    },
    contexteModele: () => 131_072,
  });
  const rapport = await hebdo.executerPasse();
  expect(rapport.applique).toBe(true);
  const logger = createLogger({ level: "info", sink: () => undefined, secretValues: [] });
  return {
    deps: { admin, consolidation: hebdo, logger },
    store,
    hebdo,
    cheminMemoire,
    avant,
    nomVersion: String(rapport.version),
    dir,
  };
}

describe("API versions — chemins et liste", () => {
  it("reconnaît les chemins des versions", () => {
    expect(isMemoryPath("/api/memory/versions")).toBe(true);
    expect(isMemoryPath("/api/memory/versions/2026-11-08_0300/download")).toBe(true);
    expect(isMemoryPath("/api/personality")).toBe(false);
  });

  it("GET /api/memory expose l'état de la consolidation et ses versions", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "GET",
      path: "/api/memory",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(200);
    const body = reponse.body as {
      consolidation: { versions: unknown[]; fuseau: string; cron: string };
    };
    expect(body.consolidation.fuseau).toBe("Europe/Paris");
    expect(body.consolidation.cron).toBe("0 3 * * 0");
    expect(body.consolidation.versions).toHaveLength(1);
  });

  it("GET /api/memory/versions liste les versions (aucune écriture)", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "GET",
      path: "/api/memory/versions",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(200);
    const body = reponse.body as { versions: Array<{ nom: string }> };
    expect(body.versions.map((version) => version.nom)).toContain(h.nomVersion);
  });
});

describe("API versions — téléchargement", () => {
  it("renvoie le JSONL d'AVANT la passe, en pièce jointe", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "GET",
      path: `/api/memory/versions/${h.nomVersion}/download`,
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(200);
    expect(typeof reponse.body).toBe("string");
    expect(reponse.body).toBe(h.avant);
    expect(reponse.headers?.["content-disposition"]).toContain(h.nomVersion);
    expect(reponse.headers?.["content-type"]).toContain("ndjson");
  });

  it("version inexistante → 404, nom hors format → 400 (traversée refusée)", async () => {
    const h = await harness();
    const inconnue = handleMemoryRequest({
      method: "GET",
      path: "/api/memory/versions/2020-01-05_0300/download",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(inconnue.status).toBe(404);

    const traversee = handleMemoryRequest({
      method: "GET",
      path: `/api/memory/versions/${encodeURIComponent("../secret")}/download`,
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(traversee.status).toBe(400);

    const forme = handleMemoryRequest({
      method: "GET",
      path: "/api/memory/versions/2026-13-99_9999/download",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(forme.status).toBe(400);
  });
});

describe("API versions — restauration", () => {
  it("exige les garde-fous d'écriture (403 sans X-Yuki-Config)", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "POST",
      path: `/api/memory/versions/${h.nomVersion}/restore`,
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(403);
    // Rien n'a bougé : mem-11 est toujours supprimé.
    expect(h.store.has("mem-11")).toBe(false);
  });

  it("restaure la version et reconstruit l'index", async () => {
    const h = await harness();
    expect(h.store.has("mem-11")).toBe(false);
    const reponse = handleMemoryRequest({
      method: "POST",
      path: `/api/memory/versions/${h.nomVersion}/restore`,
      headers: WRITE_HEADERS,
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(200);
    const body = reponse.body as { restaure: boolean; entrees: number; message: string };
    expect(body.restaure).toBe(true);
    expect(body.entrees).toBe(12);
    expect(body.message).toContain("index");
    expect(h.store.has("mem-11")).toBe(true);
    expect(readFileSync(h.cheminMemoire, "utf8")).toBe(h.avant);
  });

  it("une version invalide est refusée AVANT tout accès disque", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "POST",
      path: `/api/memory/versions/${encodeURIComponent("../../etc/passwd")}/restore`,
      headers: WRITE_HEADERS,
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(400);
    expect(h.store.has("mem-11")).toBe(false);
  });

  it("méthode inattendue → 405", async () => {
    const h = await harness();
    const reponse = handleMemoryRequest({
      method: "DELETE",
      path: `/api/memory/versions/${h.nomVersion}/restore`,
      headers: WRITE_HEADERS,
      body: "",
      deps: h.deps,
    });
    expect(reponse.status).toBe(405);
  });
});
