/**
 * CLIENT REST Discord (lot 21) — contre un SERVEUR FIXTURE RÉEL (HTTP).
 *
 * Ce que ce fichier prouve, et qui ne peut pas l'être sur un double en mémoire :
 *  - l'authentification est bien `Authorization: Bot <jeton>` (doc `reference.mdx`) ;
 *  - la PAGINATION PAR IDENTIFIANT ne perd rien : on descend avec `before` et on ne
 *    conclut qu'à une page VIDE (une page courte n'est PAS la preuve de la fin) ;
 *  - un `429` est RESPECTÉ : `retry_after` est attendu, puis la requête repart — jamais de
 *    retry aveugle ;
 *  - le JETON ne fuit ni dans une erreur, ni dans un statut, ni vers le CDN ;
 *  - une pièce jointe d'un hôte étranger n'est PAS suivie (aucune requête).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/discord/client.ts` n'existe pas (le seul
 * fichier Discord du dépôt est un stub qui ne fait aucun appel).
 */

import { afterEach, describe, expect, it } from "vitest";

import { DiscordApiError, DiscordClient } from "../../src/chat/discord/client.js";
import { snowflakeOfTimestamp, timestampOfSnowflake } from "../../src/chat/discord/types.js";
import { CHANNEL, TOKEN, messageFixture, startDiscordFixture } from "./discord-fixture.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Client pointé sur la fixture, avec un CDN local (tests) et sans attente réelle. */
function clientFor(
  fixture: { apiBase: string },
  overrides: Partial<ConstructorParameters<typeof DiscordClient>[0]> = {},
) {
  return new DiscordClient({
    token: () => TOKEN,
    apiBase: fixture.apiBase,
    cdnHosts: ["127.0.0.1"],
    allowHttpCdn: true,
    minIntervalMs: 1,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe("client REST — identité, serveurs, salons", () => {
  it("envoie `Authorization: Bot <jeton>` et lit `users/@me`", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture);
    const me = await client.me();
    expect(me.id).toBe("123456789012345678");
    expect(me.username).toBe("yuki");
    const call = fixture.requests.find((req) => req.path === "/users/@me");
    // ⚠️ Contrat vérifié : `Authorization: Bot <jeton>` (pas `Bearer`).
    expect(call?.authorization).toBe(`Bot ${TOKEN}`);
  });

  it("liste les serveurs du bot puis leurs salons", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture);
    const guilds = await client.guilds();
    expect(guilds.map((guild) => guild.id)).toEqual(["223456789012345678"]);
    const channels = await client.guildChannels(guilds[0]!.id);
    expect(channels.map((channel) => channel.type)).toContain(0);
  });

  it("lit l'application pour connaître l'état de l'intent MESSAGE_CONTENT", async () => {
    const fixture = await startDiscordFixture({ applicationFlags: 1 << 18 });
    const app = await clientFor(fixture).application();
    expect(Number(app.flags)).toBe(1 << 18);
  });
});

describe("client REST — pagination par identifiant", () => {
  it("descend avec `before` jusqu'à une page VIDE et ne perd aucun message", async () => {
    // Trois pages PLEINES (100) puis une page courte, puis une page VIDE : une page
    // courte ne doit PAS arrêter la descente.
    const pages = [0, 1, 2].map((index) =>
      Array.from({ length: 100 }, (_unused, position) =>
        messageFixture({
          id: `${9 - index}${String(90_000_000_000_000_000 + position * 1_000)}`,
          channel_id: CHANNEL,
          timestamp: new Date(Date.parse("2026-01-02T10:00:00.000Z") - (index * 100 + position) * 60_000).toISOString(),
        }),
      ),
    );
    const fixture = await startDiscordFixture({
      pages: (page) => {
        if (page === 0) return pages[0] ?? [];
        if (page === 1) return pages[1] ?? [];
        if (page === 2) return pages[2] ?? [];
        if (page === 3) {
          // Page COURTE, et plus ANCIENNE que les précédentes (comme le veut l'API).
          return [
            messageFixture({
              id: "100000000000000001",
              timestamp: new Date(Date.parse("2026-01-02T10:00:00.000Z") - 400 * 60_000).toISOString(),
            }),
          ];
        }
        return []; // seule une page vide conclut
      },
    });
    const client = clientFor(fixture);
    const result = await client.channelMessagesSince(CHANNEL, { since: "2020-01-01T00:00:00.000Z" });
    expect(result.messages).toHaveLength(301);
    expect(new Set(result.messages.map((message) => message.id)).size).toBe(301);
    expect(result.hasNext).toBe(false);
    // Quatre pages lues : 100, 100, 100, 1, puis la page vide (5 requêtes).
    const reads = fixture.requests.filter(
      (req) => req.method === "GET" && req.path === `/channels/${CHANNEL}/messages`,
    );
    expect(reads).toHaveLength(5);
    // `before` = plus ancien identifiant vu, et `limit` borné à 100 (jamais au-delà).
    expect(reads[1]?.query.get("before")).toBe(pages[0]?.[99]?.id);
    expect(reads[0]?.query.get("limit")).toBe("100");
    // Les messages sont rendus dans l'ordre CHRONOLOGIQUE (le plus ancien d'abord).
    const horodatages = result.messages.map((message) => Date.parse(message.timestamp ?? ""));
    expect([...horodatages].sort((a, b) => a - b)).toEqual(horodatages);
  });

  it("s'arrête à la borne de VOLUME en le DISANT (`hasNext`)", async () => {
    const fixture = await startDiscordFixture({
      pages: (page) =>
        Array.from({ length: 100 }, (_unused, position) =>
          messageFixture({
            id: `${8 - Math.min(page, 7)}${String(90_000_000_000_000_000 + position * 1_000)}`,
            timestamp: new Date(Date.parse("2026-01-02T10:00:00.000Z") - (page * 100 + position) * 60_000).toISOString(),
          }),
        ),
    });
    const result = await clientFor(fixture).channelMessagesSince(CHANNEL, {
      since: "2000-01-01T00:00:00.000Z",
      maxMessages: 150,
    });
    expect(result.messages).toHaveLength(150);
    // ⚠️ Jamais une coupe silencieuse : le reste est ANNONCÉ.
    expect(result.hasNext).toBe(true);
  });

  it("s'arrête dès qu'un message est ANTÉRIEUR à `since`", async () => {
    const fixture = await startDiscordFixture({
      pages: () => [
        messageFixture({ id: "111111111111111111", timestamp: "2026-01-02T10:00:00.000Z" }),
        messageFixture({ id: "111111111111111110", timestamp: "2026-01-01T10:00:00.000Z" }),
        messageFixture({ id: "111111111111111109", timestamp: "2025-12-31T10:00:00.000Z" }),
      ],
    });
    const result = await clientFor(fixture).channelMessagesSince(CHANNEL, {
      since: "2026-01-01T12:00:00.000Z",
    });
    expect(result.messages.map((message) => message.id)).toEqual(["111111111111111111"]);
    expect(result.hasNext).toBe(false);
    expect(fixture.requests.filter((req) => req.path === `/channels/${CHANNEL}/messages`)).toHaveLength(1);
  });
});

describe("client REST — débit et erreurs", () => {
  it("RESPECTE `retry_after` d'un 429 puis réussit (aucun retry aveugle)", async () => {
    const sleeps: number[] = [];
    const fixture = await startDiscordFixture({
      intercept: (path, call) =>
        path === "/users/@me" && call === 1
          ? {
              status: 429,
              headers: { "retry-after": "0.05", "x-ratelimit-remaining": "0" },
              body: { message: "You are being rate limited.", retry_after: 0.05, global: false },
            }
          : null,
    });
    const client = clientFor(fixture, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const me = await client.me();
    expect(me.id).toBe("123456789012345678");
    // ⚠️ Le délai attendu est CELUI ANNONCÉ (50 ms), pas un backoff inventé.
    expect(sleeps).toContain(50);
    // Le ralentissement est VISIBLE par le statut de la plateforme.
    expect(client.rateState().ralenti).toBe(true);
    expect(String(client.rateState().raison)).toContain("429");
  });

  it("un jeton refusé (401) lève une erreur qui NE CONTIENT PAS le jeton", async () => {
    const fixture = await startDiscordFixture({ expectedToken: "un-autre-jeton" });
    const client = clientFor(fixture);
    await expect(client.me()).rejects.toBeInstanceOf(DiscordApiError);
    const error = (await client.me().catch((caught: unknown) => caught)) as DiscordApiError;
    expect(error.code).toBe("unauthorized");
    expect(error.message).toContain("401");
    // ⚠️ Aucune fuite : ni la valeur, ni un préfixe, ni l'URL complète.
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain("127.0.0.1");
  });

  it("sans jeton, aucune requête n'est émise (`not_configured`)", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture, { token: () => undefined });
    expect(client.isConfigured()).toBe(false);
    await expect(client.me()).rejects.toMatchObject({ code: "not_configured" });
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("client REST — publication", () => {
  it("publie avec `message_reference` et `fail_if_not_exists: false`", async () => {
    const fixture = await startDiscordFixture();
    const created = await clientFor(fixture).createMessage({
      channelId: CHANNEL,
      content: "bonjour",
      replyToMessageId: "623456789012345678",
    });
    expect(created.id).toBeTruthy();
    const post = fixture.posts[0];
    const body = JSON.parse(post?.body ?? "{}") as {
      content?: string;
      message_reference?: Record<string, unknown>;
      allowed_mentions?: { parse?: string[] };
    };
    expect(body.content).toBe("bonjour");
    expect(body.message_reference).toEqual({
      message_id: "623456789012345678",
      channel_id: CHANNEL,
      // ⚠️ Une réponse à un message supprimé doit PARTIR, pas échouer.
      fail_if_not_exists: false,
    });
    // ⚠️ Anti-ping : aucune mention automatique ne peut être déclenchée par le contenu.
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("joint un fichier en MULTIPART `files[0]` (jamais un envoi en deux temps)", async () => {
    const fixture = await startDiscordFixture();
    await clientFor(fixture).createMessage({
      channelId: CHANNEL,
      content: "voici l'image",
      files: [{ filename: "image.png", mimeType: "image/png", bytes: Buffer.from("octets") }],
    });
    const post = fixture.posts[0];
    expect(post?.contentType).toContain("multipart/form-data");
    expect(post?.body).toContain('name="files[0]"');
    expect(post?.body).toContain('name="payload_json"');
    expect(post?.body).toContain("octets");
  });

  it("REFUSE un fichier au-delà de la borne AVANT tout appel réseau", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture);
    await expect(
      client.createMessage({
        channelId: CHANNEL,
        content: "trop lourd",
        files: [{ filename: "gros.bin", bytes: Buffer.alloc(2048) }],
        maxFileBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    // ⚠️ Zéro requête : la borne est vérifiée avant le réseau.
    expect(fixture.posts).toHaveLength(0);
  });
});

describe("client REST — pièces jointes", () => {
  it("télécharge une pièce jointe SANS envoyer le jeton au CDN", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture);
    const url = `${fixture.apiBase}/cdn/fichier.png`;
    const bytes = await client.downloadAttachment(url, { maxBytes: 1024 });
    expect(bytes.length).toBeGreaterThan(0);
    const call = fixture.requests.find((req) => req.path === "/cdn/fichier.png");
    // ⚠️ Le CDN n'a AUCUN en-tête d'authentification : sinon le jeton fuirait.
    expect(call?.authorization).toBeUndefined();
  });

  it("REFUSE une URL d'un hôte étranger (aucune requête)", async () => {
    const fixture = await startDiscordFixture();
    const client = clientFor(fixture);
    await expect(
      client.downloadAttachment("https://exemple.test/fichier.png"),
    ).rejects.toMatchObject({ code: "bad_url" });
    expect(fixture.requests).toHaveLength(0);
  });

  it("refuse aussi un hôte de CDN en `http://` hors mode test", async () => {
    const fixture = await startDiscordFixture();
    const strict = new DiscordClient({ token: () => TOKEN, apiBase: fixture.apiBase });
    await expect(
      strict.downloadAttachment("http://cdn.discordapp.com/fichier.png"),
    ).rejects.toMatchObject({ code: "bad_url" });
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("flocons de neige", () => {
  it("convertit un flocon en instant et inversement", () => {
    const ms = Date.parse("2026-01-02T10:00:00.000Z");
    const snowflake = snowflakeOfTimestamp(ms);
    const retour = timestampOfSnowflake(snowflake);
    expect(retour).toBe(ms);
    // Un identifiant qui n'est pas un flocon ne rend PAS une date inventée.
    expect(timestampOfSnowflake("pas-un-flocon")).toBeUndefined();
  });
});
