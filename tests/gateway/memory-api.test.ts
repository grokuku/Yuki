/**
 * API `/api/memory` — garde-fous d'écriture, état, archivage récupérable.
 *
 * Teste directement le handler (sans socket) : en-têtes forgés à la main, comme
 * `/api/config`. Vérifie aussi que le journal d'audit ne contient JAMAIS de
 * contenu de souvenir.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleMemoryRequest,
  isMemoryPath,
  type MemoryApiDeps,
} from "../../src/gateway/routes/memory.js";
import {
  MEMORY_ARCHIVE_DIR_NAME,
  MemoryIndex,
  MemoryService,
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
const SECRET_MEMORY = "SOUVENIR_A_NE_JAMAIS_JOURNALISER";

interface Harness {
  deps: MemoryApiDeps;
  store: MemoryStore;
  service: MemoryService;
  lines: string[];
  dir: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-api-"));
  tempDirs.push(dir);
  const quiet = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
  const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: quiet });
  const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger: quiet });
  const service = new MemoryService({
    store,
    index,
    logger: quiet,
    enabled: () => true,
    bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 500 }),
  });
  const lines: string[] = [];
  const logger = createLogger({ level: "info", sink: (line) => lines.push(line), secretValues: [] });
  return { deps: { admin: service, logger }, store, service, lines, dir };
}

describe("API mémoire — chemins", () => {
  it("reconnaît les chemins de l'API", () => {
    expect(isMemoryPath("/api/memory")).toBe(true);
    expect(isMemoryPath("/api/memory/reset")).toBe(true);
    expect(isMemoryPath("/api/self/personality")).toBe(false);
    expect(isMemoryPath("/api/config")).toBe(false);
  });
});

describe("API mémoire — état", () => {
  it("GET renvoie le nombre d'entrées et le dossier d'archive", () => {
    const h = harness();
    const response = handleMemoryRequest({
      method: "GET",
      path: "/api/memory",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      entries: 0,
      archiveDir: join(h.dir, MEMORY_ARCHIVE_DIR_NAME),
    });
    h.service.close();
  });
});

describe("API mémoire — garde-fous d'écriture", () => {
  it("POST /reset sans en-tête X-Yuki-Config → 403", () => {
    const response = handleMemoryRequest({
      method: "POST",
      path: "/api/memory/reset",
      headers: {},
      body: "",
      deps: harness().deps,
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("missing_config_header");
  });

  it("POST /reset avec Origin étranger → 403 (bad_origin)", () => {
    const response = handleMemoryRequest({
      method: "POST",
      path: "/api/memory/reset",
      headers: { ...WRITE_HEADERS, origin: "http://evil.test", host: "127.0.0.1:8080" },
      body: "",
      deps: harness().deps,
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("bad_origin");
  });
});

describe("API mémoire — archivage", () => {
  it("mémoire VIDE ⇒ message honnête, aucune archive créée", () => {
    const h = harness();
    const response = handleMemoryRequest({
      method: "POST",
      path: "/api/memory/reset",
      headers: WRITE_HEADERS,
      body: "",
      deps: h.deps,
    });
    expect(response.status).toBe(200);
    const body = response.body as { reset: boolean; archived: boolean; message: string };
    expect(body.reset).toBe(false);
    expect(body.archived).toBe(false);
    expect(body.message).toContain("Aucune mémoire à réinitialiser");
    expect(existsSync(join(h.dir, MEMORY_ARCHIVE_DIR_NAME))).toBe(false);
    h.service.close();
  });

  it("avec des souvenirs ⇒ archivage effectif, l'état repart à zéro", () => {
    const h = harness();
    h.store.add({ text: "L'utilisateur aime les crêpes", source: "a", cat: "preference" });
    h.store.add({ text: "L'utilisateur habite à Rennes", source: "b", cat: "fait" });

    const response = handleMemoryRequest({
      method: "POST",
      path: "/api/memory/reset",
      headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "memory-reset" },
      body: "",
      deps: h.deps,
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      reset: boolean;
      archived: boolean;
      entries: number;
      bytes: number;
      archivePath: string;
      message: string;
    };
    expect(body.archived).toBe(true);
    expect(body.entries).toBe(2);
    expect(body.bytes).toBeGreaterThan(0);
    expect(existsSync(body.archivePath)).toBe(true);
    expect(readFileSync(body.archivePath, "utf8")).toContain("crêpes");
    expect(body.message).toContain(body.archivePath);

    // Après l'opération, l'état mémoire est cohérent (0 entrée).
    const after = handleMemoryRequest({
      method: "GET",
      path: "/api/memory",
      headers: {},
      body: "",
      deps: h.deps,
    });
    expect((after.body as { entries: number }).entries).toBe(0);
    h.service.close();
  });

  it("journalise l'opération (horodatage, taille, destination) SANS contenu de souvenir", () => {
    const h = harness();
    h.store.add({ text: SECRET_MEMORY, source: "a", cat: "fait" });
    handleMemoryRequest({
      method: "POST",
      path: "/api/memory/reset",
      headers: WRITE_HEADERS,
      body: "",
      deps: h.deps,
    });
    const audit = h.lines.filter((line) => line.includes("memory.reset"));
    expect(audit).toHaveLength(1);
    const record = JSON.parse(audit[0] as string) as Record<string, unknown>;
    expect(record.archived).toBe(true);
    expect(record.entries).toBe(1);
    expect(typeof record.at).toBe("string");
    expect(typeof record.bytes).toBe("number");
    expect(typeof record.archive).toBe("string");
    // ⚠️ Aucun contenu de souvenir dans le journal.
    expect(h.lines.join("\n")).not.toContain(SECRET_MEMORY);
    h.service.close();
  });
});

describe("API mémoire — méthode/chemin inconnus", () => {
  it("DELETE → 405, chemin inconnu → 404", () => {
    const del = handleMemoryRequest({
      method: "DELETE",
      path: "/api/memory",
      headers: WRITE_HEADERS,
      body: "",
      deps: harness().deps,
    });
    expect(del.status).toBe(405);
    const unknown = handleMemoryRequest({
      method: "GET",
      path: "/api/memory/inconnu",
      headers: {},
      body: "",
      deps: harness().deps,
    });
    expect(unknown.status).toBe(404);
  });
});
