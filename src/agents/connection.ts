/**
 * Canal d'exécution Yuki ↔ agent (Lot 4, B6) — un objet par connexion WS
 * authentifiée, plus le registre des connexions vivantes (`AgentHub`).
 *
 * ⚠️ **Yuki décide, l'agent exécute.** Ce module ne fait QUE parler le
 * protocole : envoyer `cmd`, corréler `ack`/`result`/`error`, répondre aux
 * `ping`, et perdre proprement les résultats d'une connexion fermée.
 *
 * Règles implémentées :
 *   - **au plus une fois** : une commande n'est émise qu'UNE fois (pas de
 *     réémission, pas de file) ; l'idempotence repose sur `cmd_id` (UUID minté
 *     par Yuki) ;
 *   - **hors ligne = rejet** (D124) : sans connexion vivante, l'appel échoue
 *     immédiatement ;
 *   - **déconnexion pendant une commande ⇒ `result_lost`** (D124/D127) : la
 *     commande va à son terme côté agent, mais son résultat est perdu.
 */

import type { WebSocket } from "ws";

import { AgentChannelError } from "./errors.js";
import {
  encodeCancelFrame,
  encodeCommandFrame,
  encodeConfigFrame,
  encodePongFrame,
  encodePingFrame,
  encodeScreenshotFrame,
  parseAgentFrame,
  type OutboundCommand,
  type OutboundScreenshot,
  type ResultFrame,
  type ScreenshotDataFrame,
} from "./protocol.js";

export interface ChannelLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Informations de présentation annoncées par l'agent (`hello`). */
export interface AgentHello {
  agentVersion?: string;
  host?: string;
  os?: string;
  arch?: string;
  euid: number;
  caps: string[];
}

/** Marge de sécurité ajoutée au timeout annoncé de la commande. */
export const COMMAND_SAFETY_MARGIN_MS = 30_000;

interface PendingCommand {
  cmdId: string;
  agentId: string;
  sentAt: number;
  acked: boolean;
  resolve: (result: ResultFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface PendingShot {
  cmdId: string;
  agentId: string;
  resolve: (frame: ScreenshotDataFrame) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface AgentConnectionOptions {
  ws: WebSocket;
  agentId: string;
  logger: ChannelLogger;
  now?: () => number;
  /** Appelé à la fermeture (une seule fois). */
  onClose?: (connection: AgentConnection) => void;
  /**
   * Appelé après réception d'un `hello` (présentation de la machine). Sert au
   * pré-remplissage du nom à partir du nom d'hôte (`host`).
   */
  onHello?: (connection: AgentConnection, hello: AgentHello) => void;
}

let socketSeq = 0;

export class AgentConnection {
  readonly agentId: string;
  private readonly ws: WebSocket;
  private readonly logger: ChannelLogger;
  private readonly now: () => number;
  private readonly onCloseCallback?: (connection: AgentConnection) => void;
  private readonly onHelloCallback?: (connection: AgentConnection, hello: AgentHello) => void;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingShots = new Map<string, PendingShot>();

  private hello: AgentHello | null = null;
  private closed = false;
  /** Identifiant croissant : distingue deux connexions successives du même agent. */
  readonly socketId: number;

  constructor(options: AgentConnectionOptions) {
    this.agentId = options.agentId;
    this.ws = options.ws;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.onCloseCallback = options.onClose;
    this.onHelloCallback = options.onHello;
    socketSeq += 1;
    this.socketId = socketSeq;

    this.ws.on("message", (data: Buffer | string) => this.handleMessage(data));
    this.ws.on("close", (code: number) => this.dispose("close", `code=${code}`));
    this.ws.on("error", (error: Error) => {
      this.logger.warn("agents.ws.error", { agent_id: this.agentId, error: error.message });
      this.dispose("error", error.message);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Présentation reçue de l'agent, si reçue. */
  get helloInfo(): AgentHello | null {
    return this.hello;
  }

  /**
   * Capacités DÉCLARÉES par l'agent (`hello`), `[]` tant que le `hello` n'est
   * pas reçu. C'est la SOURCE de vérité : Yuki ne suppose aucune capacité.
   */
  get caps(): string[] {
    return this.hello ? [...this.hello.caps] : [];
  }

  /** `true` si l'agent a déclaré la capacité donnée. */
  hasCapability(name: string): boolean {
    return this.caps.includes(name);
  }

  /** Nombre de commandes en attente d'un résultat. */
  get pendingCount(): number {
    return this.pending.size;
  }

  private ready(): boolean {
    return !this.closed && this.ws.readyState === 1; // WebSocket.OPEN
  }

  /** Traite UNE trame reçue (appelé par l'écouteur `message`). */
  handleMessage(data: Buffer | string): void {
    const parsed = parseAgentFrame(data);
    if (!parsed.ok) {
      this.logger.warn("agents.ws.frame_invalid", {
        agent_id: this.agentId,
        code: parsed.code,
        error: parsed.message,
      });
      return;
    }
    switch (parsed.frame.type) {
      case "hello":
        this.hello = {
          ...(parsed.frame.agentVersion !== undefined
            ? { agentVersion: parsed.frame.agentVersion }
            : {}),
          ...(parsed.frame.host !== undefined ? { host: parsed.frame.host } : {}),
          ...(parsed.frame.os !== undefined ? { os: parsed.frame.os } : {}),
          ...(parsed.frame.arch !== undefined ? { arch: parsed.frame.arch } : {}),
          euid: parsed.frame.euid,
          caps: parsed.frame.caps,
        };
        this.logger.info("agents.ws.hello", {
          agent_id: this.agentId,
          agent_version: parsed.frame.agentVersion ?? null,
          host: parsed.frame.host ?? null,
          os: parsed.frame.os ?? null,
          arch: parsed.frame.arch ?? null,
          euid: parsed.frame.euid,
          // ⚠️ Métadonnées seulement : la LISTE des capacités (jamais un blob).
          caps: parsed.frame.caps,
        });
        // Le `hello` peut porter le nom d'hôte : c'est le signal pour proposer
        // un alias lisible (jamais obligatoire, jamais écrasant).
        try {
          this.onHelloCallback?.(this, this.hello);
        } catch (error) {
          this.logger.warn("agents.ws.hello_callback_failed", {
            agent_id: this.agentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      case "ack": {
        const pending = this.pending.get(parsed.frame.cmdId);
        if (!pending) {
          this.logger.warn("agents.ws.ack_unknown", {
            agent_id: this.agentId,
            cmd_id: parsed.frame.cmdId,
          });
          return;
        }
        pending.acked = true;
        this.logger.debug("agents.ws.ack", {
          agent_id: this.agentId,
          cmd_id: parsed.frame.cmdId,
        });
        return;
      }
      case "result": {
        const pending = this.pending.get(parsed.frame.cmdId);
        if (!pending) {
          this.logger.warn("agents.ws.result_unknown", {
            agent_id: this.agentId,
            cmd_id: parsed.frame.cmdId,
          });
          return;
        }
        this.settle(pending);
        this.logger.info("agents.ws.result", {
          agent_id: this.agentId,
          cmd_id: parsed.frame.cmdId,
          exit_code: parsed.frame.exitCode,
          duration_ms: parsed.frame.durationMs,
          timed_out: parsed.frame.timedOut,
          // ⚠️ Jamais la sortie : uniquement des métadonnées (D127).
          stdout_bytes: Buffer.byteLength(parsed.frame.stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(parsed.frame.stderr, "utf8"),
        });
        pending.resolve(parsed.frame);
        return;
      }
      case "screenshot_data": {
        const pending = this.pendingShots.get(parsed.frame.cmdId);
        if (!pending) {
          this.logger.warn("agents.ws.screenshot_unknown", {
            agent_id: this.agentId,
            cmd_id: parsed.frame.cmdId,
          });
          return;
        }
        this.settleShot(pending);
        // ⚠️ Métadonnées seulement : JAMAIS le contenu base64 de l'image.
        this.logger.info("agents.ws.screenshot", {
          agent_id: this.agentId,
          cmd_id: parsed.frame.cmdId,
          format: parsed.frame.format,
          width: parsed.frame.width,
          height: parsed.frame.height,
          bytes: parsed.frame.bytes,
          data_b64: parsed.frame.data.length,
        });
        pending.resolve(parsed.frame);
        return;
      }
      case "error": {
        const ref = parsed.frame.ref;
        const pending = ref ? this.pending.get(ref) : undefined;
        this.logger.warn("agents.ws.agent_error", {
          agent_id: this.agentId,
          cmd_id: ref ?? null,
          code: parsed.frame.code,
          error: parsed.frame.error,
          message: parsed.frame.message,
        });
        if (pending) {
          this.settle(pending);
          pending.reject(
            new AgentChannelError("agent_error", parsed.frame.message, {
              agentId: this.agentId,
              agentCode: parsed.frame.code,
            }),
          );
        }
        return;
      }
      case "ping":
        // Sonde de vivacité de l'agent : on répond TOUJOURS, sinon l'agent se
        // déclarerait hors ligne au bout de `OfflineAfter`.
        this.send(encodePongFrame(parsed.frame.t, new Date(this.now()).toISOString()));
        return;
      case "pong":
        this.logger.debug("agents.ws.pong", { agent_id: this.agentId, t: parsed.frame.t });
        return;
      case "state":
        this.logger.info("agents.ws.state", {
          agent_id: this.agentId,
          state: parsed.frame.state,
        });
        return;
      default:
        return;
    }
  }

  /** Envoie une trame brute (best-effort silencieux : `false` si fermé). */
  private send(frame: Record<string, unknown>): boolean {
    if (!this.ready()) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.logger.warn("agents.ws.send_failed", {
        agent_id: this.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Envoie une commande et attend `result` (rejette sur `error`, déconnexion,
   * ou dépassement du budget). La commande n'est émise qu'UNE fois.
   */
  sendCommand(cmd: OutboundCommand): Promise<ResultFrame> {
    if (!this.ready()) {
      return Promise.reject(
        new AgentChannelError("agent_offline", "Agent hors ligne.", { agentId: this.agentId }),
      );
    }
    if (this.pending.has(cmd.cmdId)) {
      return Promise.reject(
        new AgentChannelError("send_failed", "Commande déjà en cours.", {
          agentId: this.agentId,
        }),
      );
    }

    return new Promise<ResultFrame>((resolve, reject) => {
      const pending: PendingCommand = {
        cmdId: cmd.cmdId,
        agentId: this.agentId,
        sentAt: this.now(),
        acked: false,
        resolve,
        reject,
      };
      const budget = (cmd.timeoutMs ?? 0) + COMMAND_SAFETY_MARGIN_MS;
      pending.timer = setTimeout(() => {
        if (!this.pending.has(cmd.cmdId)) return;
        this.pending.delete(cmd.cmdId);
        this.logger.warn("agents.ws.command_timeout", {
          agent_id: this.agentId,
          cmd_id: cmd.cmdId,
        });
        reject(
          new AgentChannelError("command_timeout", "Délai dépassé sans résultat.", {
            agentId: this.agentId,
          }),
        );
      }, budget);
      pending.timer.unref?.();
      this.pending.set(cmd.cmdId, pending);

      this.ws.send(JSON.stringify(encodeCommandFrame(cmd)), (error?: Error) => {
        if (!error) return;
        const current = this.pending.get(cmd.cmdId);
        if (!current) return;
        this.settle(current);
        reject(
          new AgentChannelError("send_failed", "Envoi de la commande impossible.", {
            agentId: this.agentId,
          }),
        );
      });
    });
  }

  /** Demande l'annulation d'une commande (best-effort, sans garantie). */
  cancel(cmdId: string, reason?: string): void {
    this.send(encodeCancelFrame(cmdId, reason));
  }

  /** Envoie une sonde de vivacité (découverte/tests). */
  ping(): void {
    this.send(encodePingFrame(this.now()));
  }

  /** Envoie la configuration (niveau + privilège) à l'agent. */
  pushConfig(level: string, privilege: string): void {
    this.send(encodeConfigFrame(level, privilege));
  }

  /** Retire une commande en attente et nettoie son minuteur. */
  private settle(pending: PendingCommand): void {
    this.pending.delete(pending.cmdId);
    if (pending.timer) clearTimeout(pending.timer);
  }

  /**
   * Envoie une demande de capture d'écran et attend `screenshot_data` (rejette
   * sur `error`, déconnexion ou d_budget). La demande n'est émise qu'UNE fois.
   */
  sendScreenshot(shot: OutboundScreenshot): Promise<ScreenshotDataFrame> {
    if (!this.ready()) {
      return Promise.reject(
        new AgentChannelError("agent_offline", "Agent hors ligne.", { agentId: this.agentId }),
      );
    }
    if (this.pendingShots.has(shot.cmdId)) {
      return Promise.reject(
        new AgentChannelError("send_failed", "Demande de capture déjà en cours.", {
          agentId: this.agentId,
        }),
      );
    }
    return new Promise<ScreenshotDataFrame>((resolve, reject) => {
      const pending: PendingShot = { cmdId: shot.cmdId, agentId: this.agentId, resolve, reject };
      const budget = (shot.timeoutMs ?? 0) + COMMAND_SAFETY_MARGIN_MS;
      pending.timer = setTimeout(() => {
        if (!this.pendingShots.has(shot.cmdId)) return;
        this.pendingShots.delete(shot.cmdId);
        this.logger.warn("agents.ws.screenshot_timeout", {
          agent_id: this.agentId,
          cmd_id: shot.cmdId,
        });
        reject(
          new AgentChannelError("command_timeout", "Délai dépassé sans capture.", {
            agentId: this.agentId,
          }),
        );
      }, budget);
      pending.timer.unref?.();
      this.pendingShots.set(shot.cmdId, pending);

      this.ws.send(JSON.stringify(encodeScreenshotFrame(shot)), (error?: Error) => {
        if (!error) return;
        const current = this.pendingShots.get(shot.cmdId);
        if (!current) return;
        this.settleShot(current);
        reject(
          new AgentChannelError("send_failed", "Envoi de la demande de capture impossible.", {
            agentId: this.agentId,
          }),
        );
      });
    });
  }

  /** Retire une demande de capture en attente et nettoie son minuteur. */
  private settleShot(pending: PendingShot): void {
    this.pendingShots.delete(pending.cmdId);
    if (pending.timer) clearTimeout(pending.timer);
  }

  /**
   * Ferme la connexion et perd les commandes en attente (`result_lost`).
   * Idempotent.
   */
  dispose(_reason: string, detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    const lost = [...this.pending.values()];
    for (const pending of lost) {
      this.settle(pending);
      pending.reject(
        new AgentChannelError(
          "result_lost",
          "Connexion fermée pendant l'exécution : le résultat est perdu.",
          { agentId: this.agentId },
        ),
      );
    }
    if (lost.length > 0) {
      this.logger.warn("agents.ws.result_lost", {
        agent_id: this.agentId,
        count: lost.length,
        cmd_ids: lost.map((pending) => pending.cmdId),
        ...(detail ? { detail } : {}),
      });
    }
    const lostShots = [...this.pendingShots.values()];
    for (const pending of lostShots) {
      this.settleShot(pending);
      pending.reject(
        new AgentChannelError(
          "result_lost",
          "Connexion fermée pendant la capture : résultat perdu.",
          { agentId: this.agentId },
        ),
      );
    }
    if (lostShots.length > 0) {
      this.logger.warn("agents.ws.screenshot_lost", {
        agent_id: this.agentId,
        count: lostShots.length,
        ...(detail ? { detail } : {}),
      });
    }
    try {
      this.ws.close();
    } catch {
      // déjà fermée
    }
    this.onCloseCallback?.(this);
  }
}

export interface AgentHubOptions {
  logger: ChannelLogger;
}

/**
 * Registre des connexions d'exécution vivantes. Une seule connexion par agent :
 * une nouvelle connexion REMPLACE l'ancienne (dont les commandes en cours sont
 * perdues).
 */
export class AgentHub {
  private readonly logger: ChannelLogger;
  private readonly channels = new Map<string, AgentConnection>();

  constructor(options: AgentHubOptions) {
    this.logger = options.logger;
  }

  /** Enregistre une connexion (ferme la précédente du même agent, le cas échéant). */
  register(connection: AgentConnection): void {
    const previous = this.channels.get(connection.agentId);
    if (previous && previous !== connection) {
      this.logger.warn("agents.hub.replaced", { agent_id: connection.agentId });
      previous.dispose("remplaced");
    }
    this.channels.set(connection.agentId, connection);
  }

  /** Désinscrit une connexion si c'est bien la connexion courante. */
  unregister(connection: AgentConnection): void {
    if (this.channels.get(connection.agentId) === connection) {
      this.channels.delete(connection.agentId);
    }
  }

  get(agentId: string): AgentConnection | undefined {
    const connection = this.channels.get(agentId);
    return connection && !connection.isClosed ? connection : undefined;
  }

  isOnline(agentId: string): boolean {
    return this.get(agentId) !== undefined;
  }

  /**
   * Capacités DÉCLARÉES par l'agent connecté, `[]` si hors ligne ou aucun
   * `hello` reçu. C'est la seule voie par laquelle une capacité (ex.
   * `screenshot`) devient visible de Yuki.
   */
  caps(agentId: string): string[] {
    return this.get(agentId)?.caps ?? [];
  }

  /** `true` si l'agent CONNECTÉ a déclaré la capacité donnée. */
  hasCapability(agentId: string, name: string): boolean {
    return this.get(agentId)?.hasCapability(name) ?? false;
  }

  onlineIds(): string[] {
    return [...this.channels.values()].filter((c) => !c.isClosed).map((c) => c.agentId);
  }

  /** Envoie une commande à un agent connecté, sinon rejette (`agent_offline`). */
  sendCommand(agentId: string, cmd: OutboundCommand): Promise<ResultFrame> {
    const connection = this.get(agentId);
    if (!connection) {
      return Promise.reject(
        new AgentChannelError("agent_offline", "Agent hors ligne.", { agentId }),
      );
    }
    return connection.sendCommand(cmd);
  }

  /** Envoie une demande de capture à un agent connecté, sinon rejette. */
  sendScreenshot(agentId: string, shot: OutboundScreenshot): Promise<ScreenshotDataFrame> {
    const connection = this.get(agentId);
    if (!connection) {
      return Promise.reject(
        new AgentChannelError("agent_offline", "Agent hors ligne.", { agentId }),
      );
    }
    return connection.sendScreenshot(shot);
  }

  /** Ferme de force la connexion d'un agent (révocation). */
  disconnect(agentId: string): boolean {
    const connection = this.channels.get(agentId);
    if (!connection) return false;
    this.channels.delete(agentId);
    connection.dispose("revoked");
    return true;
  }

  /** Ferme toutes les connexions (arrêt du serveur). */
  closeAll(): void {
    for (const connection of [...this.channels.values()]) {
      connection.dispose("shutdown");
    }
    this.channels.clear();
  }
}
