/**
 * `AgentStore` — journal append-only JSONL + projection en mémoire (Lot 4).
 *
 * Même patron que `JobStore` (`src/jobs/store.ts`) : écritures purement
 * append-only (une ligne JSON par événement), projection reconstruite en
 * rejouant le journal au démarrage, rejeu IDEMPOTENT par `eventId`.
 *
 * Il vit HORS de `CONFIG_SCHEMA` (store DYNAMIQUE) et persiste sur le volume
 * `state` (`/data/state/agents.jsonl` par défaut).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { AgentError } from "./errors.js";
import {
  AGENT_SCHEMA_VERSION,
  isAgentLevel,
  isAgentPrivilege,
  type AgentDefaults,
  type AgentEvent,
  type AgentEventKind,
  type AgentLevel,
  type AgentPatch,
  type AgentPrivilege,
  type AgentRecord,
} from "./types.js";

export interface AgentLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AgentStoreOptions {
  path: string;
  /** Niveau/privilège attribués à un agent découvert pour la première fois. */
  defaults: AgentDefaults;
  logger?: AgentLogger;
  now?: () => number;
  idFactory?: () => string;
}

interface ProjectionState {
  byId: Map<string, AgentRecord>;
  appliedEventIds: Set<string>;
  seqByAgent: Map<string, number>;
  lastSeq: number;
}

let fallbackCounter = 0;

function defaultIdFactory(): string {
  fallbackCounter += 1;
  return `agt-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

function newRecord(agentId: string, defaults: AgentDefaults): AgentRecord {
  return {
    agentId,
    level: defaults.level,
    privilege: defaults.privilege,
    lastSeen: null,
    revoked: false,
    schemaVersion: AGENT_SCHEMA_VERSION,
  };
}

function assertAgentId(agentId: string): void {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new AgentError("INVALID_AGENT_ID", "Identifiant d'agent vide.");
  }
}

function assertLevel(level: AgentLevel): void {
  if (!isAgentLevel(level)) {
    throw new AgentError("INVALID_LEVEL", `Niveau d'agent invalide : ${String(level)}.`);
  }
}

function assertPrivilege(privilege: AgentPrivilege): void {
  if (!isAgentPrivilege(privilege)) {
    throw new AgentError(
      "INVALID_PRIVILEGE",
      `Privilège d'agent invalide : ${String(privilege)}.`,
    );
  }
}

/**
 * Applique un événement à la projection. Renvoie `true` si appliqué, `false`
 * si ignoré (idempotence/rejeu). En écriture normale, une transition illégale
 * lève une `AgentError` ; au rejeu, elle est ignorée + avertissement.
 */
export function applyAgentEvent(
  state: ProjectionState,
  event: AgentEvent,
  options: { replay?: boolean; defaults: AgentDefaults; logger?: AgentLogger },
): boolean {
  const { replay = false, defaults, logger } = options;
  if (state.appliedEventIds.has(event.eventId)) return false;

  const skip = (message: string): false => {
    if (replay) {
      logger?.warn("agents.store.replay.skipped", {
        agent_id: event.agentId,
        kind: event.kind,
        reason: message,
      });
      return false;
    }
    throw new AgentError("AGENT_NOT_FOUND", message, { agentId: event.agentId });
  };

  const prevSeq = state.seqByAgent.get(event.agentId) ?? 0;
  if (event.seq <= prevSeq) return false;

  const existing = state.byId.get(event.agentId);
  const patch = event.patch ?? {};

  if (patch.level !== undefined && !isAgentLevel(patch.level)) {
    return skip(`niveau invalide ${String(patch.level)}`);
  }
  if (patch.privilege !== undefined && !isAgentPrivilege(patch.privilege)) {
    return skip(`privilège invalide ${String(patch.privilege)}`);
  }

  switch (event.kind) {
    case "upsert": {
      const base = existing ?? newRecord(event.agentId, defaults);
      const next: AgentRecord = { ...base };
      if (patch.level !== undefined) next.level = patch.level;
      if (patch.privilege !== undefined) next.privilege = patch.privilege;
      if (patch.lastSeen !== undefined) next.lastSeen = patch.lastSeen;
      state.byId.set(event.agentId, next);
      break;
    }
    case "revoked": {
      if (!existing) return skip(`révocation d'un agent inconnu ${event.agentId}`);
      state.byId.set(event.agentId, { ...existing, revoked: true });
      break;
    }
    case "restored": {
      if (!existing) return skip(`restauration d'un agent inconnu ${event.agentId}`);
      state.byId.set(event.agentId, { ...existing, revoked: false });
      break;
    }
    case "removed": {
      if (!existing) return skip(`suppression d'un agent inconnu ${event.agentId}`);
      state.byId.delete(event.agentId);
      break;
    }
    default:
      return skip(`type d'événement inconnu ${String(event.kind)}`);
  }

  state.appliedEventIds.add(event.eventId);
  state.seqByAgent.set(event.agentId, event.seq);
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  return true;
}

export class AgentStore {
  private readonly path: string;
  private readonly defaults: AgentDefaults;
  private readonly logger?: AgentLogger;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  private readonly byId = new Map<string, AgentRecord>();
  private readonly appliedEventIds = new Set<string>();
  private readonly seqByAgent = new Map<string, number>();
  private lastSeq = 0;

  private constructor(options: AgentStoreOptions) {
    this.path = options.path;
    this.defaults = options.defaults;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  /** Ouvre (ou crée) le journal et reconstruit la projection en le rejouant. */
  static open(options: AgentStoreOptions): AgentStore {
    const store = new AgentStore(options);
    store.replayFromDisk();
    return store;
  }

  /** Construit un store en mémoire à partir d'événements (tests déterministes). */
  static fromEvents(
    events: readonly AgentEvent[],
    options: AgentStoreOptions,
  ): AgentStore {
    const store = new AgentStore(options);
    for (const event of events) store.apply(event, true);
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): AgentRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  isRevoked(id: string): boolean {
    return this.byId.get(id)?.revoked === true;
  }

  list(): AgentRecord[] {
    return [...this.byId.values()];
  }

  /** Enregistre/actualise la vue d'un agent (créé avec les défauts si inconnu). */
  markSeen(agentId: string, patch: AgentPatch = {}): AgentRecord {
    assertAgentId(agentId);
    const withTime: AgentPatch = {
      lastSeen: patch.lastSeen ?? new Date(this.now()).toISOString(),
      ...(patch.level !== undefined ? { level: patch.level } : {}),
      ...(patch.privilege !== undefined ? { privilege: patch.privilege } : {}),
    };
    this.appendEvent(agentId, "upsert", withTime);
    return this.byId.get(agentId) as AgentRecord;
  }

  /** Modifie la configuration d'un agent EXISTANT. */
  configure(agentId: string, patch: { level?: AgentLevel; privilege?: AgentPrivilege }): AgentRecord {
    assertAgentId(agentId);
    if (!this.byId.has(agentId)) {
      throw new AgentError("AGENT_NOT_FOUND", `Agent inconnu : ${agentId}.`, { agentId });
    }
    if (patch.level === undefined && patch.privilege === undefined) {
      return this.byId.get(agentId) as AgentRecord;
    }
    if (patch.level !== undefined) assertLevel(patch.level);
    if (patch.privilege !== undefined) assertPrivilege(patch.privilege);
    this.appendEvent(agentId, "upsert", patch);
    return this.byId.get(agentId) as AgentRecord;
  }

  setLevel(agentId: string, level: AgentLevel): AgentRecord {
    assertLevel(level);
    return this.configure(agentId, { level });
  }

  setPrivilege(agentId: string, privilege: AgentPrivilege): AgentRecord {
    assertPrivilege(privilege);
    return this.configure(agentId, { privilege });
  }

  /** Révoque un agent (dé-appairage) : son accès cesse. */
  revoke(agentId: string): AgentRecord {
    assertAgentId(agentId);
    this.appendEvent(agentId, "revoked");
    return this.byId.get(agentId) as AgentRecord;
  }

  /** Annule une révocation. */
  restore(agentId: string): AgentRecord {
    assertAgentId(agentId);
    this.appendEvent(agentId, "restored");
    return this.byId.get(agentId) as AgentRecord;
  }

  /** Supprime un agent de la projection (le journal conserve l'historique). */
  remove(agentId: string): void {
    assertAgentId(agentId);
    this.appendEvent(agentId, "removed");
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new AgentError(
        "STORE_IO",
        `Lecture impossible du journal d'agents (${this.path}).`,
        { cause: error },
      );
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event: AgentEvent;
      try {
        event = JSON.parse(trimmed) as AgentEvent;
      } catch {
        this.logger?.warn("agents.store.line.invalid", { path: this.path });
        continue;
      }
      this.apply(event, true);
    }
  }

  private apply(event: AgentEvent, replay: boolean): boolean {
    const applied = applyAgentEvent(
      {
        byId: this.byId,
        appliedEventIds: this.appliedEventIds,
        seqByAgent: this.seqByAgent,
        lastSeq: this.lastSeq,
      },
      event,
      {
        replay,
        defaults: this.defaults,
        ...(this.logger ? { logger: this.logger } : {}),
      },
    );
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    return applied;
  }

  private appendEvent(agentId: string, kind: AgentEventKind, patch?: AgentPatch): AgentEvent {
    const event: AgentEvent = {
      seq: this.lastSeq + 1,
      ts: new Date(this.now()).toISOString(),
      eventId: this.idFactory(),
      agentId,
      kind,
      ...(patch && Object.keys(patch).length > 0 ? { patch } : {}),
    };
    // Peut lever (agent inconnu, niveau invalide) SANS avoir écrit.
    this.apply(event, false);
    this.persist(event);
    return event;
  }

  private persist(event: AgentEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      throw new AgentError(
        "STORE_IO",
        `Écriture impossible du journal d'agents (${this.path}).`,
        { cause: error, agentId: event.agentId },
      );
    }
  }
}
