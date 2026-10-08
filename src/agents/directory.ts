/**
 * Consultation des agents appairés (Lot 4, extension) — **LECTURE SEULE**.
 *
 * Fournit au modèle de quoi DÉCOUVRIR les machines appairées et connaître leur
 * état AVANT de les piloter par `run_command`. Aucune écriture : ce module ne
 * renomme rien, ne révoque rien et n'envoie aucune commande (il ne fait
 * qu'appeler `AgentStore` / `AgentHub` / `AuditLog` en lecture).
 *
 * ⚠️ Ce module est **pur** (aucun import SDK/typebox) : c'est le port consommé
 * par les outils `lister_agents`/`etat_agent` (`src/pi/sdk/execution-tools.ts`).
 *
 * ⚠️ Les NOMS d'agents proviennent des MACHINES (pré-remplissage via
 * `hello.host`, cf. `src/agents/server.ts`) et peuvent être piégés. Rien ici
 * n'échappe le texte : l'échappement et l'encadrement anti-injection se font au
 * moment du rendu, via `frameAgentDirectory`/`frameAgentStatus` (`./output.js`).
 * Le service se contente de renvoyer des DONNÉES structurées.
 *
 * ⚠️ L'historique ne recopie QUE des champs autorisés (horodatage, commande,
 * code de sortie) : **jamais** `stdout`/`stderr`/`output` (D127).
 */

import type { AuditLog } from "./audit.js";
import type { AgentHub } from "./connection.js";
import type { AgentHistoryEntry } from "./output.js";
import type { AgentStore } from "./store.js";
import type { AgentLevel, AgentPrivilege, AgentRecord } from "./types.js";

export interface DirectoryLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Vue LECTURE SEULE d'un agent appairé (donnée destinée au modèle). */
export interface AgentSummary {
  agentId: string;
  /** Nom lisible (alias), `""` si aucun — le rendu affiche alors « (sans nom) ». */
  name: string;
  /** `true` si l'agent est actuellement CONNECTÉ à Yuki. */
  online: boolean;
  level: AgentLevel;
  privilege: AgentPrivilege;
  /** Dernière connexion (ISO 8601), `null` si jamais vue. */
  lastSeen: string | null;
}

/** Libellés français lisibles des niveaux de validation (D118). */
export const AGENT_LEVEL_LABELS: Readonly<Record<AgentLevel, string>> = {
  disabled: "désactivé (exécution refusée)",
  always: "validation humaine à chaque commande",
  destructive: "validation humaine des commandes destructrices",
  never: "envoi direct (aucune validation)",
};

/** Libellés français lisibles des privilèges (D120). */
export const AGENT_PRIVILEGE_LABELS: Readonly<Record<AgentPrivilege, string>> = {
  root: "élevé (root)",
  normal: "normal (compte standard)",
};

/** Nombre maximal d'entrées d'historique renvoyées (borne dure). */
export const MAX_AGENT_HISTORY = 50;

/** Nombre par défaut d'entrées d'historique renvoyées. */
export const DEFAULT_AGENT_HISTORY_LIMIT = 10;

/** Port de consultation consommé par les outils `lister_agents`/`etat_agent`. */
export interface AgentDirectoryPort {
  /** Agents NON révoqués connus de Yuki. */
  list(): AgentSummary[];
  /**
   * Résout un agent par son NOM ou son ID (délégué à `AgentStore.resolve` :
   * ID exact prioritaire, puis nom insensible à la casse). `undefined` si
   * inconnu OU révoqué.
   */
  find(identifier: string): AgentSummary | undefined;
  /** Historique récent des commandes d'un agent (jamais la sortie, D127). */
  history(agentId: string, limit?: number): AgentHistoryEntry[];
}

export interface AgentDirectoryServiceOptions {
  store: AgentStore;
  /** Seul `isOnline` est utilisé (facilite les doubles de test). */
  hub: Pick<AgentHub, "isOnline">;
  /** Seul `recent` est utilisé (facilite les doubles de test). */
  audit: Pick<AuditLog, "recent">;
  logger?: DirectoryLogger;
}

/** Convertit un enregistrement de store en vue de consultation. */
function toSummary(record: AgentRecord, online: boolean): AgentSummary {
  return {
    agentId: record.agentId,
    name: record.name,
    online,
    level: record.level,
    privilege: record.privilege,
    lastSeen: record.lastSeen,
  };
}

/** Coerce la valeur brute d'audit `exit_code` en entier, `null` ou `undefined`. */
function coerceExitCode(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (value === null) return null;
  return undefined;
}

export class AgentDirectoryService implements AgentDirectoryPort {
  private readonly store: AgentStore;
  private readonly hub: Pick<AgentHub, "isOnline">;
  private readonly audit: Pick<AuditLog, "recent">;
  private readonly logger?: DirectoryLogger;

  constructor(options: AgentDirectoryServiceOptions) {
    this.store = options.store;
    this.hub = options.hub;
    this.audit = options.audit;
    this.logger = options.logger;
  }

  list(): AgentSummary[] {
    return this.store
      .list()
      .filter((record) => !record.revoked)
      .map((record) => toSummary(record, this.hub.isOnline(record.agentId)));
  }

  find(identifier: string): AgentSummary | undefined {
    const record = this.store.resolve(identifier);
    if (!record || record.revoked) return undefined;
    return toSummary(record, this.hub.isOnline(record.agentId));
  }

  /**
   * Historique RÉCENT des commandes d'un agent, borné à `MAX_AGENT_HISTORY`.
   * ⚠️ Ne recopie QUE des champs autorisés : horodatage, commande, code de
   * sortie. Aucune clé `stdout`/`stderr`/`output` n'est reprise (D127).
   */
  history(agentId: string, limit = DEFAULT_AGENT_HISTORY_LIMIT): AgentHistoryEntry[] {
    const capped = Math.min(Math.max(1, Math.trunc(limit)), MAX_AGENT_HISTORY);
    let records: Record<string, unknown>[];
    try {
      records = this.audit.recent({ agentId, event: "command", limit: capped });
    } catch (error) {
      this.logger?.warn("agents.directory.history.failed", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const out: AgentHistoryEntry[] = [];
    for (const record of records) {
      const ts = typeof record["ts"] === "string" ? record["ts"] : "";
      const command = typeof record["command"] === "string" ? record["command"] : undefined;
      const exitCode = coerceExitCode(record["exit_code"]);
      out.push({
        ts,
        ...(command !== undefined ? { command } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
    }
    return out;
  }
}
