/**
 * CHAÎNE COMPLÈTE — un message Mattermost qui demande une image ⇒ `generer_image`
 * ⇒ fichier de la conversation ⇒ `POST /files` + `POST /posts` avec `file_ids`.
 *
 * ⚠️ CE QUE CE FICHIER PROUVE, MAILLON PAR MAILLON, contre un SERVEUR FIXTURE RÉEL
 * (HTTP + WebSocket) et un MODÈLE SIMULÉ (session éphémère injectée, qui appelle
 * réellement l'outil reçu) :
 *  ① le message déclencheur entre par le temps réel et le canal est en mode `tout` ;
 *  ② la POLITIQUE du run distant est calculée selon l'origine (`chat.mode` +
 *     `chat.remoteAgents`) et arrive à la session — aujourd'hui la réponse distante
 *     était écrite avec `tools: []`, donc SANS aucun outil ;
 *  ③ `generer_image` s'exécute vraiment (générateur ComfyUI simulé, stores RÉELS) et
 *     l'image est COPIÉE dans le store des fichiers, rattachée à la CONVERSATION DU
 *     CANAL (et non à la session éphémère du run) ;
 *  ④ le texte ET l'image partent dans le MÊME post : `POST /files` (multipart), puis
 *     `POST /posts` avec des `file_ids` NON VIDES.
 *
 * ⚠️ Échoue sur le code d'origine : `createSdkPromptWriter` y passait `tools: []` en
 * dur (aucun outil ⇒ aucun appel de `generer_image`), `createGeneratedImageFiles` et
 * `POST /files` n'existaient pas, et `generateReply` ne pouvait pas rendre de fichier.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { createRemoteReplyGenerator, CHAT_REPLY_SYSTEM_PROMPT } from "../../src/chat/index.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import type { ComfyImageView, GeneratedImage } from "../../src/comfy/index.js";
import { GeneratedImagesStore } from "../../src/comfy/images.js";
import { createFilesService, createGeneratedImageFiles, FilesStore } from "../../src/files/index.js";
import { REMOTE_SAFE_TOOLS } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createRemoteRunTools, createSdkPromptWriter } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import { buildModelsConfig, resolveModelsFrom, DEFAULT_EFFECTIVE_LLM_CONFIG } from "../../src/llm/index.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const CHANNEL = "canal-1";
const CONVERSATION = conversationIdOfChannel(CHANNEL);

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const MODELS = buildModelsConfig();
const MODEL_REFERENCE = resolveModelsFrom(DEFAULT_EFFECTIVE_LLM_CONFIG).light.reference;

/** PNG 1×1 VALIDE (l'image produite par le générateur simulé). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  baseUrl: string;
  /** Corps bruts des posts publiés par Yuki. */
  created: Array<Record<string, unknown>>;
  /** Charge multipart des fichiers téléversés. */
  uploads: string[];
  broadcast(event: string, post: Record<string, unknown>): void;
}

/** Serveur fixture : API v4 minimale + WebSocket d'événements au même port. */
async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];
  const uploads: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v4/users/me") {
      send({ id: BOT_ID, username: "yuki", first_name: "Yuki" });
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams") {
      send([{ id: "equipe-1", name: "holaf" }]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams/equipe-1/channels") {
      send([{ id: CHANNEL, display_name: "Général", type: "O" }]);
      return;
    }
    if (url.pathname === `/api/v4/channels/${CHANNEL}/posts`) {
      send({ order: [], posts: {} });
      return;
    }
    if (url.pathname === "/api/v4/users/ids") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "humain-1", username: "alice" }]));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/api/v4/files") {
        uploads.push(`${String(req.headers["content-type"] ?? "")}\n${body}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            file_infos: [
              {
                id: `fichier-${uploads.length}`,
                name: "image-generee.png",
                size: PNG.length,
                mime_type: "image/png",
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/api/v4/posts") {
        const payload = JSON.parse(body || "{}") as Record<string, unknown>;
        created.push(payload);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `envoye-${created.length}`,
            channel_id: payload.channel_id,
            user_id: BOT_ID,
            message: payload.message,
            root_id: payload.root_id,
            file_ids: payload.file_ids,
            create_at: Date.now(),
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "inconnu" }));
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { action?: string };
      if (frame.action !== "authentication_challenge") return;
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
    uploads,
    broadcast(event, post) {
      const payload = JSON.stringify({ event, data: { post: JSON.stringify(post) }, seq: 2 });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

function tempDir(purpose: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yuki-${purpose}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Stores RÉELS (sur disque) : fichiers, images générées, copie image → fichier. */
function makeDepot() {
  const images = new GeneratedImagesStore({
    dir: tempDir("chain-images"),
    logger,
    retentionDays: () => 30,
  });
  images.ensureLayout();
  const files = new FilesStore({ dir: tempDir("chain-files"), logger, retentionDays: () => 30 });
  files.ensureLayout();
  const service = createFilesService({ store: files, logger });
  const archive = createGeneratedImageFiles({ files, images, logger });
  return { images, files, service, archive };
}

/** Ce que la session éphémère a reçu (politique + définitions). */
interface Received {
  tools?: readonly string[];
  noms: string[];
  /** Scène réellement passée à `generer_image` (aucune si l'outil manque). */
  scene?: string;
}

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

/**
 * Session éphémère SIMULÉE : elle appelle l'outil `generer_image` qu'elle a
 * RÉELLEMENT reçu (comme le ferait le modèle), puis rend son texte.
 */
function simulatedModel(received: Received, scene: string) {
  return async (options: {
    tools?: readonly string[];
    customTools?: readonly unknown[];
  }): Promise<EphemeralSession> => {
    received.tools = options.tools;
    const tools = (options.customTools ?? []) as readonly AnyTool[];
    received.noms = tools.map((tool) => tool.name);
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    return {
      session: {
        subscribe(cb: Listener): () => void {
          listeners.push(cb);
          return () => undefined;
        },
        async prompt(): Promise<void> {
          const generer = tools.find((tool) => tool.name === "generer_image");
          if (!generer) throw new Error("aucun outil `generer_image` : le run n'en a pas reçu");
          received.scene = scene;
          // ⚠️ Contexte de la SESSION ÉPHÉMÈRE (identifiant jetable) : c'est bien la
          // conversation FORCÉE qui doit gagner, pas cet identifiant.
          const ctx = { sessionManager: { getSessionId: () => "session-ephemere-du-run" } };
          await generer.execute("appel-1", { scene }, undefined, undefined, ctx);
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Voilà l'image demandée." }],
              },
            });
          }
        },
        async abort(): Promise<void> {},
        dispose(): void {},
      },
      diagnostics: [],
    } as unknown as EphemeralSession;
  };
}

describe("chaîne complète — Mattermost → generer_image → fichier → file_ids", () => {
  it("un message qui demande une image produit un post AVEC `file_ids`", async () => {
    const fixture = await startFixture();
    const depot = makeDepot();
    const store = ChatMirrorStore.open({
      indexPath: join(tempDir("chain-mirror"), "chat-mirror.json"),
      messagesDir: join(tempDir("chain-mirror-msg"), "chat-mirror"),
    });

    // ── Écrivain SDK réel, session éphémère SIMULÉE (registre de modèles réel) ──
    const paths = resolvePiPaths({
      agentDir: join(tempDir("chain-agent"), "agent"),
      cwd: join(tempDir("chain-ws"), "workspace"),
      home: join(tempDir("chain-home"), "home"),
      sessionsDir: join(tempDir("chain-agent"), "agent", "sessions"),
      settingsSeedPath: "config/pi/settings.json",
    });
    seedSettingsFile(paths, logger);
    writeModelsFile(paths, MODELS, logger);

    const received: Received = { noms: [] };
    const imagesVues: ComfyImageView[] = [];
    const generateReply = createRemoteReplyGenerator({
      available: () => true,
      // ⚠️ Le nom dépend de la PLATEFORME DU RUN : ici un canal Mattermost.
      botName: () => "Yuki",
      // ② LA POLITIQUE : recalculée comme en production, pour l'origine Mattermost.
      runTools: (conversationId, onFileProduced) =>
        createRemoteRunTools({
          conversationId,
          chatMode: "mattermost",
          remoteAgents: false,
          lightOptions: () => ({ imagesEnabled: true, filesEnabled: true }),
          images: {
            // Générateur ComfyUI SIMULÉ : il écrit dans le VRAI store d'images et
            // rend exactement ce que rend le générateur réel.
            async generate(): Promise<GeneratedImage> {
              const record = depot.images.save({
                data: PNG,
                mimeType: "image/png",
                promptId: "prompt-1",
                width: 1,
                height: 1,
              });
              if (!record) throw new Error("image refusée par le store");
              return {
                record,
                bytes: PNG,
                promptId: "prompt-1",
                workflowName: "manga",
                elapsedMs: 10,
                outputLabeled: true,
                labels: ["YUKI_PROMPT"],
              };
            },
            archive: depot.archive,
            workflows: {
              candidates: () => [{ name: "manga", description: "Manga", isDefault: true }],
              documentationOf: () => "",
            },
            receivesImages: () => true,
            onImage: (view: ComfyImageView) => imagesVues.push(view),
          },
          files: depot.service,
          onFileProduced,
          logger,
        }),
      createWriter: (run) =>
        createSdkPromptWriter({
          cwd: paths.cwd,
          agentDir: paths.agentDir,
          authPath: join(paths.agentDir, "auth.json"),
          modelsPath: paths.modelsPath,
          systemPrompt: CHAT_REPLY_SYSTEM_PROMPT,
          modelReference: MODEL_REFERENCE,
          thinking: "off",
          timeoutMs: () => 10_000,
          logger,
          label: "réponse",
          createSession: simulatedModel(received, "un chat roux sur un clavier") as never,
          tools: run.tools,
          customTools: run.customTools,
        }),
    });

    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      // ⚠️ L'adaptateur lève les octets par le port de fichiers (jamais le disque).
      files: depot.files,
      generateReply,
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");
    store.setReplyMode(CONVERSATION, "tout");

    // ① Le message HUMAIN déclencheur.
    fixture.broadcast("posted", {
      id: "humain-image",
      channel_id: CHANNEL,
      user_id: "humain-1",
      message: "génère-moi un chat roux sur un clavier",
      create_at: 1_700_000_000_000,
    });
    await waitFor(() => fixture.created.length > 0, "le post publié par Yuki");

    // ② La politique du run distant est bien arrivée à la session.
    expect(received.tools).toEqual([...REMOTE_SAFE_TOOLS]);
    expect(received.noms.sort()).toEqual([...REMOTE_SAFE_TOOLS].sort());
    // ③ L'outil a réellement été appelé, avec la scène demandée.
    expect(received.scene).toBe("un chat roux sur un clavier");
    expect(imagesVues).toHaveLength(1);

    // ③ L'image est un FICHIER de la CONVERSATION DU CANAL (pas de la session
    //    éphémère du run) : elle est donc téléversable et re-listable.
    const fichiers = depot.service.listForSession(CONVERSATION);
    expect(fichiers).toHaveLength(1);
    const fichier = fichiers[0]!;
    expect(depot.files.get(fichier.id)).not.toBeNull();
    expect(depot.service.listForSession("session-ephemere-du-run")).toHaveLength(0);

    // ④ `POST /files` (multipart) PUIS `POST /posts` avec des `file_ids` non vides.
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).toContain("multipart/form-data; boundary=");
    expect(fixture.uploads[0]).toContain(CHANNEL);
    const post = fixture.created[0]!;
    expect(post.file_ids).toEqual(["fichier-1"]);
    expect(String(post.message)).toContain("Voilà l'image demandée.");
  });
});
