/**
 * Client REST Mattermost (lot 18, lot 2) — contre un SERVEUR HTTP RÉEL.
 *
 * Ce que ce fichier prouve, et qui ne peut pas être prouvé sur un double en mémoire :
 *  - `users/me`, les équipes, les canaux et les posts passent par de vraies requêtes ;
 *  - **AUCUNE PERTE** quand le serveur TRONQUE `per_page` en silence (le défaut réel de
 *    l'API) : le client pagine et rend tous les messages ;
 *  - une lecture `?since=` est utilisée telle quelle (elle n'est pas combinable avec
 *    `page`/`per_page` dans l'API) et signale la borne de 1 000 ;
 *  - un `429` déclenche un backoff BORNÉ puis un succès, et allume le statut « ralenti » ;
 *  - le JETON n'apparaît ni dans une erreur, ni dans l'état, ni dans une URL.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/mattermost/client.ts` n'existe pas.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  MattermostApiError,
  MattermostClient,
  mattermostApiBase,
  mattermostWebSocketUrl,
  type MattermostClientOptions,
} from "../../src/chat/mattermost/client.js";

const TOKEN = "jeton-bot-tres-secret-0123456789";

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string;
  body: string;
}

interface Fixture {
  baseUrl: string;
  requests: Recorded[];
  close(): Promise<void>;
}

type Handler = (request: Recorded, response: ResponseLike) => void;

interface ResponseLike {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Démarre un serveur HTTP minimal qui répond selon `handler`. */
async function startFixture(handler: Handler): Promise<Fixture> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        authorization: String(req.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const out: ResponseLike = { status: 200, headers: {}, body: {} };
      handler(recorded, out);
      res.writeHead(out.status, {
        "content-type": "application/json",
        ...out.headers,
      });
      res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

/** Client pointé sur un fixture (débit rendu instantané pour les tests). */
function clientFor(baseUrl: string, extra: Partial<MattermostClientOptions> = {}) {
  return new MattermostClient({
    baseUrl: () => baseUrl,
    token: () => TOKEN,
    minIntervalMs: 1,
    ...extra,
  });
}

/** Post minimal (le client ne lit que ces champs). */
function post(id: string, channelId = "canal-1", extra: Record<string, unknown> = {}) {
  return {
    id,
    channel_id: channelId,
    user_id: "u1",
    message: `message ${id}`,
    create_at: 1_700_000_000_000,
    ...extra,
  };
}

describe("URL d'API — dérivée, jamais devinée", () => {
  it("ajoute `/api/v4` une seule fois et refuse une base vide", () => {
    expect(mattermostApiBase("https://mm.exemple.fr")).toBe("https://mm.exemple.fr/api/v4");
    expect(mattermostApiBase("https://mm.exemple.fr/")).toBe("https://mm.exemple.fr/api/v4");
    // Une base DÉJÀ suffixée n'est pas doublée.
    expect(mattermostApiBase("https://mm.exemple.fr/api/v4")).toBe(
      "https://mm.exemple.fr/api/v4",
    );
    expect(() => mattermostApiBase("  ")).toThrow(MattermostApiError);
    expect(() => mattermostApiBase("pas une url")).toThrow(/n'est pas une adresse valide/);
    expect(() => mattermostApiBase("ftp://mm.exemple.fr")).toThrow(/http:\/\/ ou https:\/\//);
  });

  it("l'URL WebSocket dérive de l'URL HTTP (ws depuis http, wss depuis https)", () => {
    expect(mattermostWebSocketUrl("https://mm.exemple.fr")).toBe(
      "wss://mm.exemple.fr/api/v4/websocket",
    );
    expect(mattermostWebSocketUrl("http://127.0.0.1:8065")).toBe(
      "ws://127.0.0.1:8065/api/v4/websocket",
    );
  });
});

describe("identité et canaux", () => {
  it("`users/me` rend l'identifiant du bot ; les canaux viennent de l'équipe", async () => {
    const fixture = await startFixture((request, out) => {
      if (request.path === "/api/v4/users/me") {
        out.body = { id: "bot-1", username: "yuki" };
        return;
      }
      if (request.path === "/api/v4/users/me/teams") {
        out.body = [{ id: "equipe-1", name: "holaf" }];
        return;
      }
      if (request.path === "/api/v4/users/me/teams/equipe-1/channels") {
        out.body = [
          { id: "canal-1", display_name: "Général", type: "O" },
          // Un canal SUPPRIMÉ n'est jamais suivi.
          { id: "canal-2", display_name: "Vieux", type: "O", delete_at: 1 },
        ];
        return;
      }
      out.status = 404;
      out.body = { message: "inconnu" };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);

    await expect(client.me()).resolves.toMatchObject({ id: "bot-1", username: "yuki" });
    const teams = await client.teams();
    expect(teams.map((team) => team.id)).toEqual(["equipe-1"]);
    const channels = await client.channelsForTeam("equipe-1");
    expect(channels.map((channel) => channel.id)).toEqual(["canal-1"]);

    // ⚠️ Le jeton ne part QUE dans l'en-tête, jamais dans l'URL.
    for (const request of fixture.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.path).not.toContain(TOKEN);
      expect(request.query.toString()).not.toContain(TOKEN);
    }
  });
});

describe("pagination — le serveur TRONQUE, le client ne perd rien", () => {
  it("un serveur qui plafonne `per_page` à 60 rend quand même les 250 messages", async () => {
    // 250 messages au total, servi par pages de 60 MAXIMUM quel que soit `per_page`.
    const all = Array.from({ length: 250 }, (_, index) => post(`p${index}`));
    const fixture = await startFixture((request, out) => {
      if (!request.path.endsWith("/posts")) {
        out.status = 404;
        out.body = { message: "inconnu" };
        return;
      }
      const perPage = Math.min(60, Number(request.query.get("per_page") ?? 60));
      const page = Number(request.query.get("page") ?? 0);
      const slice = all.slice(page * perPage, page * perPage + perPage);
      out.body = {
        order: slice.map((item) => item.id),
        posts: Object.fromEntries(slice.map((item) => [item.id, item])),
        // Le serveur ne dit RIEN de la troncature : `has_next` absent.
      };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);

    const page = await client.channelPostsAll("canal-1");
    expect(page.posts).toHaveLength(250);
    // Aucun doublon, et l'ordre du serveur est conservé.
    expect(new Set(page.posts.map((item) => item.id)).size).toBe(250);
    expect(page.posts[0]?.id).toBe("p0");
    expect(page.posts[249]?.id).toBe("p249");
    // ⚠️ `per_page` demandé ne dépasse JAMAIS 200 (au-delà : troncature silencieuse).
    for (const request of fixture.requests) {
      expect(Number(request.query.get("per_page"))).toBeLessThanOrEqual(200);
    }
  });

  it("`has_next: false` arrête la pagination même sur une page pleine", async () => {
    const all = Array.from({ length: 200 }, (_, index) => post(`q${index}`));
    const fixture = await startFixture((request, out) => {
      const page = Number(request.query.get("page") ?? 0);
      out.body =
        page === 0
          ? {
              order: all.map((item) => item.id),
              posts: Object.fromEntries(all.map((item) => [item.id, item])),
              has_next: false,
            }
          : { order: [], posts: {}, has_next: false };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    const page = await client.channelPostsAll("canal-1");
    expect(page.posts).toHaveLength(200);
    expect(page.hasNext).toBe(false);
    expect(fixture.requests).toHaveLength(1);
  });

  it("la borne `maxPosts` est dite (`hasNext: true`), jamais subie en silence", async () => {
    const all = Array.from({ length: 250 }, (_, index) => post(`r${index}`));
    const fixture = await startFixture((request, out) => {
      const page = Number(request.query.get("page") ?? 0);
      const slice = all.slice(page * 200, page * 200 + 200);
      out.body = {
        order: slice.map((item) => item.id),
        posts: Object.fromEntries(slice.map((item) => [item.id, item])),
      };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    const page = await client.channelPostsAll("canal-1", { maxPosts: 120 });
    expect(page.posts).toHaveLength(120);
    expect(page.hasNext).toBe(true);
  });
});

describe("lecture `?since=` — le backfill par DATE", () => {
  it("passe `since` et n'ajoute NI page NI per_page (l'API les refuse ensemble)", async () => {
    const fixture = await startFixture((_request, out) => {
      out.body = {
        order: ["a"],
        posts: { a: post("a") },
      };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);

    const page = await client.channelPostsSince("canal-1", 1_700_000_000_000);
    expect(page.posts.map((item) => item.id)).toEqual(["a"]);
    expect(page.hasNext).toBe(false);
    const request = fixture.requests[0];
    expect(request?.query.get("since")).toBe("1700000000000");
    expect(request?.query.get("page")).toBeNull();
    expect(request?.query.get("per_page")).toBeNull();
  });

  it("1 000 posts rendus ⇒ borne ATTEINTE annoncée (`hasNext`)", async () => {
    const all = Array.from({ length: 1_000 }, (_, index) => post(`s${index}`));
    const fixture = await startFixture((_request, out) => {
      out.body = {
        order: all.map((item) => item.id),
        posts: Object.fromEntries(all.map((item) => [item.id, item])),
      };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    const page = await client.channelPostsSince("canal-1", 1);
    expect(page.posts).toHaveLength(1_000);
    expect(page.hasNext).toBe(true);
  });
});

describe("débit et erreurs", () => {
  it("un 429 est absorbé par un backoff borné, puis le statut passe « ralenti »", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fixture = await startFixture((_request, out) => {
      calls += 1;
      if (calls === 1) {
        out.status = 429;
        out.headers = { "retry-after": "0" };
        out.body = { message: "trop de requêtes" };
        return;
      }
      out.body = { id: "bot-1" };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => 1_000,
    });

    await expect(client.me()).resolves.toMatchObject({ id: "bot-1" });
    expect(calls).toBe(2);
    // `Retry-After: 0` est respecté sans jamais descendre sous l'espacement minimal.
    expect(sleeps.every((ms) => ms >= 1)).toBe(true);
    const state = client.rateState();
    expect(state.ralenti).toBe(true);
    expect(String(state.raison)).toContain("429");
  });

  it("un jeton absent est refusé SANS appel réseau, avec un motif actionnable", async () => {
    const fixture = await startFixture((_request, out) => {
      out.body = {};
    });
    fixtures.push(fixture);
    const client = new MattermostClient({
      baseUrl: () => fixture.baseUrl,
      token: () => undefined,
      minIntervalMs: 1,
    });
    await expect(client.me()).rejects.toThrow(/n'est pas encore enregistré/);
    expect(fixture.requests).toHaveLength(0);
    expect(client.rateState()).toEqual({ ralenti: false });
  });

  it("une erreur HTTP ne recopie NI le jeton NI l'URL complète", async () => {
    const fixture = await startFixture((_request, out) => {
      out.status = 403;
      out.body = { message: "accès refusé" };
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    await expect(client.me()).rejects.toThrow(/HTTP 403/);
    try {
      await client.me();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain(TOKEN);
      expect(message).not.toContain("127.0.0.1");
      // Le CHEMIN, lui, est utile au diagnostic et ne dit rien de secret.
      expect(message).toContain("/users/me");
    }
  });

  it("`createPost` envoie `root_id` quand la réponse va dans un fil", async () => {
    const fixture = await startFixture((request, out) => {
      const body = JSON.parse(request.body) as Record<string, unknown>;
      out.body = post("nouveau", String(body.channel_id), {
        root_id: body.root_id,
        message: body.message,
      });
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    const created = await client.createPost({
      channelId: "canal-1",
      message: "bonjour",
      rootId: "racine-1",
    });
    expect(created.id).toBe("nouveau");
    const body = JSON.parse(fixture.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      channel_id: "canal-1",
      message: "bonjour",
      root_id: "racine-1",
    });
  });

  it("`users/ids` est groupé (un appel par lot de 100, jamais un par message)", async () => {
    const fixture = await startFixture((request, out) => {
      const ids = JSON.parse(request.body) as string[];
      out.body = ids.map((id) => ({ id, username: `nom-${id}` }));
    });
    fixtures.push(fixture);
    const client = clientFor(fixture.baseUrl);
    const ids = Array.from({ length: 150 }, (_, index) => `u${index}`);
    const users = await client.usersByIds(ids);
    expect(users).toHaveLength(150);
    expect(fixture.requests).toHaveLength(2);
  });
});
