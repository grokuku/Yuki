/**
 * `POST /api/librarian/read` — le client qui rend le TEXTE d'une page.
 *
 * ⚠️ AUCUN réseau : `fetchImpl` est INJECTÉ (stub). On prouve ce qui est
 * RÉELLEMENT envoyé (chemin, corps, en-têtes) et ce qui revient au modèle :
 * texte paginé, `totalChars` stable, `truncated` honnête, erreurs TYPÉES.
 *
 * ⚠️ La clé libraire ne doit apparaître dans AUCUNE sortie (message d'erreur,
 * log) — seulement dans l'en-tête de la requête.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIBRARIAN_READ_TIMEOUT_MS,
  LibrarianClient,
} from "../../src/librarian/client.js";
import { isLibrarianError } from "../../src/librarian/errors.js";
import type { LibrarianConfig } from "../../src/librarian/types.js";

const API_KEY = "lib-TRES-SECRET-0123456789";
const BASE_URL = "http://libry.test:3007";

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Stub de `fetch` qui enregistre l'appel et rend la réponse programmée. */
function stubFetch(
  respond: (sent: Sent) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const record: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    sent.push(record);
    return respond(record);
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function client(
  fetchImpl: typeof fetch,
  overrides: Partial<LibrarianConfig> = {},
): LibrarianClient {
  const config: LibrarianConfig = {
    baseUrl: BASE_URL,
    agentToken: "",
    apiKey: API_KEY,
    ...overrides,
  };
  return new LibrarianClient({ config: () => config, fetchImpl });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const FULL_TEXT = "PREMIERE PARTIE " .repeat(50) + "DEUXIEME PARTIE ".repeat(50);

describe("libraire — lecture du texte d'une page (POST /read)", () => {
  it("envoie url/offset/limit et la clé, sans jeton agent vide", async () => {
    const { fetchImpl, sent } = stubFetch(() =>
      json(200, {
        url: "https://exemple.test/a",
        finalUrl: "https://exemple.test/a/",
        title: "Exemple",
        text: "Bonjour",
        totalChars: 7,
        offset: 0,
        truncated: false,
        contentType: "text/html",
      }),
    );

    const page = await client(fetchImpl).read("https://exemple.test/a", {
      offset: 10,
      limit: 1_000,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${BASE_URL}/api/librarian/read`);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toEqual({ url: "https://exemple.test/a", offset: 10, limit: 1_000 });
    expect(sent[0]?.headers["x-api-key"]).toBe(API_KEY);
    // ⚠️ `agentToken` vide ⇒ AUCUN en-tête Authorization (il masquerait la clé).
    expect(sent[0]?.headers["authorization"]).toBeUndefined();

    expect(page.text).toBe("Bonjour");
    expect(page.totalChars).toBe(7);
    expect(page.truncated).toBe(false);
    expect(page.finalUrl).toBe("https://exemple.test/a/");
  });

  it("rend le texte SANS balise (extrait par le libraire) tel qu'il arrive", async () => {
    const plain = "Titre de la page\n\nUn paragraphe lisible, sans balise HTML.";
    const { fetchImpl } = stubFetch(() =>
      json(200, {
        url: "https://exemple.test/",
        text: plain,
        totalChars: plain.length,
        offset: 0,
        truncated: false,
        contentType: "text/html",
      }),
    );

    const page = await client(fetchImpl).read("https://exemple.test/");
    expect(page.text).toBe(plain);
    expect(page.text).not.toMatch(/<[a-z][^>]*>/i);
  });

  it("pagine pour de vrai : offsets concaténés = texte complet, totalChars stable", async () => {
    const { fetchImpl, sent } = stubFetch((request) => {
      const { offset, limit } = request.body as { offset: number; limit: number };
      const slice = FULL_TEXT.slice(offset, offset + limit);
      return json(200, {
        url: "https://exemple.test/long",
        text: slice,
        totalChars: FULL_TEXT.length,
        offset,
        truncated: offset + slice.length < FULL_TEXT.length,
        contentType: "text/plain",
      });
    });

    const c = client(fetchImpl);
    const limit = 500;
    let offset = 0;
    let assembled = "";
    const totals: number[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      const page = await c.read("https://exemple.test/long", { offset, limit });
      totals.push(page.totalChars);
      assembled += page.text;
      // ⚠️ La règle d'enchaînement : offset + longueur reçue, sans trou ni recouvrement.
      offset = page.offset + page.text.length;
      if (!page.truncated) break;
    }

    expect(assembled).toBe(FULL_TEXT);
    expect(new Set(totals).size).toBe(1);
    expect(totals[0]).toBe(FULL_TEXT.length);
    // 6 tranches de 500 pour ~1 000 caractères : au moins deux appels distincts.
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[1]?.body).toMatchObject({ offset: limit });
  });

  it("offset au-delà de la fin : texte vide, truncated false, aucune erreur", async () => {
    const { fetchImpl, sent } = stubFetch(() =>
      json(200, {
        url: "https://exemple.test/court",
        text: "",
        totalChars: 42,
        offset: 9_999,
        truncated: false,
        contentType: "text/html",
      }),
    );

    const page = await client(fetchImpl).read("https://exemple.test/court", { offset: 9_999 });
    expect(sent[0]?.body).toEqual({ url: "https://exemple.test/court", offset: 9_999 });
    expect(page.text).toBe("");
    expect(page.truncated).toBe(false);
    expect(page.totalChars).toBe(42);
  });

  it.each([
    [413, "TOO_LARGE", "read_too_large"],
    [415, "NOT_TEXT", "read_not_text"],
    [502, "HTTP_403", "read_failed"],
    [504, "TIMEOUT", "read_timeout"],
    [403, "BLOCKED_URL", "target_refused"],
  ])("statut %i (%s) → cause typée %s, code du libraire conservé", async (status, upstream, code) => {
    const { fetchImpl } = stubFetch(() =>
      json(status, { error: "refus", code: upstream, url: "https://interne.test/" }),
    );

    const error = await client(fetchImpl)
      .read("https://exemple.test/")
      .catch((e: unknown) => e);

    expect(isLibrarianError(error)).toBe(true);
    if (!isLibrarianError(error)) return;
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.upstreamCode).toBe(upstream);
    // ⚠️ La RAISON exacte parvient à l'appelant, jamais « échec générique ».
    expect(error.message).toContain(upstream);
    // ⚠️ Ni la clé, ni l'URL complète de l'hôte ne fuient.
    expect(error.message).not.toContain(API_KEY);
  });

  it("précise le 502 quand le libraire dit pourquoi (HTTP_404)", async () => {
    const { fetchImpl } = stubFetch(() =>
      json(502, { error: "http 404", code: "HTTP_404" }),
    );
    const error = await client(fetchImpl)
      .read("https://exemple.test/absent")
      .catch((e: unknown) => e);
    if (!isLibrarianError(error)) throw new Error("erreur attendue");
    expect(error.code).toBe("read_failed");
    expect(error.message).toContain("404");
  });

  it("libraire non configuré : cause explicite, AUCUN appel réseau", async () => {
    const { fetchImpl, sent } = stubFetch(() => json(200, {}));
    const error = await client(fetchImpl, { baseUrl: "", apiKey: "" })
      .read("https://exemple.test/")
      .catch((e: unknown) => e);

    if (!isLibrarianError(error)) throw new Error("erreur attendue");
    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("n'est pas configuré");
    expect(sent).toHaveLength(0);
  });

  it("libraire injoignable : cause « unreachable », pas de crash", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const error = await client(fetchImpl)
      .read("https://exemple.test/")
      .catch((e: unknown) => e);

    if (!isLibrarianError(error)) throw new Error("erreur attendue");
    expect(error.code).toBe("unreachable");
    expect(error.message).toContain("INJOIGNABLE");
  });

  it("corps illisible : cause « invalid_response »", async () => {
    const fetchImpl = (async () =>
      new Response("pas du json", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const error = await client(fetchImpl)
      .read("https://exemple.test/")
      .catch((e: unknown) => e);
    if (!isLibrarianError(error)) throw new Error("erreur attendue");
    expect(error.code).toBe("invalid_response");
  });

  it("ne journalise JAMAIS la clé (ni en succès, ni en refus)", async () => {
    const logs: string[] = [];
    const logger = {
      debug: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})),
      info: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})),
      warn: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})),
      error: (m: string, f?: Record<string, unknown>) => logs.push(m + JSON.stringify(f ?? {})),
    };

    const okFetch = stubFetch(() =>
      json(200, { url: "https://exemple.test/", text: "x", totalChars: 1, offset: 0, truncated: false }),
    );
    await new LibrarianClient({
      config: () => ({ baseUrl: BASE_URL, agentToken: "", apiKey: API_KEY }),
      fetchImpl: okFetch.fetchImpl,
      logger,
    }).read("https://exemple.test/");

    const koFetch = stubFetch(() => json(413, { error: "trop gros", code: "TOO_LARGE" }));
    await new LibrarianClient({
      config: () => ({ baseUrl: BASE_URL, agentToken: "", apiKey: API_KEY }),
      fetchImpl: koFetch.fetchImpl,
      logger,
    })
      .read("https://exemple.test/")
      .catch(() => undefined);

    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(API_KEY);
  });

  it("le délai de lecture dépasse celui de Libry (pour laisser arriver son 504)", () => {
    expect(DEFAULT_LIBRARIAN_READ_TIMEOUT_MS).toBeGreaterThan(15_000);
  });
});

describe("chaîne complète — client réel + outil du modèle (fetch moqué)", () => {
  it("le texte de la page ARRIVE au modèle, encadré et sans balise", async () => {
    const plain = "Guide de déploiement\n\n1. Construire l'image.\n2. Publier.";
    const { fetchImpl } = stubFetch(() =>
      json(200, {
        url: "https://docs.test/guide",
        finalUrl: "https://docs.test/guide/",
        title: "Guide",
        text: plain,
        totalChars: plain.length,
        offset: 0,
        truncated: false,
        contentType: "text/html",
      }),
    );

    const { createLibrarianTools } = await import("../../src/pi/sdk/librarian-tools.js");
    const tools = createLibrarianTools({
      client: {
        status: async () => ({}),
        search: async () => ({ results: [] }),
        library: async () => ({ library: [] }),
        doc: async () => ({ raw: {} }),
        archive: async () => ({ name: "x", version: "1", status: 201 }),
      },
      archive: { schedule: () => ({ status: "launched", job_id: "j1" }) },
      read: client(fetchImpl),
    });
    const tool = tools.find((t) => t.name === "lire_page_web");
    if (!tool) throw new Error("outil lire_page_web absent");

    const run = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
    const result = await run("call", { url: "https://docs.test/guide" }, undefined, undefined, {});
    const text = result.content.map((part) => part.text ?? "").join("\n");

    expect(text).toContain("Guide de déploiement");
    expect(text).toContain("1. Construire l'image.");
    // Aucune balise HTML dans ce que lit le modèle.
    expect(text).not.toMatch(/<\/?(html|body|div|script|p)\b/i);
    expect(text.split("</libraire>").length - 1).toBe(1);
  });
});
