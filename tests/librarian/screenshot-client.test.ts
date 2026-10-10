/**
 * Capture de page web (Libry) — client HTTP (succès + CHAQUE code d'erreur).
 *
 * Serveur SIMULÉ (aucun réseau réel) : on prouve la route, le corps envoyé, le
 * téléchargement de l'image, et la traduction DISTINCTE de 400/401/403(SSRF)/
 * 429(+Retry-After)/502/504/500.
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
  responder: (request: { method: string; url: string }) => MockResponse,
  overrides: Partial<{ agentToken: string; apiKey: string }> = {},
) {
  const mock = await startMockLibrarian((request) => responder(request));
  servers.push(mock);
  const client = new LibrarianClient({
    config: () => ({
      baseUrl: mock.baseUrl,
      agentToken: overrides.agentToken ?? "",
      apiKey: overrides.apiKey ?? "lib-cle-test",
    }),
  });
  return { mock, client };
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

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("libraire — capture de page web (client)", () => {
  it("screenshot : POST /api/librarian/screenshot avec l'URL, puis shot() télécharge l'image", async () => {
    const { mock, client } = await harness((request) => {
      if (request.url.endsWith("/screenshot")) {
        return {
          status: 200,
          body: {
            id: "shot-1",
            mimeType: "image/png",
            width: 1440,
            height: 900,
            bytes: PNG.byteLength,
            url: "https://example.com/",
            origin: "web",
          },
        };
      }
      return { status: 200, bytes: PNG, contentType: "image/png" };
    });

    const meta = await client.screenshot("https://example.com/", { width: 1440, height: 900, timeoutMs: 15000 });
    expect(meta).toMatchObject({ id: "shot-1", mimeType: "image/png", width: 1440, height: 900 });
    const sent = JSON.parse(mock.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(mock.requests[0]?.url).toBe("/api/librarian/screenshot");
    expect(mock.requests[0]?.method).toBe("POST");
    expect(sent).toEqual({ url: "https://example.com/", width: 1440, height: 900, timeoutMs: 15000 });
    // Authentification : clé envoyée en X-API-Key (agentToken vide ⇒ pas de Bearer).
    expect(mock.requests[0]?.headers["x-api-key"]).toBe("lib-cle-test");
    expect(mock.requests[0]?.headers["authorization"]).toBeUndefined();

    const image = await client.shot(meta.id);
    expect(mock.requests[1]?.url).toBe("/api/librarian/shot/shot-1.png");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.bytes).equals(PNG)).toBe(true);
  });

  it("traduit CHAQUE code d'erreur de capture en cause DISTINCTE", async () => {
    const cases: Array<[number, string, Record<string, string> | undefined]> = [
      [400, "bad_request", undefined],
      [401, "unauthorized_key", undefined],
      [403, "target_refused", undefined],
      [502, "capture_failed", undefined],
      [504, "capture_timeout", undefined],
      [500, "server_error", undefined],
      [429, "rate_limited", { "retry-after": "3" }],
    ];
    for (const [status, expected, headers] of cases) {
      const { client } = await harness(() => ({ status, body: {}, ...(headers ? { headers } : {}) }));
      expect(await codeOf(client.screenshot("https://example.com/")), `status ${status}`).toBe(expected);
    }
  });

  it("429 : le message reprend le `Retry-After` reçu", async () => {
    const { client } = await harness(() => ({
      status: 429,
      body: {},
      headers: { "retry-after": "7" },
    }));
    try {
      await client.screenshot("https://example.com/");
      throw new Error("attendu : refus");
    } catch (error) {
      expect(isLibrarianError(error)).toBe(true);
      expect((error as LibrarianError).message).toContain("7 seconde");
    }
  });

  it("403 SSRF : message GÉNÉRIQUE (sans divulguer la cause exacte)", async () => {
    const { client } = await harness(() => ({ status: 403, body: {} }));
    try {
      await client.screenshot("http://127.0.0.1/");
      throw new Error("attendu : refus");
    } catch (error) {
      const message = (error as LibrarianError).message;
      expect(message).toContain("403");
      expect(message.toLowerCase()).toContain("refus");
      expect(message).not.toContain("127.0.0.1");
    }
  });
});
