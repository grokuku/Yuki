/**
 * SERVEUR FIXTURE Discord (REST v10 + passerelle v10) pour les tests du lot 21.
 *
 * ⚠️ Ce n'est PAS un double en mémoire : c'est un vrai serveur HTTP et un vrai serveur
 * WebSocket sur `127.0.0.1`. Ce qui est vérifié ici ne peut pas l'être autrement :
 * l'en-tête `Authorization`, la forme EXACTE des trames `IDENTIFY`/`RESUME`/`HEARTBEAT`,
 * le multipart `files[0]`, et le respect d'un `429` + `retry_after`.
 *
 * ⚠️ Aucun réseau sortant : le client est pointé sur ce serveur par `apiBase` /
 * `gatewayUrl` (et par la fabrique de socket en mémoire quand un test veut couper).
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

import type { DiscordMessage } from "../../src/chat/discord/types.js";

export const TOKEN = "jeton-bot-discord-secret-0123456789";
export const BOT_ID = "123456789012345678";
export const GUILD_ID = "223456789012345678";
export const CHANNEL = "323456789012345678";
export const OTHER_CHANNEL = "423456789012345678";
export const THREAD = "523456789012345678";

/** Message Discord minimal (les champs utiles seulement). */
export function messageFixture(overrides: Record<string, unknown> = {}): DiscordMessage {
  return {
    id: "623456789012345678",
    channel_id: CHANNEL,
    guild_id: GUILD_ID,
    content: "bonjour",
    timestamp: new Date("2026-01-02T10:00:00.000Z").toISOString(),
    author: { id: "723456789012345678", username: "humain", bot: false },
    type: 0,
    ...overrides,
  } as DiscordMessage;
}

/** Requête REST reçue par la fixture (pour vérifier les en-têtes et le multipart). */
export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

export interface DiscordFixtureOptions {
  /** Pages de messages rendues : index de page (0 = la plus récente) ⇒ messages. */
  pages?: (page: number, query: URLSearchParams) => DiscordMessage[];
  /** Réponse `GET /applications/@me` (drapeaux d'intent). */
  applicationFlags?: number;
  /** Statut forcé d'une route (ex. 429) : `(path, n) => Response-like`. */
  intercept?: (
    path: string,
    call: number,
    req: RecordedRequest,
  ) => { status: number; headers?: Record<string, string>; body?: unknown } | null;
  /** Le jeton attendu (défaut `TOKEN`) : permet de simuler un jeton invalide. */
  expectedToken?: string;
  /** Délai avant réponse (ms) — jamais utilisé pour la logique, seulement pour la mesure. */
  delayMs?: number;
}

export interface DiscordFixture {
  apiBase: string;
  gatewayUrl: string;
  /** Toutes les requêtes REST reçues, dans l'ordre. */
  readonly requests: RecordedRequest[];
  /** Messages publiés par Yuki (`POST /channels/<id>/messages`). */
  readonly posts: RecordedRequest[];
  /** Trames de la passerelle reçues (texte brut), dans l'ordre. */
  readonly frames: string[];
  /** Trames `IDENTIFY` (op 2) reçues, décodées. */
  readonly identifies: Array<Record<string, unknown>>;
  /** Trames `RESUME` (op 6) reçues, décodées. */
  readonly resumes: Array<Record<string, unknown>>;
  /** Diffuse un événement DISPATCH à toutes les sockets ouvertes. */
  dispatch(event: string, data: unknown, sequence: number): void;
  /** Ferme brutalement les sockets (simule une coupure réseau). */
  drop(): void;
  /** Envoie une trame BRUTE (opcode arbitraire) à toutes les sockets. */
  sendRaw(payload: unknown): void;
  /** Ferme toutes les sockets avec un code précis (ex. 4004, 4014). */
  closeWith(code: number, reason?: string): void;
  /** Nombre de sockets actuellement ouvertes. */
  readonly open: number;
}

/**
 * Démarre la fixture.
 *
 * ⚠️ Le serveur répond AUSSI la passerelle (même port) : `ws://…/?v=10&encoding=json`.
 * `HELLO` est envoyé dès la connexion, avec `heartbeatIntervalMs` (300 ms par défaut pour
 * que le test observe un battement sans attendre 41 s).
 */
export async function startDiscordFixture(
  options: DiscordFixtureOptions & { heartbeatIntervalMs?: number } = {},
): Promise<DiscordFixture> {
  const requests: RecordedRequest[] = [];
  const posts: RecordedRequest[] = [];
  const frames: string[] = [];
  const identifies: Array<Record<string, unknown>> = [];
  const resumes: Array<Record<string, unknown>> = [];
  const expectedToken = options.expectedToken ?? TOKEN;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 300;
  const callsByPath = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = await readBody(req);
      const record: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body,
      };
      requests.push(record);
      const call = (callsByPath.get(`${record.method} ${record.path}`) ?? 0) + 1;
      callsByPath.set(`${record.method} ${record.path}`, call);
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      const intercept = options.intercept?.(record.path, call, record);
      if (intercept) {
        res.writeHead(intercept.status, {
          "content-type": "application/json",
          ...(intercept.headers ?? {}),
        });
        res.end(JSON.stringify(intercept.body ?? {}));
        return;
      }
      const send = (payload: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      // ⚠️ Authentification : `Authorization: Bot <jeton>` (doc `reference.mdx`).
      if (!record.path.startsWith("/cdn/") && record.authorization !== `Bot ${expectedToken}`) {
        send({ message: "401: Unauthorized", code: 0 }, 401);
        return;
      }
      if (record.path === "/users/@me") {
        send({ id: BOT_ID, username: "yuki", global_name: "Yuki", bot: true });
        return;
      }
      if (record.path === "/applications/@me") {
        send({ id: BOT_ID, name: "Yuki", flags: options.applicationFlags ?? 1 << 19 });
        return;
      }
      if (record.path === "/users/@me/guilds") {
        send([{ id: GUILD_ID, name: "Serveur de test" }]);
        return;
      }
      if (record.path === `/guilds/${GUILD_ID}/channels`) {
        send([
          { id: CHANNEL, type: 0, name: "général", guild_id: GUILD_ID },
          { id: OTHER_CHANNEL, type: 5, name: "annonces", guild_id: GUILD_ID },
          { id: "923456789012345678", type: 4, name: "Catégorie", guild_id: GUILD_ID },
          { id: "133456789012345678", type: 2, name: "vocal", guild_id: GUILD_ID },
        ]);
        return;
      }
      if (record.path === `/channels/${THREAD}`) {
        send({ id: THREAD, type: 11, parent_id: CHANNEL, name: "fil-du-message" });
        return;
      }
      if (/^\/channels\/[^/]+\/messages\/[^/]+$/.test(record.path)) {
        send(
          messageFixture({
            id: record.path.split("/")[4],
            channel_id: record.path.split("/")[3],
            attachments: [
              {
                id: "a-1",
                filename: "photo.png",
                size: 4,
                content_type: "image/png",
                url: `${base}/cdn/fichier.png`,
              },
            ],
          }),
        );
        return;
      }
      if (/^\/channels\/[^/]+\/messages$/.test(record.path)) {
        if (record.method === "POST") {
          posts.push(record);
          send(
            messageFixture({
              id: `9${posts.length}23456789012345678`,
              channel_id: record.path.split("/")[2],
              content: extractedContent(record),
              author: { id: BOT_ID, username: "yuki", bot: true },
            }),
          );
          return;
        }
        // ⚠️ `page` est le NUMÉRO D'APPEL (0 = première lecture, la plus récente), pas le
        // contenu de `before` : c'est ce qui rend les pages reproductibles.
        const rows =
          options.pages?.(call - 1, url.searchParams) ?? [
            messageFixture({ id: "623456789012345678" }),
          ];
        send(rows);
        return;
      }
      if (record.path === "/cdn/texte.txt") {
        // Fichier DONT LES OCTETS NE SONT PAS UNE IMAGE (aucune signature connue).
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("du texte");
        return;
      }
      if (record.path === "/cdn/fichier.png") {
        // ⚠️ Le CDN ne demande AUCUNE authentification (et le client ne doit pas en envoyer).
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_BYTES_1x1);
        return;
      }
      send({ message: "404: Not Found", code: 10003 }, 404);
    })();
  });

  // Le CDN du fixture est sur le MÊME serveur : le client doit donc accepter cet hôte.
  // Il n'envoie pas de jeton vers le CDN (vérifié par les tests).
  let base = "";
  const wss = new WebSocketServer({ server });
  let open = 0;
  wss.on("connection", (socket: WebSocket) => {
    open += 1;
    socket.on("close", () => {
      open -= 1;
    });
    socket.on("message", (raw) => {
      const text = String(raw);
      frames.push(text);
      let payload: { op?: number; d?: Record<string, unknown> };
      try {
        payload = JSON.parse(text) as { op?: number; d?: Record<string, unknown> };
      } catch {
        return;
      }
      if (payload.op === 2 && payload.d) {
        identifies.push(payload.d);
        // ⚠️ Comme le vrai serveur : un `IDENTIFY` valide est suivi d'un `READY`.
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: {
              v: 10,
              user: { id: BOT_ID, username: "yuki", global_name: "Yuki", bot: true },
              session_id: "session-1",
              resume_gateway_url: `${base.replace("http://", "ws://")}/?v=10&encoding=json`,
            },
          }),
        );
      }
      if (payload.op === 6 && payload.d) {
        resumes.push(payload.d);
        // ⚠️ Comme le vrai serveur : une reprise réussie se termine par `RESUMED`.
        socket.send(JSON.stringify({ op: 0, t: "RESUMED", s: null, d: {} }));
      }
    });
    // `HELLO` dès l'ouverture (doc : « Sent on connection »).
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: heartbeatIntervalMs } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;

  return {
    apiBase: base,
    gatewayUrl: `ws://127.0.0.1:${address.port}/?v=10&encoding=json`,
    requests,
    posts,
    frames,
    identifies,
    resumes,
    get open() {
      return open;
    },
    dispatch(event, data, sequence) {
      const frame = JSON.stringify({ op: 0, t: event, d: data, s: sequence });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(frame);
      }
    },
    sendRaw(payload) {
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
      }
    },
    drop() {
      for (const client of wss.clients) client.terminate();
    },
    closeWith(code, reason) {
      for (const client of wss.clients) client.close(code, reason);
    },
  };
}

/** Corps d'une requête, en texte (multipart compris : on cherche les délimiteurs). */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** Contenu d'un `POST` : JSON simple ou `payload_json` d'un multipart. */
function extractedContent(record: RecordedRequest): string {
  if (record.contentType?.includes("multipart/form-data") === true) {
    const match = /"content":"((?:[^"\\]|\\.)*)"/.exec(record.body);
    if (match) {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1] ?? "";
      }
    }
    return "";
  }
  try {
    const parsed = JSON.parse(record.body || "{}") as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : "";
  } catch {
    return "";
  }
}

/** PNG 1×1 minimal (signature valide : la détection par octets doit le reconnaître). */
export const PNG_BYTES_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
