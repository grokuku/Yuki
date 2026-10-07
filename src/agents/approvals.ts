/**
 * Validations humaines en attente (Lot 4, B6bis — garde-fous D118).
 *
 * Les niveaux **2 (validation à chaque commande)** et **3 (validation des
 * destructrices)** exigent qu'un HUMAIN approuve la commande avant exécution.
 * Le modèle ne peut PAS s'auto-approuver : l'outil `run_command` renvoie
 * « validation requise » ; un humain approuve depuis la page Agents ; la
 * commande approuvée devient consommable UNE fois, et seulement pour une
 * commande IDENTIQUE (même agent, même texte).
 *
 * ⚠️ Registre EN MÉMOIRE, borné (TTL ~5 min, taille bornée) : une validation
 * non consommée expire — jamais de résidu exploitable.
 */

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface PendingApproval {
  id: string;
  agentId: string;
  command: string;
  destructive: boolean;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface ApprovalLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ApprovalRegistryOptions {
  now?: () => number;
  /** Durée de validité d'une demande (défaut 5 min). */
  ttlMs?: number;
  /** Nombre maximal de demandes conservées (défaut 50). */
  maxEntries?: number;
  idFactory?: () => string;
  logger?: ApprovalLogger;
}

/** TTL par défaut d'une demande de validation. */
export const APPROVAL_TTL_MS = 5 * 60_000;
/** Nombre maximal de demandes conservées. */
export const APPROVAL_MAX_ENTRIES = 50;

let approvalSeq = 0;

function defaultId(): string {
  approvalSeq += 1;
  return `apr-${Date.now().toString(36)}-${approvalSeq.toString(36)}`;
}

export class ApprovalRegistry {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly idFactory: () => string;
  private readonly logger?: ApprovalLogger;
  private readonly entries = new Map<string, PendingApproval>();

  constructor(options: ApprovalRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1_000, options.ttlMs ?? APPROVAL_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? APPROVAL_MAX_ENTRIES);
    this.idFactory = options.idFactory ?? defaultId;
    this.logger = options.logger;
  }

  /** Demande (ou retrouve) une validation pour une commande donnée. */
  request(input: { agentId: string; command: string; destructive: boolean }): PendingApproval {
    this.purge();
    const existing = this.findPending(input.agentId, input.command);
    if (existing) return existing;
    const now = this.now();
    const entry: PendingApproval = {
      id: this.idFactory(),
      agentId: input.agentId,
      command: input.command,
      destructive: input.destructive,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      consumedAt: null,
    };
    this.entries.set(entry.id, entry);
    this.enforceLimit();
    this.logger?.info("agents.approval.requested", {
      approval_id: entry.id,
      agent_id: entry.agentId,
      destructive: entry.destructive,
    });
    return entry;
  }

  /** Retrouve une demande EN ATTENTE identique (même agent, même commande). */
  private findPending(agentId: string, command: string): PendingApproval | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.status === "pending" &&
        entry.agentId === agentId &&
        entry.command === command
      ) {
        return entry;
      }
    }
    return undefined;
  }

  list(): PendingApproval[] {
    this.purge();
    // Seules les demandes EN ATTENTE sont montrées : une fois approuvée, la
    // demande disparaît de l'UI (elle reste consommable UNE fois côté service).
    return [...this.entries.values()].filter((entry) => entry.status === "pending");
  }

  get(id: string): PendingApproval | undefined {
    this.purge();
    return this.entries.get(id);
  }

  approve(id: string): PendingApproval {
    const entry = this.require(id);
    entry.status = "approved";
    this.logger?.info("agents.approval.approved", { approval_id: id, agent_id: entry.agentId });
    return entry;
  }

  deny(id: string): PendingApproval {
    const entry = this.require(id);
    entry.status = "denied";
    this.logger?.info("agents.approval.denied", { approval_id: id, agent_id: entry.agentId });
    return entry;
  }

  private require(id: string): PendingApproval {
    this.purge();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`validation inconnue : ${id}`);
    return entry;
  }

  /**
   * Consomme (une seule fois) une validation APPROUVÉE correspondant EXACTEMENT
   * à l'agent et à la commande. Renvoie `true` si une validation a été
   * consommée.
   */
  consume(agentId: string, command: string): boolean {
    this.purge();
    for (const entry of this.entries.values()) {
      if (
        entry.status === "approved" &&
        entry.consumedAt === null &&
        entry.agentId === agentId &&
        entry.command === command
      ) {
        entry.consumedAt = new Date(this.now()).toISOString();
        this.logger?.info("agents.approval.consumed", {
          approval_id: entry.id,
          agent_id: agentId,
        });
        return true;
      }
    }
    return false;
  }

  /** Purge les demandes expirées et consommées. */
  purge(): void {
    const now = this.now();
    for (const [id, entry] of [...this.entries]) {
      const expired = Date.parse(entry.expiresAt) <= now;
      const stale = entry.consumedAt !== null || entry.status === "denied";
      if (expired || stale) {
        this.entries.delete(id);
      }
    }
  }

  private enforceLimit(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
