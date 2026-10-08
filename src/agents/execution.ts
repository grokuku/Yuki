/**
 * Service d'exécution côté Yuki (Lot 4, B6) — le cerveau du canal.
 *
 * Enchaîne : **garde-fou par agent (D118)** → **classement destructeur
 * (D126)** → **envoi de la commande (B6)** → **audit sans sortie (D127)** →
 * **balisage de la sortie (anti-injection)**.
 *
 * ⚠️ Ce module est **pur** (aucun import SDK/typebox) : c'est le port consommé
 * par l'outil `run_command` (`src/pi/sdk/execution-tools.ts`).
 *
 * ⚠️ **Hors ligne = rejet immédiat** (D124) : aucune mise en file.
 * ⚠️ **Déconnexion pendant une commande ⇒ `result_lost`** (D124) : la commande
 * va à son terme côté agent, mais son résultat est perdu.
 */

import type { ApprovalRegistry } from "./approvals.js";
import type { AgentHub } from "./connection.js";
import { isChannelError } from "./errors.js";
import { evaluateDestructive } from "./destructive.js";
import { escapeOutputText, frameAgentDirectory, frameCommandOutput } from "./output.js";
import type { AuditLog } from "./audit.js";
import type { AgentStore } from "./store.js";

export interface ExecutionLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Statut terminal d'une demande d'exécution. */
export type ExecutionStatus =
  | "completed"
  | "failed"
  | "result_lost"
  | "timeout"
  | "refused"
  | "offline"
  | "awaiting_validation";

/** Demande d'exécution (portée par l'outil du modèle). */
export interface ExecutionRequest {
  agentId: string;
  command: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
}

/** Résultat d'exécution rendu à l'appelant (jamais la sortie brute non encadrée). */
export interface ExecutionOutcome {
  status: ExecutionStatus;
  /** Identifiant technique de l'agent (toujours renseigné si résolu). */
  agentId: string;
  /** Nom (alias) de l'agent résolu, `""` si aucun. */
  agentName?: string;
  command: string;
  destructive: boolean;
  destructiveIds: string[];
  exitCode: number | null;
  /**
   * Sortie ENCADRÉE (`<sortie …>`), présente UNIQUEMENT après exécution. C'est
   * la seule forme destinée au contexte du modèle.
   */
  framed?: string;
  /** Message court, lisible par le modèle. */
  message: string;
  /** Identifiant de la validation humaine (si `awaiting_validation`). */
  approvalId?: string;
  durationMs?: number;
  truncated?: boolean;
  timedOut?: boolean;
  /** Code applicatif de l'agent (si `failed`). */
  agentCode?: string;
}

/** Port consommé par l'outil `run_command`. */
export interface ExecutionServicePort {
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}

export interface ExecutionServiceOptions {
  store: AgentStore;
  hub: AgentHub;
  audit: AuditLog;
  approvals: ApprovalRegistry;
  logger: ExecutionLogger;
  idFactory?: () => string;
}

/** Timeout par défaut d'une commande (ms). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

let commandSeq = 0;

function defaultCommandId(): string {
  commandSeq += 1;
  return `cmd-${Date.now().toString(36)}-${commandSeq.toString(36)}`;
}

export class AgentExecutionService implements ExecutionServicePort {
  private readonly store: AgentStore;
  private readonly hub: AgentHub;
  private readonly audit: AuditLog;
  private readonly approvals: ApprovalRegistry;
  private readonly logger: ExecutionLogger;
  private readonly idFactory: () => string;

  constructor(options: ExecutionServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.audit = options.audit;
    this.approvals = options.approvals;
    this.logger = options.logger;
    this.idFactory = options.idFactory ?? defaultCommandId;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    const requested = request.agentId;
    const command = request.command;
    const verdict = evaluateDestructive(command);

    // 0. Résolution : le modèle peut désigner l'agent par son ID OU par son NOM
    // (alias lisible). ⚠️ L'ID reste PRIORITAIRE et toujours accepté.
    const record = this.store.resolve(requested);
    if (!record) {
      return this.refuse(
        requested,
        undefined,
        command,
        verdict,
        this.unknownAgentMessage(requested),
      );
    }
    const agentId = record.agentId;
    const agentName = record.name;

    // 1. Garde-fous de configuration (agent révoqué / désactivé).
    if (record.revoked) {
      return this.refuse(agentId, agentName, command, verdict, "Agent révoqué : exécution refusée.");
    }
    if (record.level === "disabled") {
      return this.refuse(
        agentId,
        agentName,
        command,
        verdict,
        "Agent désactivé (niveau 1) : exécution refusée.",
      );
    }

    // 2. Validation humaine (niveaux 2 et 3, D118).
    const needsApproval =
      record.level === "always" || (record.level === "destructive" && verdict.destructive);
    if (needsApproval && !this.approvals.consume(agentId, command)) {
      const pending = this.approvals.request({
        agentId,
        command,
        destructive: verdict.destructive,
      });
      this.logger.info("agents.exec.awaiting_validation", {
        agent_id: agentId,
        agent_name: agentName || null,
        approval_id: pending.id,
        destructive: verdict.destructive,
        level: record.level,
      });
      return {
        status: "awaiting_validation",
        agentId,
        agentName,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        exitCode: null,
        approvalId: pending.id,
        message:
          "Validation humaine requise : la commande n'a PAS été exécutée. " +
          "Un humain doit l'approuver depuis la page « Agents » (onglet Agents de /config), " +
          "puis la commande pourra être relancée telle quelle.",
      };
    }

    // 3. Hors ligne = rejet immédiat (D124) : pas de file d'attente.
    if (!this.hub.isOnline(agentId)) {
      return {
        status: "offline",
        agentId,
        agentName,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        exitCode: null,
        message: "Agent hors ligne : exécution refusée (aucune mise en file, D124).",
      };
    }

    // 4. Envoi (au plus une fois) et attente du résultat.
    const cmdId = this.idFactory();
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.logger.info("agents.exec.sent", {
      agent_id: agentId,
      agent_name: agentName || null,
      cmd_id: cmdId,
      destructive: verdict.destructive,
      origin: request.origin ?? null,
    });

    try {
      const result = await this.hub.sendCommand(agentId, {
        cmdId,
        command,
        ...(request.shell ? { shell: request.shell } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        timeoutMs,
        ...(request.origin ? { origin: request.origin } : {}),
        destructive: verdict.destructive,
      });

      this.audit.append({
        event: "command",
        agentId,
        command,
        exitCode: result.exitCode,
        meta: {
          status: "completed",
          // Le NOM pour l'humain, l'ID (champ `agent_id`) pour la traçabilité.
          agent_name: agentName || null,
          destructive: verdict.destructive,
          destructive_ids: verdict.ids,
          duration_ms: result.durationMs,
          truncated: result.truncated,
          timed_out: result.timedOut,
          ...(request.origin ? { origin: request.origin } : {}),
        },
      });

      const framed = frameCommandOutput({
        machine: agentId,
        command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncatedStdout: result.stdoutTrunc,
        truncatedStderr: result.stderrTrunc,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      });

      return {
        status: "completed",
        agentId,
        agentName,
        command,
        destructive: verdict.destructive,
        destructiveIds: verdict.ids,
        exitCode: result.exitCode,
        framed,
        message: `Commande exécutée (code de sortie ${result.exitCode}).`,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
    } catch (error) {
      return this.onChannelFailure(agentId, agentName, command, verdict, error);
    }
  }

  /**
   * Message rendu au modèle quand NI l'ID ni le nom ne correspondent : liste
   * les agents disponibles dans un bloc DONNÉE (balisage anti-injection).
   */
  private unknownAgentMessage(requested: string): string {
    const entries = this.store
      .list()
      .filter((record) => !record.revoked)
      .map((record) => ({ name: record.name, agentId: record.agentId }));
    return (
      `Agent inconnu : « ${escapeOutputText(requested)} ». ` +
      "Désignez l'agent par son identifiant technique ou par son nom.\n" +
      frameAgentDirectory(entries)
    );
  }

  /** Traduit un échec de canal en résultat terminal audité (jamais la sortie). */
  private onChannelFailure(
    agentId: string,
    agentName: string,
    command: string,
    verdict: { destructive: boolean; ids: string[] },
    error: unknown,
  ): ExecutionOutcome {
    const code = isChannelError(error) ? error.code : "send_failed";
    const status: ExecutionStatus =
      code === "result_lost"
        ? "result_lost"
        : code === "command_timeout"
          ? "timeout"
          : code === "agent_offline"
            ? "offline"
            : "failed";
    const message = error instanceof Error ? error.message : String(error);

    this.audit.append({
      event: "command",
      agentId,
      command,
      exitCode: null,
      meta: {
        status,
        agent_name: agentName || null,
        destructive: verdict.destructive,
        destructive_ids: verdict.ids,
      },
    });
    this.logger.warn("agents.exec.failed", {
      agent_id: agentId,
      agent_name: agentName || null,
      status,
      code,
      error: message,
    });

    return {
      status,
      agentId,
      agentName,
      command,
      destructive: verdict.destructive,
      destructiveIds: verdict.ids,
      exitCode: null,
      message,
      ...(isChannelError(error) && error.agentCode ? { agentCode: error.agentCode } : {}),
    };
  }

  private refuse(
    agentId: string,
    agentName: string | undefined,
    command: string,
    verdict: { destructive: boolean; ids: string[] },
    message: string,
  ): ExecutionOutcome {
    this.logger.info("agents.exec.refused", {
      agent_id: agentId,
      ...(agentName ? { agent_name: agentName } : {}),
      reason: message,
    });
    return {
      status: "refused",
      agentId,
      ...(agentName ? { agentName } : {}),
      command,
      destructive: verdict.destructive,
      destructiveIds: verdict.ids,
      exitCode: null,
      message,
    };
  }
}
