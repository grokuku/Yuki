/**
 * CHAÎNE COMPLÈTE — un message Mattermost qui demande une image ⇒ la POLITIQUE du
 * run distant ⇒ `generer_image` ⇒ ACCUSÉ ⇒ IMAGE ⇒ RÉPONSE.
 *
 * ⚠️ CE QUI A CHANGÉ (correctif du 2026-11-02, régression de production) : sous le
 * DÉFAUT `chat.remoteAgents = desactive`, `delegate` n'existe pas. Le refus inline
 * des outils longs (lot 23) supprimait donc purement et simplement la génération
 * d'image en canal (« avant, une génération courte passait ; maintenant jamais »).
 * Le contrat est désormais : sans délégation, l'appel est AUTORISÉ inline, la BORNE
 * DU TOUR est relevée (`channelTurnTimeoutMs`) et l'accusé prévient de la durée.
 *
 * ⚠️ CE QUE CE FICHIER PROUVE, MAILLON PAR MAILLON, contre un SERVEUR FIXTURE RÉEL
 * (HTTP + WebSocket), un vrai adaptateur Mattermost et un MODÈLE SIMULÉ (session
 * éphémère injectée, qui appelle réellement l'outil reçu et streame son accusé) :
 *  ① le message déclencheur entre par le temps réel et le canal est en mode `tout` ;
 *  ② la POLITIQUE du run distant arrive à la session (allowlist + définitions) ;
 *  ③ `generer_image` s'EXÉCUTE (le générateur simulé tourne, l'image est copiée
 *     dans le store des fichiers de la CONVERSATION du canal) ;
 *  ④ ORDRE STRICT des trois posts : [ACCUSÉ, IMAGE (`file_ids`), RÉPONSE] — l'image
 *     n'est pas réattachée à la réponse, et l'accusé n'y est pas dupliqué ;
 *  ⑤ TIMING : l'accusé part à moins d'une seconde du DÉMARRAGE de l'outil, donc
 *     PENDANT la génération (1,2 s ici), jamais avec la réponse finale — c'est le
 *     défaut signalé à 13:38 le 2026-11-02 (« s'il attend que tout soit fait pour
 *     le poster, ça sert à rien »).
 *
 * ⚠️ Échoue sur le code d'origine : l'outil y est REFUSÉ (aucune image produite,
 * aucune pièce jointe), donc aucun des trois posts attendus n'existe.
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
import { createChannelPostPort } from "../../src/chat/index.js";
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

/** Durée SIMULÉE d'une génération d'image (assez longue pour mesurer l'accusé). */
const DUREE_GENERATION_MS = 1_200;

/** Borne de l'exigence « l'accusé part AVANT que l'outil n'ait fini » (< 1 s). */
const ACK_MAX_DELAI_MS = 1_000;

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
  /** Instant (ms epoch) d'arrivée de chaque `POST /posts` (ordre = ordre d'arrivée). */
  arrivees: number[];
  /** Charge multipart des fichiers téléversés. */
  uploads: string[];
  broadcast(event: string, post: Record<string, unknown>): void;
}

/** Serveur fixture : API v4 minimale + WebSocket d'événements au même port. */
async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];
  const arrivees: number[] = [];
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
        arrivees.push(Date.now());
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
    arrivees,
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
  /** Texte RENDU par l'outil à l'appel (refus inline, lot 23). */
  refus?: string;
  /** Horodatages de la simulation (ms epoch). */
  debutOutil?: number;
  finOutil?: number;
}

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

/**
 * Session éphémère SIMULÉE : elle **streame** un accusé de réception, DÉMARRE
 * l'outil `generer_image` qu'elle a RÉELLEMENT reçu (comme le ferait le modèle),
 * puis rend son texte.
 *
 * ⚠️ L'ordre des événements est celui du SDK (`src/pi/sdk/prompt-writer.ts:213-235`) :
 * `message_start` → `message_update` (`text_delta`) → `tool_execution_start` →
 * (exécution de l'outil) → `tool_execution_end` → `message_end`. Sans lui, on ne
 * pourrait PAS prouver qu'un accusé part AVANT l'outil.
 */
function simulatedModel(received: Received, scene: string, options: { texteAck?: string } = {}) {
  return async (opts: {
    tools?: readonly string[];
    customTools?: readonly unknown[];
  }): Promise<EphemeralSession> => {
    received.tools = opts.tools;
    const tools = (opts.customTools ?? []) as readonly AnyTool[];
    received.noms = tools.map((tool) => tool.name);
    type Listener = (event: unknown) => void;
    const listeners: Listener[] = [];
    const emettre = (event: unknown): void => {
      for (const listener of listeners) listener(event);
    };
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
          emettre({ type: "message_start", message: { role: "assistant", content: [] } });
          if (options.texteAck !== undefined) {
            emettre({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: options.texteAck },
            });
          }
          received.debutOutil = Date.now();
          emettre({ type: "tool_execution_start", toolName: "generer_image" });
          // ⚠️ Contexte de la SESSION ÉPHÉMÈRE (identifiant jetable) : c'est bien la
          // conversation FORCÉE qui doit gagner, pas cet identifiant.
          const ctx = { sessionManager: { getSessionId: () => "session-ephemere-du-run" } };
          const resultat = (await generer.execute(
            "appel-1",
            { scene },
            undefined,
            undefined,
            ctx,
          )) as { content: Array<{ type: string; text?: string }> };
          received.finOutil = Date.now();
          received.refus = resultat.content.map((bloc) => bloc.text ?? "").join("");
          emettre({ type: "tool_execution_end", toolName: "generer_image" });
          emettre({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    options.texteAck !== undefined
                      ? `${options.texteAck}\nVoilà l'image demandée.`
                      : "Voilà l'image demandée.",
                },
              ],
            },
          });
        },
        async abort(): Promise<void> {},
        dispose(): void {},
      },
      diagnostics: [],
    } as unknown as EphemeralSession;
  };
}

describe("chaîne complète — Mattermost → generer_image → fichier → file_ids", () => {
  it("un message qui demande une image : accusé → image → réponse, tous les trois dans le canal", async () => {
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
          // ⚠️ PUBLICATION INTER-CANAL : ce câblage de test est un mini-composition root,
          // il doit donc FOURNIR le port comme le vrai — sinon la parité
          // politique ↔ définitions (assertion plus bas) deviendrait fausse.
          channels: createChannelPostPort({
            plateforme: "mattermost",
            canaux: () => [
              { conversationId: CONVERSATION, titre: "Général", plateforme: "mattermost" },
            ],
            envoyer: async () => undefined,
          }),
          images: {
            // Générateur ComfyUI SIMULÉ : il écrit dans le VRAI store d'images et
            // rend exactement ce que rend le générateur réel.
            // ⚠️ Il est LENT (1,2 s) À DESSEIN : c'est la durée qui permet de
            // prouver que l'accusé part AVANT la fin de l'outil.
            async generate(): Promise<GeneratedImage> {
              await new Promise((resolve) => setTimeout(resolve, DUREE_GENERATION_MS));
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
          createSession: simulatedModel(received, "un chat roux sur un clavier", {
            texteAck: "C'est parti.",
          }) as never,
          tools: run.tools,
          customTools: run.customTools,
          // ⚠️ INDISPENSABLE : c'est l'observateur d'outils qui publie l'ACCUSÉ au
          // démarrage (`ReplyProgress.demarrerOutil`). Sans lui, le texte du modèle
          // resterait dans la réponse finale — c'est exactement le défaut mesuré.
          ...(run.onTool ? { onTool: run.onTool } : {}),
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
    // ⚠️ TROIS posts attendus : ACCUSÉ, IMAGE (avec `file_ids`), RÉPONSE.
    await waitFor(() => fixture.created.length >= 3, "les trois posts du run");

    // ② La politique du run distant est bien arrivée à la session : `generer_image`
    //    est OFFERT (le modèle peut le demander et il s'exécute).
    expect(received.tools).toEqual([...REMOTE_SAFE_TOOLS]);
    expect(received.noms.sort()).toEqual([...REMOTE_SAFE_TOOLS].sort());
    expect(received.tools).toContain("generer_image");

    // ③ L'outil a réellement été appelé, avec la scène demandée… et il a TOURNÉ.
    //    ⚠️ Correctif du 2026-11-02 : sous `chat.remoteAgents = desactive` (le
    //    DÉFAUT), `delegate` n'existe pas — refuser l'appel supprimait donc la
    //    génération d'image en canal (« avant, une génération courte passait »).
    expect(received.scene).toBe("un chat roux sur un clavier");
    expect(received.refus ?? "").not.toContain("Rien n'a été lancé");
    expect(imagesVues).toHaveLength(1);
    expect(depot.service.listForSession(CONVERSATION)).toHaveLength(1);
    expect(fixture.uploads).toHaveLength(1);

    // ④ ORDRE STRICT : accusé → image → réponse. L'accusé est le premier post et il
    //    porte le texte du MODÈLE (pas la table de repli).
    const [postAck, postImage, postReponse] = fixture.created;
    expect(String(postAck!.message)).toContain("C'est parti.");
    expect(postAck!.file_ids).toBeUndefined();
    expect(postImage!.file_ids).toEqual(["fichier-1"]);
    expect(String(postImage!.message)).toContain("Voici l'image.");
    // ⚠️ L'image déjà publiée n'est PAS réattachée à la réponse (jamais deux fois).
    expect(postReponse!.file_ids).toBeUndefined();
    expect(String(postReponse!.message)).toContain("Voilà l'image demandée.");
    // ⚠️ La ligne d'accusé a DÉJÀ été publiée : elle ne figure pas dans la réponse.
    expect(String(postReponse!.message)).not.toContain("C'est parti.");
    expect(fixture.created).toHaveLength(3);

    // ⑤ TIMING — le point du 2026-11-02 13:38 : un accusé publié APRÈS le travail
    //    n'est plus un accusé. L'accusé doit partir PENDANT l'outil, à moins d'une
    //    seconde de son démarrage (l'outil, lui, dure `DUREE_GENERATION_MS`).
    const debutOutil = received.debutOutil ?? 0;
    const finOutil = received.finOutil ?? 0;
    expect(finOutil - debutOutil).toBeGreaterThanOrEqual(DUREE_GENERATION_MS);
    const delaiAck = fixture.arrivees[0]! - debutOutil;
    expect(delaiAck).toBeLessThan(ACK_MAX_DELAI_MS);
    // Preuve que l'accusé n'a PAS attendu la fin de l'outil.
    expect(fixture.arrivees[0]!).toBeLessThan(finOutil);
    // L'image arrive APRÈS la fin de la génération, la réponse après l'image.
    expect(fixture.arrivees[1]!).toBeGreaterThanOrEqual(finOutil);
    expect(fixture.arrivees[2]!).toBeGreaterThanOrEqual(fixture.arrivees[1]!);
  });
});
