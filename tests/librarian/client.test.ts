/**
 * Client HTTP du libraire — preuves RÉELLES contre un serveur mock.
 *
 * Prouve : les en-têtes d'authentification envoyés (Authorization seulement si
 * agentToken renseigné, X-API-Key seulement si apiKey renseignée — les deux sur
 * TOUTES les routes quand les deux existent), la lecture des réponses, et
 * surtout la traduction DISTINCTE et HONNÊTE de chaque cause d'échec (401 clé,
 * 403 jeton, 404 absent, 429 limite, 502/500 moteurs web, injoignable, non
 * configuré).
 */

import { afterEach, describe, expect, it } from "vitest";

import { LibrarianClient } from "../../src/librarian/client.js";
import { isLibrarianError, type LibrarianError } from "../../src/librarian/errors.js";
import { startMockLibrarian, type MockLibrarian, type MockResponse } from "./mock-librarian.js";

const servers: MockLibrarian[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function harness(
  responder: (request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }) => MockResponse,
  overrides: Partial<{ baseUrl: string; agentToken: string; apiKey: string }> = {},
): Promise<{ mock: MockLibrarian; client: LibrarianClient }> {
  const mock = await startMockLibrarian((request) => responder(request));
  servers.push(mock);
  const config = {
    baseUrl: overrides.baseUrl ?? mock.baseUrl,
    agentToken: overrides.agentToken ?? "jeton-agent-test",
    apiKey: overrides.apiKey ?? "lib-cle-test",
  };
  return { mock, client: new LibrarianClient({ config: () => config }) };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no_error";
  } catch (error) {
    if (isLibrarianError(error)) return (error as LibrarianError).code;
    return `unexpected:${String(error)}`;
  }
}

describe("libraire — client HTTP", () => {
  it("envoie les DEUX en-têtes sur une route protégée ET sur /status (clé disponible)", async () => {
    const { mock, client } = await harness((request) => {
      if (request.url.endsWith("/status")) return { status: 200, body: { totalDocs: 3 } };
      return { status: 200, body: { library: [] } };
    });

    await client.status();
    await client.library();

    const statusReq = mock.requests.find((r) => r.url.endsWith("/status"));
    const libraryReq = mock.requests.find((r) => r.url.endsWith("/library"));
    // Libry accepte la clé en Authorization OU en X-API-Key : on envoie les deux
    // quand les deux sont configurés (⚠️ ainsi un Bearer invalide ne masque plus
    // une clé X-API-Key valide).
    expect(statusReq?.headers["authorization"]).toBe("Bearer jeton-agent-test");
    expect(statusReq?.headers["x-api-key"]).toBe("lib-cle-test");
    expect(libraryReq?.headers["authorization"]).toBe("Bearer jeton-agent-test");
    expect(libraryReq?.headers["x-api-key"]).toBe("lib-cle-test");
  });

  it("agentToken VIDE : aucun en-tête Authorization, mais X-API-Key présent", async () => {
    const { mock, client } = await harness(() => ({ status: 200, body: { library: [] } }), {
      agentToken: "",
    });
    await client.library();
    const req = mock.requests[0];
    expect(req?.headers["authorization"]).toBeUndefined();
    expect(req?.headers["x-api-key"]).toBe("lib-cle-test");
  });

  it("agentToken renseigné (INVALIDE) + clé VALIDE : les deux en-têtes partent et Libry accepte la clé", async () => {
    // Serveur SIMULÉ aux sémantiques de Libry : une clé valide dans X-API-Key
    // suffit, même si le Bearer est invalide (le piège de la double clé disparaît).
    const { mock, client } = await harness(
      (request) => {
        const key = request.headers["x-api-key"];
        if (key === "lib-cle-test") return { status: 200, body: { library: [] } };
        return { status: 401, body: {} };
      },
      { agentToken: "jeton-obsolete", apiKey: "lib-cle-test" },
    );
    const library = await client.library();
    expect(library.library).toEqual([]);
    const req = mock.requests[0];
    expect(req?.headers["authorization"]).toBe("Bearer jeton-obsolete");
    expect(req?.headers["x-api-key"]).toBe("lib-cle-test");
  });

  it("/status SANS agentToken : la clé libraire suffit (X-API-Key, pas d'Authorization)", async () => {
    const { mock, client } = await harness(() => ({ status: 200, body: { totalDocs: 1 } }), {
      agentToken: "",
    });
    await client.status();
    const req = mock.requests.find((r) => r.url.endsWith("/status"));
    expect(req?.headers["authorization"]).toBeUndefined();
    expect(req?.headers["x-api-key"]).toBe("lib-cle-test");
  });

  it("search : distingue un document LOCAL (content) d'un résultat WEB (sans content)", async () => {
    const { client } = await harness(() => ({
      status: 200,
      body: {
        results: [
          { title: "Doc local", url: "https://x/doc", snippet: "s", content: "CONTENU COMPLET" },
          { title: "Page web", url: "https://web/page", snippet: "extrait web" },
        ],
        archived: false,
      },
    }));
    const outcome = await client.search("react");
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ content: "CONTENU COMPLET" });
    expect(outcome.results[1]).not.toHaveProperty("content");
    expect(outcome.archived).toBe(false);
  });

  it("library : lit les entrées et ignore les entrées sans nom", async () => {
    const { client } = await harness(() => ({
      status: 200,
      body: {
        lastUpdated: "2026-01-01",
        library: [{ name: "react", version: "18", keywords: ["ui"] }, { version: "x" }],
      },
    }));
    const library = await client.library();
    expect(library.library).toHaveLength(1);
    expect(library.library[0]).toMatchObject({ name: "react", version: "18" });
    expect(library.lastUpdated).toBe("2026-01-01");
  });

  it("doc : extrait les champs connus et conserve le brut", async () => {
    const { client } = await harness(() => ({
      status: 200,
      body: {
        name: "react",
        version: "18",
        summary: "Bibliothèque d'UI.",
        keyPoints: ["composants", "hooks"],
      },
    }));
    const doc = await client.doc("react", "18");
    expect(doc.summary).toBe("Bibliothèque d'UI.");
    expect(doc.keyPoints).toEqual(["composants", "hooks"]);
    expect(doc.raw).toBeTruthy();
  });

  it("doc : encode le nom et la version, et 404 → not_found", async () => {
    const { mock, client } = await harness(() => ({ status: 404, body: {} }));
    const code = await codeOf(client.doc("a/b", "1 2"));
    expect(code).toBe("not_found");
    expect(mock.requests[0]?.url).toBe("/api/librarian/doc/a%2Fb?version=1%202");
  });

  it("archive : POST le payload et renvoie un accusé 201", async () => {
    const { mock, client } = await harness(() => ({ status: 201, body: { ok: true } }));
    const receipt = await client.archive({
      name: "react",
      version: "18",
      content: { summary: "s", keyPoints: ["k"], api: [], examples: [] },
    });
    expect(receipt).toMatchObject({ name: "react", version: "18", status: 201 });
    const sent = JSON.parse(mock.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "react", version: "18" });
  });

  it("traduit CHAQUE code d'erreur en cause distincte", async () => {
    const cases: Array<[number, string, (c: LibrarianClient) => Promise<unknown>]> = [
      [401, "unauthorized_key", (c) => c.library()],
      [403, "unauthorized_token", (c) => c.library()],
      [404, "not_found", (c) => c.doc("x")],
      [429, "rate_limited", (c) => c.library()],
      [400, "bad_request", (c) => c.library()],
      [500, "server_error", (c) => c.library()],
      [502, "web_unavailable", (c) => c.search("x")],
      [500, "web_unavailable", (c) => c.search("x")],
    ];
    for (const [status, expected, call] of cases) {
      const { client } = await harness(() => ({ status, body: {} }));
      expect(await codeOf(call(client)), `status ${status}`).toBe(expected);
    }
  });

  it("réseau injoignable → unreachable (jamais une cause inventée)", async () => {
    const mock = await startMockLibrarian(() => ({ status: 200, body: {} }));
    const baseUrl = mock.baseUrl;
    await mock.close();
    const client = new LibrarianClient({
      config: () => ({ baseUrl, agentToken: "t", apiKey: "lib-x" }),
      timeoutMs: 500,
    });
    expect(await codeOf(client.status())).toBe("unreachable");
  });

  it("non configuré → not_configured (URL vide, jeton vide, clé vide)", async () => {
    const empty = new LibrarianClient({
      config: () => ({ baseUrl: "", agentToken: "", apiKey: "" }),
    });
    expect(await codeOf(empty.status())).toBe("not_configured");

    const { client } = await harness(() => ({ status: 200, body: {} }), { apiKey: "" });
    expect(await codeOf(client.library())).toBe("not_configured");
    // /status n'exige PAS la clé libraire.
    expect(await codeOf(client.status())).toBe("no_error");
  });

  it("corps illisible → invalid_response", async () => {
    const { client } = await harness(() => ({ status: 200, raw: "pas du json" }));
    expect(await codeOf(client.status())).toBe("invalid_response");
  });
});
