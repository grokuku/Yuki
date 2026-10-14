/**
 * Demandes de SECRET en attente (`awaiting_secret`) — flux DÉDIÉ.
 *
 * ⚠️ Pourquoi un flux dédié (et non un champ ajouté à la validation D118) : un
 * agent de niveau 4 (`auto`) peut exécuter SANS validation humaine. Si la
 * commande référence un secret absent du coffre, il faut malgré tout interroger
 * l'humain — c'est un flux PROPRE, qui couvre donc les agents SANS validation.
 *
 * Une demande naît quand une commande référence `${YUKI_SECRET_NOM}` et que
 * `NOM` n'est PAS dans le coffre. Elle porte le NOM (jamais la valeur) et de quoi
 * REJOUER la commande à l'identique. Elle est ÉPHÉMÈRE : registre EN MÉMOIRE,
 * borné, TTL — jamais persistée, jamais dans le transcript, le snapshot, le
 * rejeu ou la mémoire. La VALEUR fournie par l'humain ne transite que par le
 * message de soumission (voir transport WS) puis est CHIFFRÉE dans le coffre.
 */

export interface PendingSecretRequest {
  id: string;
  agentId: string;
  agentName?: string;
  /** Commande EXACTE (avec ses références `${YUKI_SECRET_…}`, jamais la valeur). */
  command: string;
  /** Détails d'exécution à REJOUER tels quels après fourniture (immédiateté). */
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
  /** Conversation d'où la demande est émise (routage vers la bonne fenêtre). */
  sessionId?: string;
  /** Noms de secrets MANQUANTS à fournir (ordre de première apparition). */
  names: string[];
  status: "pending" | "fulfilled" | "cancelled";
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface SecretRequestInput {
  agentId: string;
  agentName?: string;
  command: string;
  names: string[];
  shell?: string;
  cwd?: string;
  timeoutMs?: number;
  origin?: string;
  sessionId?: string;
}

export type SecretRequestEvent =
  | { kind: "requested"; request: PendingSecretRequest }
  | {
      kind: "cleared";
      request: PendingSecretRequest;
      reason: "fulfilled" | "cancelled";
    };

export type SecretRequestListener = (event: SecretRequestEvent) => void;

export interface SecretRequestLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface SecretRequestRegistryOptions {
  now?: () => number;
  /** Durée de validité (défaut 10 min : trouver un secret prend plus qu'approuver). */
  ttlMs?: number;
  maxEntries?: number;
  idFactory?: () => string;
  logger?: SecretRequestLogger;
}

/** TTL par défaut d'une demande de secret. */
export const SECRET_REQUEST_TTL_MS = 10 * 60_000;
/** Nombre maximal de demandes conservées. */
export const SECRET_REQUEST_MAX_ENTRIES = 50;

let secretSeq = 0;

function defaultId(): string {
  secretSeq += 1;
  return `sec-${Date.now().toString(36)}-${secretSeq.toString(36)}`;
}

export class SecretRequestRegistry {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly idFactory: () => string;
  private readonly logger?: SecretRequestLogger;
  private readonly entries = new Map<string, PendingSecretRequest>();
  private readonly listeners = new Set<SecretRequestListener>();

  constructor(options: SecretRequestRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1_000, options.ttlMs ?? SECRET_REQUEST_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? SECRET_REQUEST_MAX_ENTRIES);
    this.idFactory = options.idFactory ?? defaultId;
    this.logger = options.logger;
  }

  subscribe(listener: SecretRequestListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SecretRequestEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn("secrets.request.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Demande (ou retrouve) une fourniture de secret pour une commande donnée. */
  request(input: SecretRequestInput): PendingSecretRequest {
    this.purge();
    const existing = this.findPending(input.agentId, input.command, input.sessionId);
    if (existing) return existing;
    const now = this.now();
    const entry: PendingSecretRequest = {
      id: this.idFactory(),
      agentId: input.agentId,
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      command: input.command,
      ...(input.shell !== undefined ? { shell: input.shell } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      names: [...input.names],
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      consumedAt: null,
    };
    this.entries.set(entry.id, entry);
    this.enforceLimit();
    // ⚠️ Journal SANS la valeur : uniquement le nom des secrets manquants.
    this.logger?.info("secrets.request.requested", {
      request_id: entry.id,
      agent_id: entry.agentId,
      session_id: entry.sessionId ?? null,
      names: entry.names.join(","),
    });
    this.emit({ kind: "requested", request: entry });
    return entry;
  }

  private findPending(
    agentId: string,
    command: string,
    sessionId?: string,
  ): PendingSecretRequest | undefined {
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

  /** Demandes EN ATTENTE (toutes conversations). */
  list(): PendingSecretRequest[] {
    this.purge();
    return [...this.entries.values()].filter((entry) => entry.status === "pending");
  }

  /** Demandes EN ATTENTE d'une conversation (ré-affichage à la connexion). */
  listFor(sessionId: string): PendingSecretRequest[] {
    return this.list().filter((entry) => entry.sessionId === sessionId);
  }

  get(id: string): PendingSecretRequest | undefined {
    this.purge();
    return this.entries.get(id);
  }

  /** Marque la demande comme FOURNIE (les valeurs ont déjà été rangées au coffre). */
  fulfill(id: string): PendingSecretRequest {
    const entry = this.require(id);
    entry.status = "fulfilled";
    this.logger?.info("secrets.request.fulfilled", {
      request_id: id,
      agent_id: entry.agentId,
      session_id: entry.sessionId ?? null,
    });
    this.emit({ kind: "cleared", request: entry, reason: "fulfilled" });
    return entry;
  }

  /** Annule une demande (l'humain a renoncé, la fenêtre a expiré…). */
  cancel(id: string): PendingSecretRequest {
    const entry = this.require(id);
    entry.status = "cancelled";
    this.logger?.info("secrets.request.cancelled", {
      request_id: id,
      agent_id: entry.agentId,
      session_id: entry.sessionId ?? null,
    });
    this.emit({ kind: "cleared", request: entry, reason: "cancelled" });
    return entry;
  }

  private require(id: string): PendingSecretRequest {
    this.purge();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`demande de secret inconnue : ${id}`);
    return entry;
  }

  /** Purge les demandes expirées / déjà traitées. */
  purge(): void {
    const now = this.now();
    for (const [id, entry] of [...this.entries]) {
      const expired = Date.parse(entry.expiresAt) <= now;
      const done = entry.status !== "pending";
      if (expired || done) this.entries.delete(id);
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
