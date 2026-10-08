/**
 * Transport WebSocket du gateway.
 *
 * - hook `upgrade` sur le serveur HTTP, chemin `/ws` uniquement ;
 * - cycle de vie des clients (`hello`, `resume`, `message`, `abort`, `ping`) ;
 * - fermeture propre (trame `bye` puis `close`) AVANT `server.close()`.
 *
 * Le buffer de rejeu et le compteur `seq` vivent dans `./session-stream.ts`,
 * au-dessus de l'abonnement au PiHost : les événements émis sans client
 * connecté sont déjà bufferisés.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { toPiHostError } from "../../pi/errors.js";
import { PHASE, type PiEvent, type PiHost } from "../../pi/index.js";
import type { Logger } from "../../observability/logger.js";
import { TtsPipeline, type TtsPipelineDeps } from "../../tts/index.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerEnvelope,
  type ServerFrame,
  type ServerMessage,
  type WireSession,
} from "./protocol.js";
import { SessionStreamStore } from "./session-stream.js";
import type { Transport, TransportStats } from "./transport.js";

export const WS_PATH = "/ws";

export interface WsTransportOptions {
  host: PiHost;
  logger: Logger;
  serverVersion: string;
  replayBufferSize: number;
  replayBufferBytes: number;
  now?: () => number;
  /**
   * Lot 7 : dépendances du pipeline TTS. Absent ⇒ aucune trame audio (comportement
   * strictement identique aux lots précédents).
   */
  tts?: TtsPipelineDeps;
}

interface ClientState {
  ws: WebSocket;
  sessionId?: string;
  lastSeq: number;
  greeted: boolean;
  unsubscribeStream?: () => void;
  subscribedSession?: string;
}

/** Traduit un événement de façade en trame serveur. */
export function toServerMessage(event: PiEvent): ServerMessage {
  switch (event.type) {
    case "run_started":
      return {
        type: "run_started",
        runId: event.runId,
        ...(event.userText !== undefined ? { userText: event.userText } : {}),
        ...(event.origin !== undefined ? { origin: event.origin } : {}),
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {}),
      };
    case "delta":
      return {
        type: "delta",
        runId: event.runId,
        channel: event.channel,
        text: event.text,
      };
    case "run_finished":
      return {
        type: "run_finished",
        runId: event.runId,
        reason: event.reason,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
      };
    case "phase":
      return {
        type: "phase",
        runId: event.runId,
        stage: event.stage,
        at: event.at,
        sinceT0Ms: event.sinceT0Ms,
        ...(event.jobId !== undefined ? { jobId: event.jobId } : {}),
      };
    case "job_started":
      return {
        type: "job_started",
        jobId: event.jobId,
        ...(event.task !== undefined ? { task: event.task } : {}),
      };
    case "job_finished":
      return {
        type: "job_finished",
        jobId: event.jobId,
        status: event.status,
      };
    case "job_report":
      return {
        type: "job_report",
        jobId: event.jobId,
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
      };
    case "run_summary":
      return {
        type: "run_summary",
        runId: event.runId,
        ...(event.ttftMs !== undefined ? { ttftMs: event.ttftMs } : {}),
        totalMs: event.totalMs,
        ...(event.tokensIn !== undefined ? { tokensIn: event.tokensIn } : {}),
        ...(event.tokensOut !== undefined ? { tokensOut: event.tokensOut } : {}),
        ...(event.ttfaMs !== undefined ? { ttfaMs: event.ttfaMs } : {}),
        ...(event.ttsSynthMs !== undefined ? { ttsSynthMs: event.ttsSynthMs } : {}),
        ...(event.ttsSegments !== undefined ? { ttsSegments: event.ttsSegments } : {}),
      };
    case "state":
      return {
        type: "state",
        state: event.state,
        ...(event.activeRunId ? { activeRunId: event.activeRunId } : {}),
      };
    default: {
      const exhaustive: never = event;
      throw new Error(`Événement Pi inconnu : ${String(exhaustive)}`);
    }
  }
}

/** Crée le transport WebSocket et l'abonne au PiHost. */
export function createWsTransport(options: WsTransportOptions): Transport {
  const { host, logger, serverVersion } = options;
  const streams = new SessionStreamStore({
    bufferSize: options.replayBufferSize,
    bufferBytes: options.replayBufferBytes,
    ...(options.now ? { now: options.now } : {}),
    snapshotSource: (sessionId) => host.getState(sessionId),
  });
  const clients = new Set<ClientState>();

  const runT0 = new Map<string, number>();
  const unsubscribeHost = host.subscribeAll((event) => {
    streams.get(event.sessionId).append(toServerMessage(event));
    routeTtsEvent(event);
  });

  let wss: WebSocketServer | undefined;
  let httpServer: Server | undefined;
  let closed = false;

  function sessionIdFor(client: ClientState): string | undefined {
    return client.sessionId ?? host.currentSessionId();
  }

  /** (Re)branche le client sur le flux de sa session courante. */
  function ensureSubscribed(client: ClientState): void {
    const sessionId = sessionIdFor(client);
    if (!sessionId) return;
    if (client.subscribedSession === sessionId) return;
    client.unsubscribeStream?.();
    const stream = streams.get(sessionId);
    client.unsubscribeStream = stream.subscribe((frame) => sendFrame(client, frame));
    client.subscribedSession = sessionId;
  }

  function envelopeFor(sessionId: string | undefined): ServerEnvelope {
    if (!sessionId) {
      return {
        seq: 0,
        ts: new Date().toISOString(),
        sessionId: "",
      };
    }
    return streams.get(sessionId).envelope();
  }

  function sendFrame(client: ClientState, frame: ServerFrame): void {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    try {
      client.ws.send(JSON.stringify(frame));
    } catch (error) {
      logger.warn("ws.send.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Diffuse une trame binaire `YTA1` aux clients de la session (§4.5). */
  function broadcastBinary(sessionId: string, frame: Buffer): void {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (sessionIdFor(client) !== sessionId) continue;
      try {
        client.ws.send(frame, { binary: true });
      } catch (error) {
        logger.warn("ws.send.binary.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const tts = options.tts
    ? new TtsPipeline(options.tts, {
        emitAudio: (sessionId, frame) => broadcastBinary(sessionId, frame),
        emitControl: (sessionId, frame) => broadcastBinary(sessionId, frame),
        onStage: (sessionId, runId, stage) => {
          host.recordRunStage?.(sessionId, runId, stage);
        },
        onMetrics: (sessionId, runId, metrics) => {
          host.recordRunTtsMetrics?.(sessionId, runId, metrics);
        },
      })
    : undefined;

  /**
   * Achemine un événement Pi vers le pipeline TTS (hors chemin critique).
   * `t0` est reconstruit depuis le premier `phase` corrélé du run.
   */
  function routeTtsEvent(event: PiEvent): void {
    if (!tts) return;
    switch (event.type) {
      case "phase":
        if (!runT0.has(event.runId)) {
          runT0.set(
            event.runId,
            (options.now?.() ?? Date.now()) - event.sinceT0Ms,
          );
        }
        return;
      case "run_started":
        tts.onRunStarted(event.sessionId, event.runId, runT0.get(event.runId));
        return;
      case "delta":
        if (event.channel === "content") {
          tts.onContent(event.sessionId, event.runId, event.text);
        }
        return;
      case "run_finished":
        tts.onRunFinished(event.sessionId, event.runId, event.reason);
        runT0.delete(event.runId);
        return;
      default:
        return;
    }
  }

  /** Trame de contrôle : réutilise le `seq` courant sans le consommer. */
  function sendDirect(client: ClientState, message: ServerMessage): ServerFrame {
    const frame = {
      ...envelopeFor(sessionIdFor(client)),
      ...message,
    } as ServerFrame;
    sendFrame(client, frame);
    return frame;
  }

  /** Liste des conversations + conversation active, envoyée au client. */
  async function sendSessions(client: ClientState): Promise<void> {
    let sessions: WireSession[] = [];
    try {
      const list = await host.listSessions();
      sessions = list.map((info) => ({
        id: info.sessionId,
        title: info.title ?? info.name ?? "Conversation sans titre",
        ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
        messageCount: info.messageCount ?? 0,
        ...(info.firstMessage && info.firstMessage !== "(no messages)"
          ? { excerpt: info.firstMessage }
          : {}),
      }));
    } catch (error) {
      logger.warn("ws.sessions.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    sendDirect(client, {
      type: "sessions",
      sessions,
      activeId: host.currentSessionId() ?? null,
    });
  }

  /**
   * Snapshot autoritatif de la session courante du client. Sans session
   * courante (état « aucune conversation ouverte »), envoie un snapshot VIDE :
   * le client réinitialise son rendu, aucun message ne part dans le vide.
   */
  function sendSnapshotForCurrent(client: ClientState): void {
    const sessionId = sessionIdFor(client);
    if (!sessionId) {
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
      return;
    }
    const snapshot = streams.get(sessionId).snapshot();
    const frame = sendDirect(client, {
      type: "snapshot",
      state: snapshot.state,
      ...(snapshot.activeRunId ? { activeRunId: snapshot.activeRunId } : {}),
      transcript: snapshot.transcript,
    });
    client.lastSeq = frame.seq;
  }

  async function handleHello(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "hello") return;
    const current = host.currentSessionId();
    const resumed = Boolean(
      message.sessionId && current && message.sessionId === current,
    );
    // ⚠️ TROU #1 CORRIGÉ : on n'impose plus un fil choisi par le client à la
    // connexion. `hello` renvoie l'ÉTAT AUTORITATIF (liste + active), et le
    // client adopte un autre fil par la trame dédiée `switch`.
    client.sessionId = current;
    client.greeted = true;
    ensureSubscribed(client);
    sendDirect(client, { type: "welcome", serverVersion, resumed });
    await sendSessions(client);
    // État initial autoritatif : le client initialise son rendu depuis le snapshot.
    sendSnapshotForCurrent(client);
  }

  async function handleResume(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "resume") return;
    const target = message.sessionId || host.currentSessionId();
    if (!target) {
      sendDirect(client, {
        type: "error",
        code: "session_inconnue",
        message: "Aucune conversation à reprendre.",
      });
      return;
    }
    // ⚠️ TROU #2 CORRIGÉ : la bascule doit RÉELLEMENT changer la session HÔTE
    // (`host.resume`), pas seulement l'abonnement au flux — sinon le 1er
    // message échouerait « Session inconnue ». On ne le fait que si la session
    // demandée n'est pas déjà la courante (reconnexion = no-op).
    let switched = false;
    if (host.currentSessionId() !== target) {
      const file = await host.sessionFileFor(target);
      if (!file) {
        sendDirect(client, {
          type: "error",
          code: "session_inconnue",
          message: "Conversation introuvable.",
        });
        return;
      }
      try {
        await host.resume(file);
        switched = true;
      } catch (error) {
        const piError = toPiHostError(error, { sessionId: target, logger });
        sendDirect(client, {
          type: "error",
          code: piError.code,
          message: piError.message,
        });
        return;
      }
    }
    client.sessionId = host.currentSessionId() ?? target;
    ensureSubscribed(client);
    const stream = streams.get(client.sessionId);
    const result = stream.replay(message.fromSeq);
    sendDirect(client, {
      type: "welcome",
      serverVersion,
      resumed: true,
      replayFrom: message.fromSeq,
    });
    if (result.mode === "snapshot") {
      const frame = sendDirect(client, {
        type: "snapshot",
        state: result.snapshot.state,
        ...(result.snapshot.activeRunId
          ? { activeRunId: result.snapshot.activeRunId }
          : {}),
        transcript: result.snapshot.transcript,
      });
      client.lastSeq = frame.seq;
    } else {
      for (const frame of result.frames) {
        sendFrame(client, frame);
        client.lastSeq = frame.seq;
      }
    }
    // Uniquement si la session hôte a CHANGÉ : rafraîchit la barre latérale.
    if (switched) await sendSessions(client);
  }

  /** Bascule vers une autre conversation (abort du run en cours par construction). */
  async function handleSwitch(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "switch") return;
    const file = await host.sessionFileFor(message.sessionId);
    if (!file) {
      sendDirect(client, {
        type: "error",
        code: "session_inconnue",
        message: "Conversation introuvable.",
      });
      return;
    }
    try {
      await host.resume(file);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    client.sessionId = host.currentSessionId() ?? message.sessionId;
    ensureSubscribed(client);
    await sendSessions(client);
    // ⚠️ Un `snapshot` à CHAQUE bascule : le client reconstruit TOUT son rendu
    // depuis le transcript du nouveau fil → aucun doublon possible.
    sendSnapshotForCurrent(client);
  }

  /** Crée une nouvelle conversation et la rend active. */
  async function handleNew(client: ClientState): Promise<void> {
    try {
      await host.newSession();
    } catch (error) {
      const piError = toPiHostError(error, { logger });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    client.sessionId = host.currentSessionId();
    ensureSubscribed(client);
    await sendSessions(client);
    sendSnapshotForCurrent(client);
  }

  /** Renomme une conversation (doublons refusés côté hôte). */
  async function handleRename(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "rename") return;
    try {
      await host.renameSession(message.sessionId, message.title);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    await sendSessions(client);
  }

  /** Met une conversation de côté (déplacement horodaté, récupérable). */
  async function handleSetAside(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "setAside") return;
    const wasCurrent = host.currentSessionId() === message.sessionId;
    try {
      await host.setAsideSession(message.sessionId);
    } catch (error) {
      const piError = toPiHostError(error, {
        sessionId: message.sessionId,
        logger,
      });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    // Mono-utilisateur : on suit la suppression côté client. Si la conversation
    // supprimée était la conversation OUVERTE, le client retombe sur l'état vide.
    if (wasCurrent) {
      client.sessionId = undefined;
      client.unsubscribeStream?.();
      client.unsubscribeStream = undefined;
      client.subscribedSession = undefined;
    }
    await sendSessions(client);
    if (wasCurrent) {
      // Snapshot VIDE : le rendu du fil est réinitialisé, plus rien à l'écran.
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
    }
  }

  function handleMessage(client: ClientState, message: ClientMessage): void {
    if (message.type !== "message") return;
    const sessionId = sessionIdFor(client);
    if (!sessionId) {
      sendDirect(client, {
        type: "error",
        code: "PI_NOT_READY",
        message: "Aucune session Pi disponible.",
      });
      return;
    }
    ensureSubscribed(client);
    let handle;
    try {
      handle = host.send(
        sessionId,
        message.text,
        message.tz !== undefined ? { timezone: message.tz } : undefined,
      );
    } catch (error) {
      const piError = toPiHostError(error, { sessionId, logger });
      sendDirect(client, {
        type: "error",
        code: piError.code,
        message: piError.message,
      });
      return;
    }
    streams.get(handle.sessionId).append({
      type: "accepted",
      clientMsgId: message.clientMsgId,
      runId: handle.runId,
      queued: handle.queued,
    });
  }

  async function handleClientMessage(client: ClientState, text: string): Promise<void> {
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      sendDirect(client, {
        type: "error",
        code: "bad_request",
        message: parsed.error,
      });
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "hello":
        await handleHello(client, message);
        return;
      case "resume":
        await handleResume(client, message);
        return;
      case "switch":
        await handleSwitch(client, message);
        return;
      case "new":
        await handleNew(client);
        return;
      case "rename":
        await handleRename(client, message);
        return;
      case "setAside":
        await handleSetAside(client, message);
        return;
      case "message":
        handleMessage(client, message);
        return;
      case "abort":
        if (!client.greeted) client.sessionId = host.currentSessionId();
        tts?.cancel(
          client.sessionId ?? host.currentSessionId() ?? "",
          message.runId,
        );
        void host
          .abort(client.sessionId ?? host.currentSessionId() ?? "", message.runId)
          .catch((error: unknown) => {
            logger.warn("ws.abort.failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return;
      case "playback": {
        const sessionId = client.sessionId ?? host.currentSessionId();
        if (sessionId) {
          host.recordRunStage?.(
            sessionId,
            message.runId,
            message.event === "started"
              ? PHASE.playbackStarted
              : PHASE.playbackAborted,
          );
        }
        return;
      }
      case "ping":
        sendDirect(client, { type: "pong", t: message.t });
        return;
      default: {
        const exhaustive: never = message;
        logger.warn("ws.message.unhandled", { type: String(exhaustive) });
      }
    }
  }

  function onConnection(ws: WebSocket): void {
    const client: ClientState = { ws, lastSeq: 0, greeted: false };
    clients.add(client);
    logger.debug("ws.client.connected", { clients: clients.size });

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        // Trames binaires réservées à l'audio (lots 6/7) : ignorées proprement.
        logger.warn("ws.binary.ignored", { clients: clients.size });
        return;
      }
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString();
      void handleClientMessage(client, text).catch((error: unknown) => {
        logger.warn("ws.message.handler_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    ws.on("close", () => {
      client.unsubscribeStream?.();
      clients.delete(client);
      logger.debug("ws.client.closed", { clients: clients.size });
    });
    ws.on("error", (error: Error) => {
      logger.warn("ws.client.error", { error: error.message });
    });
  }

  function onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss?.handleUpgrade(request, socket, head, (ws) => {
      wss?.emit("connection", ws, request);
    });
  }

  return {
    protocol: "ws",

    attach(server: Server): void {
      if (wss) return;
      httpServer = server;
      wss = new WebSocketServer({ noServer: true });
      wss.on("connection", (ws: WebSocket) => onConnection(ws));
      server.on("upgrade", onUpgrade);
    },

    clientCount(): number {
      return clients.size;
    },

    stats(): TransportStats {
      return {
        clients: clients.size,
        replayBufferSize: streams.bufferSize,
        replayBufferBytes: streams.bufferBytes,
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeHost();
      tts?.cancelAll();
      if (httpServer) {
        httpServer.off("upgrade", onUpgrade);
        httpServer = undefined;
      }
      for (const client of clients) {
        sendDirect(client, { type: "bye", reason: "server_shutdown" });
        try {
          client.ws.close(1001, "server_shutdown");
        } catch {
          client.ws.terminate();
        }
      }
      const server = wss;
      wss = undefined;
      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      clients.clear();
    },
  };
}
