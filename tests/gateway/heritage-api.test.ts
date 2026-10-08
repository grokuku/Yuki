/**
 * API `/api/self/heritage` — administration de l'archive « vie antérieure ».
 *
 * Teste directement le handler (sans socket) : en-têtes forgés à la main, comme
 * `/api/config`. Prouve : lister / lire / créer / modifier / supprimer (mise de
 * côté), garde-fous d'écriture, étiquette + provenance réappliquées, journal sans
 * contenu, et l'isolement ABSOLU vis-à-vis de la mémoire courante.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleHeritageRequest, isHeritagePath, type HeritageApiDeps } from "../../src/gateway/routes/heritage.js";
import {
  HERITAGE_LABEL,
  HeritageAdminService,
  HeritageStore,
  MemoryStore,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };
const SECRET = "ENTREE_A_NE_JAMAIS_JOURNALISER";

interface Harness {
  deps: HeritageApiDeps;
  admin: HeritageAdminService;
  store: HeritageStore;
  lines: string[];
  dir: string;
  memoryPath: string;
}

function harness(): Harness {
  const base = mkdtempSync(join(tmpdir(), "yuki-heritage-api-"));
  tempDirs.push(base);
  const quiet = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  const store = new HeritageStore({ dir: join(base, "memory-heritage"), logger: quiet });
  store.ensureLayout();
  const admin = new HeritageAdminService(store, { logger: quiet, secretValues: [] });
  const lines: string[] = [];
  const logger = createLogger({ level: "info", sink: (line) => lines.push(line), secretValues: [] });
  return {
    deps: { admin, logger },
    admin,
    store,
    lines,
    dir: store.dirPath,
    memoryPath: join(base, "memory.jsonl"),
  };
}

function req(
  h: Harness,
  method: string,
  path: string,
  body = "",
  headers: Record<string, string> = {},
) {
  return handleHeritageRequest({ method, path, headers, body, deps: h.deps });
}

describe("API heritage — chemins", () => {
  it("reconnaît les chemins de l'API", () => {
    expect(isHeritagePath("/api/self/heritage")).toBe(true);
    expect(isHeritagePath("/api/self/heritage/entry/entries/a.json")).toBe(true);
    expect(isHeritagePath("/api/memory")).toBe(false);
    expect(isHeritagePath("/api/self/personality")).toBe(false);
  });
});

describe("API heritage — lecture", () => {
  it("GET renvoie une archive VIDE avec un message honnête", () => {
    const h = harness();
    const response = req(h, "GET", "/api/self/heritage");
    expect(response.status).toBe(200);
    const body = response.body as { info: { present: boolean; entries: number; dir: string }; entries: unknown[] };
    expect(body.info.entries).toBe(0);
    // Le dossier est initialisé (manifeste présent) mais il n'y a AUCUNE entrée.
    expect(body.info.present).toBe(true);
    expect(body.info.dir).toBe(h.dir);
    expect(body.entries).toEqual([]);
  });

  it("GET /entry/<cle> renvoie le contenu d'UNE entrée", () => {
    const h = harness();
    const created = req(
      h,
      "POST",
      "/api/self/heritage/entry",
      JSON.stringify({ titre: "Identité", categorie: "identite", texte: "SOUL." }),
      WRITE_HEADERS,
    );
    const cle = (created.body as { entry: { cle: string } }).entry.cle;
    const response = req(h, "GET", `/api/self/heritage/entry/${encodeURIComponent(cle)}`);
    expect(response.status).toBe(200);
    expect((response.body as { entry: { texte: string } }).entry.texte).toBe("SOUL.");
  });

  it("entrée inconnue ⇒ 404", () => {
    const h = harness();
    expect(req(h, "GET", "/api/self/heritage/entry/entries/x.json").status).toBe(404);
  });
});

describe("API heritage — écriture (garde-fous + réapplication)", () => {
  it("CRÉE une entrée : 201, étiquette et provenance réappliquées", () => {
    const h = harness();
    const response = req(
      h,
      "POST",
      "/api/self/heritage/entry",
      JSON.stringify({ titre: "Rêves", categorie: "reves", texte: "Voyager." }),
      WRITE_HEADERS,
    );
    expect(response.status).toBe(201);
    const entry = (response.body as { entry: { label: string; provenance: unknown; cle: string } }).entry;
    expect(entry.label).toBe(HERITAGE_LABEL);
    expect(entry.provenance).toMatchObject({ machine: "Yuki-old", ere: "OpenClaw" });
  });

  it("MODIFIE une entrée : 200, même clé, étiquette conservée", () => {
    const h = harness();
    const created = req(h, "POST", "/api/self/heritage/entry", JSON.stringify({ titre: "A", texte: "v1" }), WRITE_HEADERS);
    const cle = (created.body as { entry: { cle: string } }).entry.cle;
    const updated = req(
      h,
      "PUT",
      `/api/self/heritage/entry/${encodeURIComponent(cle)}`,
      JSON.stringify({ titre: "A", categorie: "profil", texte: "v2" }),
      WRITE_HEADERS,
    );
    expect(updated.status).toBe(200);
    const entry = (updated.body as { entry: { cle: string; label: string; texte: string } }).entry;
    expect(entry.cle).toBe(cle);
    expect(entry.label).toBe(HERITAGE_LABEL);
    expect(entry.texte).toBe("v2");
  });

  it("SUPPRIME (met de côté) : 200 avec destination récupérable", () => {
    const h = harness();
    const created = req(h, "POST", "/api/self/heritage/entry", JSON.stringify({ titre: "À retirer", texte: "x" }), WRITE_HEADERS);
    const cle = (created.body as { entry: { cle: string } }).entry.cle;
    const deleted = req(h, "DELETE", `/api/self/heritage/entry/${encodeURIComponent(cle)}`, "", WRITE_HEADERS);
    expect(deleted.status).toBe(200);
    const body = deleted.body as { moved: boolean; deletedPath: string; message: string };
    expect(body.moved).toBe(true);
    expect(body.deletedPath).toContain("deleted");
    expect(body.message).toMatch(/récupérable/i);
    // L'archive active est vide.
    expect((req(h, "GET", "/api/self/heritage").body as { info: { entries: number } }).info.entries).toBe(0);
  });

  it("POST/PUT/DELETE sans en-tête X-Yuki-Config ⇒ 403", () => {
    const h = harness();
    for (const [method, path] of [
      ["POST", "/api/self/heritage/entry"],
      ["PUT", "/api/self/heritage/entry/entries/a.json"],
      ["DELETE", "/api/self/heritage/entry/entries/a.json"],
    ] as const) {
      const response = req(h, method, path, JSON.stringify({ titre: "x", texte: "y" }));
      expect(response.status, method).toBe(403);
      expect((response.body as { code: string }).code).toBe("missing_config_header");
    }
  });

  it("Origin étranger ⇒ 403 (bad_origin)", () => {
    const h = harness();
    const response = req(
      h,
      "POST",
      "/api/self/heritage/entry",
      JSON.stringify({ titre: "x", texte: "y" }),
      { ...WRITE_HEADERS, origin: "http://evil.test", host: "127.0.0.1:8080" },
    );
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("bad_origin");
  });

  it("corps invalide ou titre manquant ⇒ 400 (jamais d'écriture)", () => {
    const h = harness();
    const bad = req(h, "POST", "/api/self/heritage/entry", "{pas du json", WRITE_HEADERS);
    expect(bad.status).toBe(400);
    const noTitle = req(h, "POST", "/api/self/heritage/entry", JSON.stringify({ texte: "y" }), WRITE_HEADERS);
    expect(noTitle.status).toBe(400);
    expect(h.admin.list()).toHaveLength(0);
  });
});

describe("API heritage — méthode/chemin inconnus", () => {
  it("DELETE sur la liste ⇒ 405 ; chemin inconnu ⇒ 404", () => {
    const h = harness();
    expect(req(h, "DELETE", "/api/self/heritage", "", WRITE_HEADERS).status).toBe(405);
    expect(req(h, "GET", "/api/self/heritage/inconnu").status).toBe(404);
  });
});

describe("API heritage — journal & isolement", () => {
  it("journalise les écritures SANS contenu et sans secret", () => {
    const h = harness();
    req(h, "POST", "/api/self/heritage/entry", JSON.stringify({ titre: "S", texte: SECRET }), WRITE_HEADERS);
    const journal = readFileSync(join(h.dir, "heritage-journal.jsonl"), "utf8");
    expect(journal).toContain("create");
    expect(journal).not.toContain(SECRET);
    // Le logger d'audit ne recopie pas non plus le contenu.
    expect(h.lines.join("\n")).not.toContain(SECRET);
    expect(h.lines.some((line) => line.includes("heritage.created"))).toBe(true);
  });

  it("une entrée MALFORMÉE est ignorée, l'API reste honnête (pas de crash)", () => {
    const h = harness();
    mkdirSync(join(h.dir, "entries", "casse.json"), { recursive: true });
    writeFileSync(join(h.dir, "entries", "ok.md"), "Texte lisible", "utf8");
    const response = req(h, "GET", "/api/self/heritage");
    expect(response.status).toBe(200);
    const body = response.body as { info: { entries: number }; entries: Array<{ cle: string }> };
    expect(body.info.entries).toBe(1);
    expect(body.entries[0]?.cle).toBe("entries/ok.md");
  });

  it("RÈGLE CARDINALE : l'archive n'est JAMAIS écrite dans memory.jsonl", () => {
    const h = harness();
    const memoryStore = MemoryStore.open({ path: h.memoryPath, logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }) });
    memoryStore.add({ text: "souvenir courant", source: "s", cat: "fait" });
    const before = readFileSync(h.memoryPath, "utf8");

    const created = req(h, "POST", "/api/self/heritage/entry", JSON.stringify({ titre: "Vie antérieure", texte: SECRET }), WRITE_HEADERS);
    const cle = (created.body as { entry: { cle: string } }).entry.cle;
    req(h, "PUT", `/api/self/heritage/entry/${encodeURIComponent(cle)}`, JSON.stringify({ titre: "Vie antérieure", texte: "modifié" }), WRITE_HEADERS);
    req(h, "DELETE", `/api/self/heritage/entry/${encodeURIComponent(cle)}`, "", WRITE_HEADERS);

    const after = readFileSync(h.memoryPath, "utf8");
    expect(after).toBe(before);
    expect(after).not.toContain(SECRET);
    expect(after).not.toContain("Vie antérieure");
    expect(after).not.toContain("modifié");
  });
});
