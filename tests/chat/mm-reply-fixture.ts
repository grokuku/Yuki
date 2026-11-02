/**
 * FIXTURE Mattermost partagée par les tests de réponse (anti-boucle, backfill).
 *
 * ⚠️ Elle sert UN serveur HTTP v4 + un WebSocket au même port, parce que c'est la seule
 * façon de prouver l'ANTI-BOUCLE : un post que Yuki publie revient par le temps réel
 * (`posted`) et traverse TOUT le chemin de décision. Un double en mémoire sauterait
 * l'ingestion dans le miroir, c'est-à-dire précisément ce qui empêche la boucle.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { ChatMirrorStore } from "../../src/chat/mirror/store.js";

export const MM_TOKEN = "jeton-bot-secret-0123456789";
export const MM_BOT_ID = "botidentifiant0123456789ab";
export const MM_CHANNEL = "canal-1";

export interface MmFixture {
  baseUrl: string;
  /** Posts créés par le test ou par Yuki (`POST /api/v4/posts`). */
  created: Array<Record<string, unknown>>;
  /** Diffuse un événement comme le ferait le serveur. */
  broadcast(event: string, post: Record<string, unknown>): void;
  /** Nombre de clients WebSocket ouverts (attente de connexion). */
  readonly open: number;
}

export interface MmFixtureOptions {
  /** Messages déjà présents dans le canal (rejoués au backfill). */
  backlog?: Array<Record<string, unknown>>;
}

/** Démarre la fixture ; le nettoyage est enregistré dans `cleanups`. */
export async function startMmFixture(
  cleanups: Array<() => Promise<void> | void>,
  options: MmFixtureOptions = {},
): Promise<MmFixture> {
  const created: Array<Record<string, unknown>> = [];
  const backlog = [...(options.backlog ?? [])];
  let open = 0;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v4/users/me") {
      send({ id: MM_BOT_ID, username: "yuki", first_name: "Yuki" });
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams") {
      send([{ id: "equipe-1", name: "holaf" }]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams/equipe-1/channels") {
      send([{ id: MM_CHANNEL, display_name: "Général", type: "O" }]);
      return;
    }
    if (url.pathname === `/api/v4/channels/${MM_CHANNEL}/posts`) {
      send({
        order: backlog.map((item) => String(item.id)),
        posts: Object.fromEntries(backlog.map((item) => [String(item.id), item])),
      });
      return;
    }
    if (url.pathname === "/api/v4/users/ids") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const ids = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as string[];
        send(ids.map((id) => ({ id, username: id === MM_BOT_ID ? "yuki" : `nom-${id}` })));
      });
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/api/v4/posts") {
        const payload = JSON.parse(body || "{}") as Record<string, unknown>;
        created.push(payload);
        send({
          id: `envoye${created.length}`,
          channel_id: payload.channel_id,
          user_id: MM_BOT_ID,
          message: payload.message,
          root_id: payload.root_id,
          file_ids: payload.file_ids,
          create_at: Date.now(),
        });
        return;
      }
      if (url.pathname === "/api/v4/files") {
        send({ file_infos: [{ id: "fichier-1", name: "f.png", size: 1, mime_type: "image/png" }] });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "inconnu" }));
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    open += 1;
    socket.on("close", () => {
      open -= 1;
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { action?: string; data?: { token?: string } };
      if (frame.action !== "authentication_challenge" || frame.data?.token !== MM_TOKEN) {
        socket.send(JSON.stringify({ status: "FAIL", seq_reply: 1 }));
        return;
      }
      socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
      socket.send(JSON.stringify({ event: "hello", data: { server_version: "10.0.0" }, seq: 1 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;

  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    created,
    get open() {
      return open;
    },
    broadcast(event, post) {
      const payload = JSON.stringify({ event, data: { post: JSON.stringify(post) }, seq: 2 });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },
  };
}

/** Miroir RÉEL sur disque (jamais un double : l'anti-boucle passe par lui). */
export function openMmMirror(cleanups: Array<() => Promise<void> | void>): ChatMirrorStore {
  const root = mkdtempSync(join(tmpdir(), "yuki-mm-reply-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

/** Attend qu'une condition devienne vraie (jamais un `sleep` fixe). */
export async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}
