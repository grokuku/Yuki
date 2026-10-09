/**
 * Validations humaines en attente (Lot 4, B6bis — garde-fous D118).
 *
 * Les niveaux **2 (validation à chaque commande)** et **3 (validation des
 * destructrices)** exigent qu'un HUMAIN approuve la commande avant exécution.
 * Le modèle ne peut PAS s'auto-approuver : l'outil `run_command` renvoie
 * « validation requise » ; un humain approuve DANS la conversation (le panneau
 * Agents reste un repli) ; la commande approuvée devient consommable UNE fois,
 * et seulement pour une commande IDENTIQUE (même agent, même texte).
 *
 * ⚠️ Registre EN MÉMOIRE, borné (TTL ~5 min, taille bornée) : une validation
 * non consommée expire — jamais de résidu exploitable.
 *
 * ⚠️ Chaque demande porte l'identifiant de la CONVERSATION (`sessionId`) d'où
 * elle a été émise : c'est ce qui permet de l'afficher dans la BONNE
 * conversation (et nulle part ailleurs). Le registre diffuse des
 * `ApprovalEvent` (demande / décision) pour le temps réel ; il ne connaît NI
 * le transport NI l'interface.
 */

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface PendingApproval {
  id: string;
  agentId: string;
  command: string;
  destructive: boolean;
  /** Motifs destructeurs déclenchés (identifiants), pour l'affichage. */
  destructiveIds: string[];
  /**
   * Conversation d'où la demande a été émise (identifiant de session PiHost).
   * C'est ce champ qui route la demande vers la BONNE conversation : la trame
   * n'est diffusée qu'aux clients de cette session. `undefined` si l'appelant
   * n'est pas rattaché à une session (ex. appel hors contexte).
   */
  sessionId?: string;
  /** Détails d'exécution à REJOUER tels quels après approbation (immédiateté). */
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

/** Entrée d'une demande de validation (rattachée à une conversation). */
export interface ApprovalRequestInput {
  agentId: string;
  command: string;
  destructive: boolean;
  /** Motifs destructeurs déclenchés (identifiants), optionnel. */
  destructiveIds?: string[];
  /** Conversation d'où la demande est émise (routage). */
  sessionId?: string;
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
}

/** Événement du registre (diffusion temps réel vers les clients WS). */
export type ApprovalEvent =
  | { kind: "requested"; approval: PendingApproval }
  | { kind: "decided"; approval: PendingApproval; decision: "approve" | "deny" };

export type ApprovalEventListener = (event: ApprovalEvent) => void;

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
  private readonly listeners = new Set<ApprovalEventListener>();

  constructor(options: ApprovalRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1_000, options.ttlMs ?? APPROVAL_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? APPROVAL_MAX_ENTRIES);
    this.idFactory = options.idFactory ?? defaultId;
    this.logger = options.logger;
  }

  /** S'abonne aux événements du registre (demande / décision). */
  subscribe(listener: ApprovalEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn("agents.approval.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Demande (ou retrouve) une validation pour une commande donnée. */
  request(input: ApprovalRequestInput): PendingApproval {
    this.purge();
    // Le dédoublonnage inclut la CONVERSATION : une même (agent, commande)
    // demandée depuis deux fils reste DEUX demandes distinctes, chacune routée
    // vers sa conversation. Le « consume-once » reste, lui, lié à (agent,
    // commande) — inchangé.
    const existing = this.findPending(input.agentId, input.command, input.sessionId);
    if (existing) return existing;
    const now = this.now();
    const entry: PendingApproval = {
      id: this.idFactory(),
      agentId: input.agentId,
      command: input.command,
      destructive: input.destructive,
      destructiveIds: [...(input.destructiveIds ?? [])],
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
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
      session_id: entry.sessionId ?? null,
      destructive: entry.destructive,
    });
    this.emit({ kind: "requested", approval: entry });
    return entry;
  }

  /**
   * Retrouve une demande EN ATTENTE identique (même agent, même commande, même
   * conversation). `sessionId` non fourni ⇒ toute conversation (compat.).
   */
  private findPending(
    agentId: string,
    command: string,
    sessionId?: string,
  ): PendingApproval | undefined {
    for (const entry of this.entries.values()) {
      if (
        entry.status === "pending" &&
        entry.agentId === agentId &&
        entry.command === command &&
        (sessionId === undefined || entry.sessionId === sessionId)
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
    this.logger?.info("agents.approval.approved", {
      approval_id: id,
      agent_id: entry.agentId,
      session_id: entry.sessionId ?? null,
    });
    this.emit({ kind: "decided", approval: entry, decision: "approve" });
    return entry;
  }

  deny(id: string): PendingApproval {
    const entry = this.require(id);
    entry.status = "denied";
    this.logger?.info("agents.approval.denied", {
      approval_id: id,
      agent_id: entry.agentId,
      session_id: entry.sessionId ?? null,
    });
    this.emit({ kind: "decided", approval: entry, decision: "deny" });
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
