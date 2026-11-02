/**
 * PIÈCES JOINTES Mattermost — envoi (génération) et réception (analyse).
 *
 * ⚠️ CE QUI ÉTAIT VRAI AVANT CE LOT (et que ce fichier borne désormais) :
 *  - `send()` ne publiait que du TEXTE : `POST /posts` n'avait jamais de `file_ids`, donc
 *    une image produite par Yuki n'arrivait JAMAIS sur Mattermost ;
 *  - `postToRemoteMessage` ignorait `post.file_ids` : une image postée par un humain
 *    n'était jamais téléchargée, donc jamais vue par le modèle.
 *
 * Ce que ce fichier prouve, contre un SERVEUR FIXTURE RÉEL :
 *  - `POST /files` est un `multipart/form-data` portant `channel_id`, puis `POST /posts`
 *    porte `file_ids` (ordre imposé par l'API) ;
 *  - un fichier TROP LOURD est refusé AVANT réseau (aucune requête) et le texte part
 *    quand même, avec la raison ÉCRITE dans le message ;
 *  - un échec d'upload n'échoue PAS le run, reste VISIBLE (statut + message) et ne
 *    contient jamais le jeton ;
 *  - la garde de SÛRETÉ : un `file_id` non référencé par un message du canal n'est
 *    JAMAIS téléchargé (sinon un identifiant deviné lirait n'importe quel fichier) ;
 *  - le cache : un même `file_id` n'est téléchargé qu'UNE fois ;
 *  - la politique de vision partagée s'applique (une image → `ImageContent`, un fichier
 *    qui n'est pas une image → une NOTE, jamais un silence).
 *
 * ⚠️ Échoue sur le code d'origine : ni `uploadFile`/`downloadFile`, ni `attachments` dans
 * le miroir, ni `MattermostAttachmentCache` n'existent.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { MattermostAttachmentCache, prepareMessageImages } from "../../src/chat/mattermost/attachments.js";
import { MattermostApiError, MattermostClient } from "../../src/chat/mattermost/client.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel, postToRemoteMessage } from "../../src/chat/mirror/ingest.js";
import { MM_MAX_UPLOAD_BYTES } from "../../src/chat/mattermost/types.js";
import type { FilesPort } from "../../src/files/types.js";

const TOKEN = "jeton-bot-secret-0123456789";
const CHANNEL = "canal-1";
const AUTRE_CANAL = "canal-2";
const CONVERSATION = conversationIdOfChannel(CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** PNG minimal mais VALIDE pour la détection par octets : signature + IHDR. */
function pngDeTaille(width: number, height: number, taille = 64): Buffer {
  const buffer = Buffer.alloc(Math.max(taille, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

interface Recorded {
  method: string;
  path: string;
  contentType: string;
  authorization: string;
  body: string;
}

interface Fixture {
  baseUrl: string;
  requests: Recorded[];
  /** Fichiers téléversés (charge multipart brute). */
  uploads: string[];
  /** Fichiers réellement téléchargés (identifiants). */
  downloads: string[];
}

type Handler = (request: Recorded, reply: (status: number, body: unknown) => void) => void;

async function startFixture(handler?: Handler): Promise<Fixture> {
  const requests: Recorded[] = [];
  const uploads: string[] = [];
  const downloads: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = Buffer.concat(chunks).toString("utf8");
      const recorded: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        contentType: String(req.headers["content-type"] ?? ""),
        authorization: String(req.headers.authorization ?? ""),
        body,
      };
      requests.push(recorded);
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (handler) {
        handler(recorded, reply);
        if (res.writableEnded) return;
      }
      // Contrat par défaut : les routes de fichiers répondent comme Mattermost.
      if (recorded.path === "/api/v4/files" && recorded.method === "POST") {
        uploads.push(`${recorded.contentType}\n${body}`);
        reply(201, {
          file_infos: [{ id: `fichier-${uploads.length}`, name: "image.png", size: 64, mime_type: "image/png" }],
        });
        return;
      }
      const info = /^\/api\/v4\/files\/([^/]+)\/info$/.exec(recorded.path);
      if (info) {
        reply(200, {
          id: info[1],
          name: "photo.png",
          size: 64,
          mime_type: "image/png",
          extension: "",
        });
        return;
      }
      const bytes = /^\/api\/v4\/files\/([^/]+)$/.exec(recorded.path);
      if (bytes) {
        downloads.push(String(bytes[1]));
        const image = pngDeTaille(100, 50);
        res.writeHead(200, { "content-type": "image/png", "content-length": String(image.length) });
        res.end(image);
        return;
      }
      if (recorded.path === "/api/v4/posts" && recorded.method === "POST") {
        const payload = JSON.parse(body || "{}") as Record<string, unknown>;
        reply(201, {
          id: `envoye-${requests.length}`,
          channel_id: payload.channel_id,
          user_id: "bot",
          message: payload.message,
          root_id: payload.root_id,
          file_ids: payload.file_ids,
          create_at: Date.now(),
        });
        return;
      }
      reply(404, { message: "inconnu" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, uploads, downloads };
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-files-chat-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    store: ChatMirrorStore.open({
      indexPath: join(root, "chat-mirror.json"),
      messagesDir: join(root, "chat-mirror"),
    }),
  };
}

function clientFor(baseUrl: string) {
  return new MattermostClient({
    baseUrl: () => baseUrl,
    token: () => TOKEN,
    minIntervalMs: 1,
  });
}

/** Port de fichiers en mémoire (jamais le disque) : `get`/`readBytes` seulement. */
function fakeFiles(entries: Record<string, { name: string; mimeType: string; bytes: Buffer }>) {
  const port: Pick<FilesPort, "get" | "readBytes"> = {
    get: (id) => {
      const entry = entries[id];
      return entry
        ? {
            id,
            name: entry.name,
            mimeType: entry.mimeType,
            ext: "png",
            bytes: entry.bytes.length,
            createdAt: "2026-11-01T00:00:00.000Z",
            expiresAt: "2026-12-01T00:00:00.000Z",
            origin: "yuki" as const,
            analysis: { kind: "image" as const, readable: false },
          }
        : null;
    },
    readBytes: (id) => entries[id]?.bytes ?? null,
  };
  return port;
}

// ─── B2 — envoyer les images ────────────────────────────────────────────────

describe("B2 — envoyer une image : `POST /files` puis `POST /posts` avec `file_ids`", () => {
  it("le client téléverse en multipart (channel_id + fichier) puis publie avec `file_ids`", async () => {
    const fixture = await startFixture();
    const client = clientFor(fixture.baseUrl);
    const info = await client.uploadFile({
      channelId: CHANNEL,
      filename: 'capture "1".png',
      mimeType: "image/png",
      bytes: pngDeTaille(100, 50),
    });
    expect(info.id).toBe("fichier-1");
    expect(fixture.uploads).toHaveLength(1);
    // ⚠️ multipart AVEC la frontière posée par `fetch` (jamais un content-type manuel).
    expect(fixture.uploads[0]).toContain("multipart/form-data; boundary=");
    expect(fixture.uploads[0]).toContain('name="channel_id"');
    expect(fixture.uploads[0]).toContain(CHANNEL);
    expect(fixture.uploads[0]).toContain('name="files"; filename="capture _1_.png"');

    await client.createPost({ channelId: CHANNEL, message: "voici l'image", fileIds: [info.id] });
    const post = fixture.requests.find((item) => item.path === "/api/v4/posts");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      channel_id: CHANNEL,
      message: "voici l'image",
      file_ids: ["fichier-1"],
    });
  });

  it("un fichier au-delà de la borne est REFUSÉ avant réseau (aucun appel)", async () => {
    const fixture = await startFixture();
    const client = clientFor(fixture.baseUrl);
    const enorme = Buffer.alloc(16);
    await expect(
      client.uploadFile({
        channelId: CHANNEL,
        filename: "enorme.png",
        bytes: enorme,
        maxBytes: 8,
      }),
    ).rejects.toBeInstanceOf(MattermostApiError);
    expect(fixture.requests).toHaveLength(0);
  });

  it("`send()` avec un fichier : le texte ET `file_ids` partent ensemble", async () => {
    const fixture = await startFixture();
    const { store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    const image = pngDeTaille(120, 80);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      files: fakeFiles({ "file-1": { name: "image.png", mimeType: "image/png", bytes: image } }),
    });
    cleanups.push(() => adapter.disconnect());

    const envoye = await adapter.send(CONVERSATION, {
      kind: "texte",
      text: "Voici l'image demandée.",
      fichiers: ["file-1"],
    });
    expect(envoye.attachments?.map((item) => item.id)).toEqual(["fichier-1"]);
    const post = fixture.requests.find((item) => item.path === "/api/v4/posts");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      message: "Voici l'image demandée.",
      file_ids: ["fichier-1"],
    });
  });

  it("un fichier TROP LOURD ne fait pas échouer le run : le texte part, la raison est ÉCRITE", async () => {
    const fixture = await startFixture();
    const { store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    const enorme = Buffer.alloc(32);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      files: fakeFiles({ "file-1": { name: "enorme.png", mimeType: "image/png", bytes: enorme } }),
      maxUploadBytes: () => 8,
    });
    cleanups.push(() => adapter.disconnect());

    const envoye = await adapter.send(CONVERSATION, {
      kind: "texte",
      text: "L'image arrive.",
      fichiers: ["file-1"],
    });
    // Le texte est bien parti…
    expect(envoye.text).toContain("L'image arrive.");
    // …la raison est ÉCRITE dans le message (l'humain doit savoir)…
    expect(envoye.text).toContain("dépasse la borne d'envoi");
    // …et l'état le dit aussi.
    expect(adapter.status().raison ?? "").toContain("Pièce jointe non envoyée");
    // Aucun téléversement n'a été tenté (refus AVANT réseau).
    expect(fixture.uploads).toHaveLength(0);
    const post = fixture.requests.find((item) => item.path === "/api/v4/posts");
    expect(JSON.parse(post?.body ?? "{}")).not.toHaveProperty("file_ids");
  });

  it("un échec d'upload (500) n'échoue pas le run, reste visible, et ne fuit pas le jeton", async () => {
    const fixture = await startFixture((request, reply) => {
      if (request.path === "/api/v4/files") reply(500, { message: "stockage indisponible" });
    });
    const { store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      files: fakeFiles({
        "file-1": { name: "image.png", mimeType: "image/png", bytes: pngDeTaille(10, 10) },
      }),
    });
    cleanups.push(() => adapter.disconnect());

    const envoye = await adapter.send(CONVERSATION, {
      kind: "texte",
      text: "Voilà.",
      fichiers: ["file-1"],
    });
    expect(envoye.text).toContain("Voilà.");
    expect(envoye.text).toContain("n'a pas pu être envoyé");
    // ⚠️ Le jeton ne doit JAMAIS apparaître dans le message publié ni dans le statut.
    expect(envoye.text).not.toContain(TOKEN);
    expect(String(adapter.status().raison ?? "")).not.toContain(TOKEN);
  });
});

// ─── B3 — recevoir et lire les images ───────────────────────────────────────

describe("B3 — téléchargement À LA DEMANDE, cache et garde de sûreté", () => {
  function storeAvecDeuxCanaux() {
    const { store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    store.ensureConversation({
      conversationId: conversationIdOfChannel(AUTRE_CANAL),
      platform: "mattermost",
      remoteId: AUTRE_CANAL,
      title: "Autre",
    });
    store.upsert(
      postToRemoteMessage(
        {
          id: "p1",
          channel_id: CHANNEL,
          user_id: "humain-1",
          message: "voici",
          create_at: 1_700_000_000_000,
          file_ids: ["f-1"],
        },
        { platform: "mattermost", conversationId: CONVERSATION },
      ),
    );
    store.upsert(
      postToRemoteMessage(
        {
          id: "p2",
          channel_id: AUTRE_CANAL,
          user_id: "humain-1",
          message: "ailleurs",
          create_at: 1_700_000_000_000,
          file_ids: ["f-secret"],
        },
        { platform: "mattermost", conversationId: conversationIdOfChannel(AUTRE_CANAL) },
      ),
    );
    return store;
  }

  it("un `file_id` qui n'appartient PAS au canal n'est jamais téléchargé (garde de sûreté)", async () => {
    const fixture = await startFixture();
    const store = storeAvecDeuxCanaux();
    const cache = new MattermostAttachmentCache({ client: clientFor(fixture.baseUrl), store });

    // ① Fichier d'un AUTRE canal suivi : refusé pour CE canal.
    const autre = await cache.read(CONVERSATION, "f-secret");
    expect(autre.ok).toBe(false);
    if (!autre.ok) expect(autre.code).toBe("non_reference");
    // ② Identifiant INVENTÉ : refusé aussi.
    const invente = await cache.read(CONVERSATION, "f-devinee");
    expect(invente.ok).toBe(false);
    if (!invente.ok) expect(invente.code).toBe("non_reference");
    // ⚠️ AUCUNE requête n'a été émise : le refus est local, pas un 403 du serveur.
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.downloads).toHaveLength(0);
  });

  it("un canal qui n'est pas dans le miroir ne lit rien (`canal_inconnu`)", async () => {
    const fixture = await startFixture();
    const store = storeAvecDeuxCanaux();
    const cache = new MattermostAttachmentCache({ client: clientFor(fixture.baseUrl), store });
    const outcome = await cache.read("mm-inconnu", "f-1");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("canal_inconnu");
    expect(fixture.requests).toHaveLength(0);
  });

  it("un fichier référencé est téléchargé UNE fois (cache), et ses métadonnées sont relues", async () => {
    const fixture = await startFixture();
    const store = storeAvecDeuxCanaux();
    const cache = new MattermostAttachmentCache({ client: clientFor(fixture.baseUrl), store });

    const premier = await cache.read(CONVERSATION, "f-1");
    expect(premier.ok).toBe(true);
    if (premier.ok) {
      expect(premier.cached).toBe(false);
      expect(premier.bytes.subarray(0, 4).toString("latin1")).toBe("\u0089PNG");
    }
    // ⚠️ Les métadonnées (nom, taille, type) ont été RENSEIGNÉES à la demande.
    const meta = store.message(CONVERSATION, "p1")?.attachments?.[0];
    expect(meta).toMatchObject({ id: "f-1", nom: "photo.png", taille: 64, mime: "image/png" });

    const second = await cache.read(CONVERSATION, "f-1");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.cached).toBe(true);
    // ⚠️ UN seul téléchargement, malgré deux lectures (et deux appels d'info au plus).
    expect(fixture.downloads).toEqual(["f-1"]);
    expect(cache.downloadCount).toBe(1);
  });

  it("un fichier annoncé trop lourd est REFUSÉ sans être téléchargé", async () => {
    const fixture = await startFixture((request, reply) => {
      if (/\/info$/.test(request.path)) {
        reply(200, { id: "f-1", name: "enorme.png", size: 50 * 1024 * 1024, mime_type: "image/png" });
      }
    });
    const store = storeAvecDeuxCanaux();
    const cache = new MattermostAttachmentCache({
      client: clientFor(fixture.baseUrl),
      store,
      maxBytes: () => 1024,
    });
    const outcome = await cache.read(CONVERSATION, "f-1");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("trop_lourd");
    expect(fixture.downloads).toHaveLength(0);
  });
});

describe("B3 — politique de VISION partagée", () => {
  it("une image → `ImageContent` (base64 + type) ; un fichier texte → une NOTE", async () => {
    const store = (() => {
      const { store } = openStore();
      store.ensureConversation({
        conversationId: CONVERSATION,
        platform: "mattermost",
        remoteId: CHANNEL,
        title: "Général",
      });
      store.upsert(
        postToRemoteMessage(
          {
            id: "p1",
            channel_id: CHANNEL,
            user_id: "humain-1",
            message: "deux pièces",
            create_at: 1_700_000_000_000,
            file_ids: ["f-1", "f-texte"],
          },
          { platform: "mattermost", conversationId: CONVERSATION },
        ),
      );
      return store;
    })();
    // Le second fichier rend du TEXTE brut : ce n'est pas une image.
    const serveur = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (/\/info$/.test(url.pathname)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: url.pathname.split("/")[4], name: "x", size: 10 }));
          return;
        }
        if (url.pathname === "/api/v4/files/f-texte") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("bonjour, ceci est un fichier texte");
          return;
        }
        const image = pngDeTaille(100, 50);
        res.writeHead(200, { "content-type": "image/png", "content-length": String(image.length) });
        res.end(image);
      });
    });
    await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", () => resolve()));
    const port = (serveur.address() as AddressInfo).port;
    cleanups.push(async () => {
      serveur.closeAllConnections?.();
      await new Promise<void>((resolve) => serveur.close(() => resolve()));
    });
    const cache = new MattermostAttachmentCache({
      client: clientFor(`http://127.0.0.1:${port}`),
      store,
    });
    const prepared = await prepareMessageImages({
      cache,
      conversationId: CONVERSATION,
      message: store.message(CONVERSATION, "p1")!,
      maxBytes: 1_000_000,
      maxWireBytes: 1_400_000,
    });
    expect(prepared.images).toHaveLength(1);
    expect(prepared.images[0]?.mimeType).toBe("image/png");
    // ⚠️ Ce qui n'a pas été transmis est DIT (jamais un silence).
    expect(prepared.notes.join(" ")).toContain("n'est pas une image");
  });
});

// ─── B4 — le maillon qui manque, borné par un test ─────────────────────────

describe("B4 — le rédacteur reçoit les images et les notes du message déclencheur", () => {
  it("l'adaptateur passe `images` et `notes` au générateur (puis publie le texte)", async () => {
    const fixture = await startFixture();
    const { store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    const recu: Array<{ images?: readonly { data: string; mimeType: string }[]; notes?: readonly string[] }> = [];
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      readImages: async () => ({
        images: [{ data: "AAAA", mimeType: "image/png" }],
        notes: ["La pièce jointe « notes.txt » n'est pas une image."],
      }),
      generateReply: async ({ images, notes }) => {
        recu.push({ ...(images !== undefined ? { images } : {}), ...(notes !== undefined ? { notes } : {}) });
        return "Je vois une capture de 100×50.";
      },
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.send(CONVERSATION, { kind: "texte", text: "test" });
    // Le message envoyé par `send` ne déclenche pas de réponse (auteur = bot) : on passe
    // donc par la porte du temps réel, comme en production.
    const onMessage = (adapter as unknown as {
      onNewMessage(message: unknown): void;
    }).onNewMessage;
    store.setReplyMode(CONVERSATION, "tout");
    onMessage.call(adapter, {
      remoteId: "p1",
      conversationId: CONVERSATION,
      author: { id: "humain-1", nom: "Camille", estBot: false },
      role: "user",
      text: "que vois-tu ?",
      sentAt: "2026-11-01T10:00:00.000Z",
      attachments: [{ id: "f-1", nom: "f-1" }],
    });
    const debut = Date.now();
    while (recu.length === 0 && Date.now() - debut < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(recu).toHaveLength(1);
    expect(recu[0]?.images?.[0]?.mimeType).toBe("image/png");
    expect(recu[0]?.notes?.[0]).toContain("n'est pas une image");
  });

  it("la borne d'envoi par défaut est celle de Mattermost (100 Mo)", () => {
    expect(MM_MAX_UPLOAD_BYTES).toBe(100 * 1024 * 1024);
  });
});
