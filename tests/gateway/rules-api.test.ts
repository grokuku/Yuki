/**
 * API `/api/self/rules` — garde-fous d'écriture, lecture, enregistrement,
 * retour arrière.
 *
 * Teste directement le handler (sans ouvrir de socket) : les en-têtes sont
 * forgés à la main, ce qui permet de couvrir `Origin`/`Host` et l'en-tête maison
 * exactement comme `/api/config` et `/api/self/personality`. C'est la SEULE voie
 * d'écriture de `rules.md` (réservée à l'utilisateur) ; aucun outil du modèle ne
 * l'emprunte (voir `tests/pi/boundary.test.ts`, invariant 5).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  handleRulesRequest,
  isRulesPath,
  type RulesApiDeps,
} from "../../src/gateway/routes/rules.js";
import { RulesStore } from "../../src/rules/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deps(): RulesApiDeps {
  const dir = mkdtempSync(join(tmpdir(), "yuki-rules-api-"));
  tempDirs.push(dir);
  const store = new RulesStore({
    path: join(dir, "rules.md"),
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
    secretValues: [],
  });
  return {
    store,
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
  };
}

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

describe("API règles — chemins", () => {
  it("reconnaît les chemins de l'API", () => {
    expect(isRulesPath("/api/self/rules")).toBe(true);
    expect(isRulesPath("/api/self/rules/revert")).toBe(true);
    expect(isRulesPath("/api/self/personality")).toBe(false);
  });
});

describe("API règles — lecture", () => {
  it("GET renvoie le contenu effectif, la borne et l'historique", () => {
    const d = deps();
    const response = handleRulesRequest({
      method: "GET",
      path: "/api/self/rules",
      headers: {},
      body: "",
      deps: d,
    });
    expect(response.status).toBe(200);
    const body = response.body as { text: string; maxChars: number; history: unknown[] };
    expect(body.text).toBe("");
    expect(body.maxChars).toBe(8000);
    expect(body.history).toEqual([]);
  });
});

describe("API règles — garde-fous d'écriture", () => {
  it("PUT sans en-tête X-Yuki-Config → 403", () => {
    const response = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
      deps: deps(),
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("missing_config_header");
  });

  it("PUT avec Origin étranger → 403 (bad_origin)", () => {
    const response = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: { ...WRITE_HEADERS, origin: "http://evil.test", host: "127.0.0.1:8080" },
      body: JSON.stringify({ text: "x" }),
      deps: deps(),
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("bad_origin");
  });

  it("POST /revert sans en-tête → 403", () => {
    const response = handleRulesRequest({
      method: "POST",
      path: "/api/self/rules/revert",
      headers: {},
      body: "",
      deps: deps(),
    });
    expect(response.status).toBe(403);
  });
});

describe("API règles — écriture et retour arrière", () => {
  it("PUT enregistre puis relit le contenu", () => {
    const d = deps();
    const put = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ text: "Ne jamais divulguer." }),
      deps: d,
    });
    expect(put.status).toBe(200);
    const get = handleRulesRequest({
      method: "GET",
      path: "/api/self/rules",
      headers: {},
      body: "",
      deps: d,
    });
    expect((get.body as { text: string }).text).toBe("Ne jamais divulguer.");
  });

  it("PUT corps invalide → 400", () => {
    const bad = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: WRITE_HEADERS,
      body: "not json",
      deps: deps(),
    });
    expect(bad.status).toBe(400);
    expect((bad.body as { code: string }).code).toBe("invalid_json");

    const noText = handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ other: 1 }),
      deps: deps(),
    });
    expect(noText.status).toBe(400);
    expect((noText.body as { code: string }).code).toBe("invalid_text");
  });

  it("POST /revert restaure la version précédente", () => {
    const d = deps();
    const put = (text: string) =>
      handleRulesRequest({
        method: "PUT",
        path: "/api/self/rules",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ text }),
        deps: d,
      });
    put("version A");
    put("version B");
    const revert = handleRulesRequest({
      method: "POST",
      path: "/api/self/rules/revert",
      headers: WRITE_HEADERS,
      body: "",
      deps: d,
    });
    expect(revert.status).toBe(200);
    const get = handleRulesRequest({
      method: "GET",
      path: "/api/self/rules",
      headers: {},
      body: "",
      deps: d,
    });
    expect((get.body as { text: string }).text).toBe("version A");
  });

  it("POST /revert sans version précédente → 404", () => {
    const d = deps();
    handleRulesRequest({
      method: "PUT",
      path: "/api/self/rules",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ text: "unique" }),
      deps: d,
    });
    const revert = handleRulesRequest({
      method: "POST",
      path: "/api/self/rules/revert",
      headers: WRITE_HEADERS,
      body: "",
      deps: d,
    });
    expect(revert.status).toBe(404);
    expect((revert.body as { code: string }).code).toBe("no_previous_version");
  });
});

describe("API règles — méthode inconnue", () => {
  it("DELETE → 405, chemin inconnu → 404", () => {
    const del = handleRulesRequest({
      method: "DELETE",
      path: "/api/self/rules",
      headers: WRITE_HEADERS,
      body: "",
      deps: deps(),
    });
    expect(del.status).toBe(405);
    const unknown = handleRulesRequest({
      method: "GET",
      path: "/api/self/rules/inconnu",
      headers: {},
      body: "",
      deps: deps(),
    });
    expect(unknown.status).toBe(404);
  });
});
