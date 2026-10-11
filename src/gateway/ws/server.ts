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
import type { SessionPinStore } from "../../pi/session-pins.js";
import type {
  ApprovalGatewayPort,
  ExecutionOutcome,
  PendingApprovalView,
  ScreenshotGatewayPort,
} from "../../agents/execution.js";
import type { Logger } from "../../observability/logger.js";
import { TtsPipeline, type TtsPipelineDeps } from "../../tts/index.js";
import {
  parseClientMessage,
  type ApprovalResultFrame,
  type ClientMessage,
  type ServerEnvelope,
  type ServerFrame,
  type ServerMessage,
  type WireAgent,
  type WireSession,
} from "./protocol.js";
import type { AgentLevel } from "../../agents/types.js";
import { SessionStreamStore } from "./session-stream.js";
import type { Transport, TransportStats } from "./transport.js";

export const WS_PATH = "/ws";

/**
 * Port du registre d'agents exposé au transport (encart de la barre latérale).
 * Découplé du domaine `agents` : le transport ne connaît que ce contrat.
 */
export interface AgentsGatewayPort {
  /** Résumé des agents appairés (actifs ET révoqués). */
  list(): WireAgent[];
  /**
   * Applique on/off : `false` ⇒ niveau `disabled`, `true` ⇒ niveau précédent
   * mémorisé (ou défaut). Lève si l'agent est inconnu.
   */
  setEnabled(agentId: string, enabled: boolean): void;
  /**
   * Règle DIRECTEMENT le niveau de confirmation (menu contextuel de l'agent).
   * ⚠️ MÊME état que le on/off : `disabled` = off ; un autre niveau = on (le
   * niveau mémorisé pour la bascule on/off est mis à jour par le store).
   */
  setLevel(agentId: string, level: AgentLevel): void;
  /** S'abonne aux changements du registre. Renvoie le désabonnement. */
  subscribe(listener: () => void): () => void;
}

/**
 * Ordre d'affichage de la barre latérale : les conversations ÉPINGLÉES d'abord,
 * puis les autres par date décroissante. Les fiches sans date finissent en bas.
 * Fonction PURE (testable) ; `Array.sort` est stable, l'ordre d'entrée départage.
 */
export function orderSessions(sessions: WireSession[]): WireSession[] {
  return [...sessions].sort((a, b) => {
    const pinnedA = a.pinned ? 1 : 0;
    const pinnedB = b.pinned ? 1 : 0;
    if (pinnedA !== pinnedB) return pinnedB - pinnedA;
    const ta = a.updatedAt ?? "";
    const tb = b.updatedAt ?? "";
    if (ta === tb) return 0;
    return ta < tb ? 1 : -1; // décroissant
  });
}

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
  /**
   * Demandes de validation humaine (D118) affichées DANS la conversation.
   * Absent ⇒ aucun bloc de validation (comportement inchangé).
   */
  approvals?: ApprovalGatewayPort;
  /**
   * Captures d'écran affichées DANS la conversation (image ÉPHÉMÈRE). Absent ⇒
   * aucune trame `screenshot` (comportement inchangé).
   */
  screenshots?: ScreenshotGatewayPort;
  /**
   * Épinglage des conversations. Absent ⇒ aucune conversation épinglable (la
   * trame `sessions` n'embarque alors aucun état `pinned`).
   */
  pins?: SessionPinStore;
  /**
   * Registre d'agents (encart de la barre latérale). Absent ⇒ aucune trame
   * `agents` (comportement inchangé).
   */
  agents?: AgentsGatewayPort;
}

interface ClientState {
  ws: WebSocket;
  /** Session FOCALISÉE (cible des envois, de l'abort et des validations). */
  sessionId?: string;
  /** Curseur de rejeu de la session FOCALISÉE (reconnexion). */
  lastSeq: number;
  greeted: boolean;
  /**
   * E2 — abonnements aux flux, PAR SESSION (multiplexage). Le client suit
   * TOUTES les conversations listées EN PLUS de la focalisée : chaque trame
   * arrive avec son `sessionId`, l'UI route vers le store du bon fil —
   * l'activité d'un fil d'arrière-plan reste ainsi VISIBLE sans changer de
   * conversation. `sessionId → désabonnement`.
   */
  subscriptions: Map<string, () => void>;
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
    case "job_activity":
      // E3 — activité d'un sous-agent : trame de CONTRÔLE dédiée (jamais
      // bufferisée, jamais envoyée à `routeTtsEvent`).
      return {
        type: "job_activity",
        jobId: event.jobId,
        stage: event.stage,
        ...(event.task !== undefined ? { task: event.task } : {}),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
        at: event.at,
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

/** Résultat d'exécution converti en trame éphémère pour la conversation. */
export function toApprovalResultFrame(
  approval: PendingApprovalView,
  outcome: ExecutionOutcome,
): ApprovalResultFrame {
  return {
    id: approval.id,
    agentId: outcome.agentId,
    ...(outcome.agentName ? { agentName: outcome.agentName } : {}),
    command: outcome.command,
    status: outcome.status,
    // « ok » = la commande a réellement été exécutée (statut terminal normal).
    ok: outcome.status === "completed",
    exitCode: outcome.exitCode,
    message: outcome.message,
    ...(outcome.framed ? { output: outcome.framed } : {}),
    ...(outcome.durationMs !== undefined ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.truncated !== undefined ? { truncated: outcome.truncated } : {}),
    ...(outcome.timedOut !== undefined ? { timedOut: outcome.timedOut } : {}),
  };
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
  const approvals = options.approvals;
  const pins = options.pins;
  const agentPort = options.agents;
  const screenshots = options.screenshots;

  const runT0 = new Map<string, number>();
  const unsubscribeHost = host.subscribeAll((event) => {
    // ⚠️ E3 — L'ACTIVITÉ D'UN SOUS-AGENT est ÉPHÉMÈRE et MUETTE. Elle ne doit
    // NI entrer dans le flux bufferisé (rejeu/snapshot/transcript) NI atteindre
    // le moteur TTS. On la déroute AVANT `streams.append` et AVANT
    // `routeTtsEvent`, vers une trame de CONTRÔLE rattachée à la conversation
    // qui l'a lancée : c'est CE mécanisme (et lui seul) qui garantit le silence.
    if (event.type === "job_activity") {
      broadcastControl(event.sessionId, toServerMessage(event));
      return;
    }
    streams.get(event.sessionId).append(toServerMessage(event));
    routeTtsEvent(event);
  });

  let wss: WebSocketServer | undefined;
  let httpServer: Server | undefined;
  let closed = false;

  function sessionIdFor(client: ClientState): string | undefined {
    return client.sessionId ?? host.currentSessionId();
  }

  /** Abonne le client au flux d'UNE session (idempotent). */
  function subscribeTo(client: ClientState, sessionId: string): void {
    if (client.subscriptions.has(sessionId)) return;
    const stream = streams.get(sessionId);
    client.subscriptions.set(
      sessionId,
      stream.subscribe((frame) => sendFrame(client, frame)),
    );
  }

  /** (Re)branche le client sur le flux de sa session FOCALISÉE (au moins elle). */
  function subscribeFocused(client: ClientState): void {
    const sessionId = sessionIdFor(client);
    if (sessionId) subscribeTo(client, sessionId);
  }

  /**
   * E2 — aligne les abonnements du client sur l'ensemble
   * « {sessions listées} ∪ {session focalisée} ». Chaque conversation de la
   * barre latérale devient un flux SUIVI : ses trames (état, jobs, deltas)
   * arrivent avec leur `sessionId` et sont routées vers le store du bon fil.
   * Les abonnements aux sessions disparues (mises de côté) sont retirés.
   */
  function syncSubscriptions(
    client: ClientState,
    listedSessionIds: string[],
  ): void {
    const wanted = new Set(listedSessionIds);
    if (client.sessionId) wanted.add(client.sessionId);
    for (const [sessionId, unsubscribe] of [...client.subscriptions]) {
      if (wanted.has(sessionId)) continue;
      unsubscribe();
      client.subscriptions.delete(sessionId);
    }
    for (const sessionId of wanted) subscribeTo(client, sessionId);
  }

  /**
   * E2 — resynchronise les abonnements depuis la liste des conversations SANS
   * envoyer de trame `sessions` (reconnexion `resume` : la trame de liste ne
   * doit pas perturber le curseur `seq` du rejeu).
   */
  async function syncSubscriptionsFromHost(client: ClientState): Promise<void> {
    let ids: string[] = [];
    try {
      ids = (await host.listSessions()).map((info) => info.sessionId);
    } catch (error) {
      logger.warn("ws.subscriptions.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      subscribeFocused(client);
      return;
    }
    syncSubscriptions(client, ids);
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

  /** Diffuse une trame binaire `YTA1` aux clients ABONNÉS à la session (§4.5). */
  function broadcastBinary(sessionId: string, frame: Buffer): void {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      // E2 : on identifie les destinataires par leur ABONNEMENT (multiplexage)
      // et non par la session focalisée. La SOURCE reste la seule session
      // FOCALISÉE du host (`routeTtsEvent`) : un fil d'arrière-plan ne produit
      // donc AUCUNE trame audio (pas de double voix).
      if (!client.subscriptions.has(sessionId)) continue;
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
    // ⚠️ E0 : plusieurs conversations peuvent avoir un run EN VOL simultanément
    // (registre de sessions). La VOIX ne suit QUE la conversation FOCALISÉE :
    // les runs d'arrière-plan continuent d'émettre pour LEUR flux (rejeu au
    // retour) mais restent MUETS. Sans ce garde, deux runs simultanés
    // alimenteraient la TTS d'un fil avec la sortie d'un autre (double voix).
    if (event.sessionId !== host.currentSessionId()) return;
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

  /**
   * E2 — le FOCUS change de conversation : la voix du fil quitté s'arrête.
   * Indispensable avec l'abonnement multiple : sinon les segments du fil
   * quitté, encore en file, seraient livrés (via `broadcastBinary` par
   * abonnement) alors que l'utilisateur regarde un AUTRE fil — double voix.
   */
  function cancelTtsOnFocusChange(previousSessionId: string | undefined): void {
    if (!tts || !previousSessionId) return;
    if (previousSessionId === host.currentSessionId()) return;
    tts.cancel(previousSessionId);
  }

  // ── Validations humaines dans la conversation (D118) ────────────────────
  // Le registre diffuse `requested`/`decided` ; on route vers les clients de
  // la SEULE conversation concernée. Les décisions prises AILLEURS (page
  // /config, route HTTP) font aussi disparaître le bloc ici, via `decided`.
  const unsubscribeApprovals = approvals?.subscribeApprovals((event) => {
    const sessionId = event.approval.sessionId;
    if (!sessionId) return;
    if (event.kind === "requested") {
      broadcastControl(sessionId, { type: "approval", approval: event.approval });
    } else {
      broadcastControl(sessionId, { type: "approval_cleared", id: event.approval.id });
    }
  });

  // ── Captures d'écran dans la conversation (image ÉPHÉMÈRE) ──────────────
  // L'image voyage par une trame de CONTRÔLE vers les clients de la SEULE
  // conversation demanderesse : aucun `seq` consommé, jamais bufferisée, donc
  // jamais dans le rejeu, le snapshot, le transcript ou la mémoire.
  const unsubscribeScreenshots = screenshots?.subscribeScreenshots((event) => {
    const sessionId = event.screenshot.sessionId;
    if (!sessionId) return;
    broadcastControl(sessionId, { type: "screenshot", screenshot: event.screenshot });
  });

  // ── Encart agents de la barre latérale ─────────────────────────────────
  // Diffusion ÉVÉNEMENTIELLE : le registre change (aussi bien depuis /config que
  // depuis l'encart lui-même) et on pousse l'état à TOUS les clients. Aucun
  // polling : la page apprend les changements au fil de l'eau.
  const unsubscribeAgents = agentPort?.subscribe(() => {
    broadcastAgents();
  });

  /** Diffuse l'état des agents (trame de CONTRÔLE, aucun `seq` consommé). */
  function broadcastAgents(): void {
    if (!agentPort) return;
    const agents = agentPort.list();
    for (const client of clients) sendDirect(client, { type: "agents", agents });
  }

  /** Envoie l'état des agents au seul client (connexion / reprise). */
  function sendAgents(client: ClientState): void {
    if (!agentPort) return;
    sendDirect(client, { type: "agents", agents: agentPort.list() });
  }

  /** Décision humaine (Valider / Refuser) reçue depuis la conversation. */
  async function handleApprovalDecision(
    client: ClientState,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type !== "approval_decision") return;
    if (!approvals) {
      sendDirect(client, {
        type: "error",
        code: "approval_unavailable",
        message: "Les validations ne sont pas disponibles.",
      });
      return;
    }
    let result;
    try {
      result = await approvals.decideApproval(message.id, message.decision);
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "approval_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!result.ok) {
      // Clic tardif (déjà décidée/expirée) : on retire le bloc devenu obsolète
      // puis on renvoie un message HONNÊTE, aucun mensonge.
      sendDirect(client, { type: "approval_cleared", id: message.id });
      sendDirect(client, {
        type: "error",
        code: result.code,
        message: result.message,
      });
      return;
    }
    const sessionId = result.approval.sessionId ?? sessionIdFor(client);
    if (!sessionId) return;
    // Idempotent : `decided` a pu déjà diffuser le retrait. On le refait pour le
    // chemin local (et pour un port sans diffusion d'événement).
    broadcastControl(sessionId, { type: "approval_cleared", id: result.approval.id });
    if (result.decision === "approve") {
      broadcastControl(sessionId, {
        type: "approval_result",
        result: toApprovalResultFrame(result.approval, result.outcome),
      });
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

  /**
   * Trame de CONTRÔLE portant l'enveloppe d'UNE session donnée (et non celle de
   * la session focalisée du client). Ne consomme aucun `seq`.
   */
  function sendControl(
    client: ClientState,
    sessionId: string,
    message: ServerMessage,
  ): void {
    sendFrame(client, { ...envelopeFor(sessionId), ...message } as ServerFrame);
  }

  /**
   * Diffuse une trame de CONTRÔLE aux clients ABONNÉS à UNE session (jamais aux
   * autres). Sert aux états éphémères (validation humaine, capture d'écran) :
   * l'enveloppe porte l'identifiant de la session CONCERNÉE (l'UI sait de quel
   * fil vient la demande), ils ne consomment aucun `seq`, ne sont jamais
   * bufferisés et donc n'entrent NI dans le rejeu NI dans un snapshot.
   */
  function broadcastControl(sessionId: string, message: ServerMessage): void {
    for (const client of clients) {
      if (!client.subscriptions.has(sessionId)) continue;
      sendControl(client, sessionId, message);
    }
  }

  /**
   * Ré-affiche les demandes de validation EN ATTENTE de la conversation du
   * client (état VIVANT : reconnexion, bascule, création). Une demande décidée
   * ou expirée n'est plus dans le registre ⇒ elle ne réapparaît pas.
   */
  function sendPendingApprovals(client: ClientState): void {
    if (!approvals) return;
    // E2 : les demandes EN ATTENTE de TOUTES les conversations suivies sont
    // ré-affichées (chacune portant son `sessionId`) — l'UI indique de quel fil
    // vient chaque demande.
    const sessionIds = new Set(client.subscriptions.keys());
    if (client.sessionId) sessionIds.add(client.sessionId);
    for (const sessionId of sessionIds) {
      for (const approval of approvals.pendingApprovals(sessionId)) {
        sendControl(client, sessionId, { type: "approval", approval });
      }
    }
  }

  /** Liste des conversations + conversation active, envoyée au client. */
  async function sendSessions(client: ClientState): Promise<void> {
    let sessions: WireSession[] = [];
    let listed = false;
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
        ...(pins?.isPinned(info.sessionId) ? { pinned: true } : {}),
      }));
      // Épinglées d'abord, puis date décroissante (ordre autoritatif, poussé au
      // client : la barre latérale se contente de refléter cette liste).
      sessions = orderSessions(sessions);
      listed = true;
    } catch (error) {
      logger.warn("ws.sessions.list_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // E2 : la liste EST la source de vérité des conversations suivies ⇒ on y
    // aligne les abonnements. En cas d'échec de lecture, on garde au moins la
    // session focalisée (jamais zéro abonnement).
    if (listed) syncSubscriptions(client, sessions.map((s) => s.id));
    else subscribeFocused(client);
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
    subscribeFocused(client);
    sendDirect(client, { type: "welcome", serverVersion, resumed });
    await sendSessions(client);
    // État initial des agents (encart de la barre latérale), à la connexion.
    sendAgents(client);
    // État initial autoritatif : le client initialise son rendu depuis le snapshot.
    sendSnapshotForCurrent(client);
    // État VIVANT : les validations en attente de ce fil sont ré-affichées.
    sendPendingApprovals(client);
  }

  async function handleResume(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "resume") return;
    const previousFocus = host.currentSessionId();
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
    subscribeFocused(client);
    // La voix du fil quitté s'arrête (E2) : un seul fil parle.
    cancelTtsOnFocusChange(previousFocus);
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
    if (switched) {
      await sendSessions(client);
    } else {
      // Reconnexion sur la même session : on resynchronise SILENCIEUSEMENT les
      // abonnements (toutes les conversations listées) sans envoyer de trame
      // `sessions` (elle ne doit pas troubler le curseur `seq` du rejeu).
      await syncSubscriptionsFromHost(client);
    }
    // Reconnexion : on RE-pousse l'état des agents (il a pu changer pendant la coupure).
    sendAgents(client);
    // Ré-affichage des validations en attente (état vivant, jamais l'historique).
    sendPendingApprovals(client);
  }

  /** Bascule vers une autre conversation (abort du run en cours par construction). */
  async function handleSwitch(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "switch") return;
    const previousFocus = host.currentSessionId();
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
    subscribeFocused(client);
    // E2 : la voix du fil quitté s'arrête net (jamais de double voix).
    cancelTtsOnFocusChange(previousFocus);
    await sendSessions(client);
    // ⚠️ Un `snapshot` à CHAQUE bascule : le client reconstruit TOUT son rendu
    // depuis le transcript du nouveau fil → aucun doublon possible.
    sendSnapshotForCurrent(client);
    sendPendingApprovals(client);
  }

  /** Crée une nouvelle conversation et la rend active. */
  async function handleNew(client: ClientState): Promise<void> {
    const previousFocus = host.currentSessionId();
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
    subscribeFocused(client);
    cancelTtsOnFocusChange(previousFocus);
    await sendSessions(client);
    sendSnapshotForCurrent(client);
    sendPendingApprovals(client);
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
      // La voix du fil supprimé s'arrête (E2).
      cancelTtsOnFocusChange(message.sessionId);
    }
    // Nettoyage de l'épingle orpheline : la conversation mise de côté disparaît
    // de la liste, son éventuel épinglage n'a plus de sens.
    pins?.remove(message.sessionId);
    // E2 : `sendSessions` resynchronise les abonnements ⇒ le flux de la
    // conversation retirée est désabonné automatiquement.
    await sendSessions(client);
    if (wasCurrent) {
      // Snapshot VIDE : le rendu du fil est réinitialisé, plus rien à l'écran.
      sendDirect(client, { type: "snapshot", state: "idle", transcript: [] });
    }
  }

  /**
   * Épingle / désépingle une conversation (action du menu contextuel). L'état
   * n'est PAS écrit dans le JSONL de session (propriété du SDK) : il vit dans le
   * store d'épingles, puis la liste est renvoyée avec son nouvel état.
   */
  async function handlePin(client: ClientState, message: ClientMessage): Promise<void> {
    if (message.type !== "pin") return;
    pins?.setPinned(message.sessionId, message.pinned);
    await sendSessions(client);
  }

  /**
   * Bascule on/off d'un agent depuis l'encart de la barre latérale. Le NIVEAU
   * existant est réutilisé (`disabled` ⇄ précédent) : aucun second drapeau.
   */
  function handleAgentEnabled(client: ClientState, message: ClientMessage): void {
    if (message.type !== "agent_enabled") return;
    if (!agentPort) {
      sendDirect(client, {
        type: "error",
        code: "agents_unavailable",
        message: "Les agents ne sont pas disponibles.",
      });
      return;
    }
    try {
      agentPort.setEnabled(message.agentId, message.enabled);
      // Le store notifie ses abonnés → diffusion de la trame `agents` à tous.
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "agent_unknown",
        message: error instanceof Error ? error.message : "Agent inconnu.",
      });
    }
  }

  /**
   * Règle le niveau de confirmation d'un agent depuis le menu contextuel de
   * l'encart de la barre latérale. ⚠️ Pas un second état : `disabled` = off.
   */
  function handleAgentLevel(client: ClientState, message: ClientMessage): void {
    if (message.type !== "agent_level") return;
    if (!agentPort) {
      sendDirect(client, {
        type: "error",
        code: "agents_unavailable",
        message: "Les agents ne sont pas disponibles.",
      });
      return;
    }
    try {
      agentPort.setLevel(message.agentId, message.level);
      // Le store notifie ses abonnés → diffusion de la trame `agents` à tous.
    } catch (error) {
      sendDirect(client, {
        type: "error",
        code: "agent_unknown",
        message: error instanceof Error ? error.message : "Agent inconnu.",
      });
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
    subscribeFocused(client);
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
      case "pin":
        await handlePin(client, message);
        return;
      case "agent_enabled":
        handleAgentEnabled(client, message);
        return;
      case "agent_level":
        handleAgentLevel(client, message);
        return;
      case "approval_decision":
        await handleApprovalDecision(client, message);
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
    const client: ClientState = {
      ws,
      lastSeq: 0,
      greeted: false,
      subscriptions: new Map(),
    };
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
      // E2 : on retire TOUS les abonnements du client (multiplexage).
      for (const unsubscribe of client.subscriptions.values()) unsubscribe();
      client.subscriptions.clear();
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
      unsubscribeApprovals?.();
      unsubscribeAgents?.();
      unsubscribeScreenshots?.();
      tts?.cancelAll();
      if (httpServer) {
        httpServer.off("upgrade", onUpgrade);
        httpServer = undefined;
      }
      for (const client of clients) {
        for (const unsubscribe of client.subscriptions.values()) unsubscribe();
        client.subscriptions.clear();
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
