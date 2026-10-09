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
  AGENT_NAME_MAX_LENGTH,
  AGENT_SCHEMA_VERSION,
  isAgentLevel,
  isAgentPrivilege,
  isValidAgentName,
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
  /**
   * Dernier niveau NON désactivé porté par chaque agent (mémoire du on/off de
   * l'encart de la barre latérale). État DÉRIVÉ du journal : il se reconstruit au
   * rejeu, donc survit au redémarrage SANS second drapeau d'activation.
   */
  lastEnabledLevel: Map<string, AgentLevel>;
  lastSeq: number;
}

/**
 * Niveau appliqué quand « on » réactive un agent qui était DÉJÀ `disabled` (aucun
 * niveau précédent mémorisé, ou le défaut configuré est lui-même `disabled`).
 * Aligné sur le défaut de `agents.defaultLevel` (validation des destructrices) :
 * le plus raisonnable en réseau local, ni permissif, ni paralysant.
 */
export const DEFAULT_ENABLED_LEVEL: AgentLevel = "destructive";

let fallbackCounter = 0;

function defaultIdFactory(): string {
  fallbackCounter += 1;
  return `agt-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

function newRecord(agentId: string, defaults: AgentDefaults): AgentRecord {
  return {
    agentId,
    name: "",
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
 * Normalise un nom fourni par l'utilisateur : espaces de bord retirés, bornes
 * 1..`AGENT_NAME_MAX_LENGTH`, sans caractère de contrôle. Lève
 * `INVALID_AGENT_NAME` sinon.
 */
export function normalizeAgentName(raw: string): string {
  if (typeof raw !== "string") {
    throw new AgentError("INVALID_AGENT_NAME", "Nom d'agent : texte attendu.");
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new AgentError("INVALID_AGENT_NAME", "Nom d'agent vide.");
  }
  if (name.length > AGENT_NAME_MAX_LENGTH) {
    throw new AgentError(
      "INVALID_AGENT_NAME",
      `Nom d'agent trop long (${name.length} caractères, maximum ${AGENT_NAME_MAX_LENGTH}).`,
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new AgentError(
      "INVALID_AGENT_NAME",
      "Nom d'agent : caractère de contrôle interdit.",
    );
  }
  return name;
}

/** `true` si `name` est déjà porté par un AUTRE agent (comparaison insensible à la casse). */
function nameTaken(records: Iterable<AgentRecord>, selfId: string, name: string): boolean {
  const needle = name.toLowerCase();
  for (const record of records) {
    if (record.agentId === selfId) continue;
    if (record.name !== "" && record.name.toLowerCase() === needle) return true;
  }
  return false;
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

  if (patch.name !== undefined && !isValidAgentName(patch.name)) {
    return skip(`nom invalide ${String(patch.name)}`);
  }
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
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.level !== undefined) next.level = patch.level;
      if (patch.privilege !== undefined) next.privilege = patch.privilege;
      if (patch.lastSeen !== undefined) next.lastSeen = patch.lastSeen;
      state.byId.set(event.agentId, next);
      // Mémoire du on/off : tout niveau effectif non `disabled` devient le
      // niveau à restaurer si l'agent est ensuite désactivé.
      if (next.level !== "disabled") {
        state.lastEnabledLevel.set(event.agentId, next.level);
      }
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
      state.lastEnabledLevel.delete(event.agentId);
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
  private readonly lastEnabledLevel = new Map<string, AgentLevel>();
  private lastSeq = 0;
  private readonly listeners = new Set<() => void>();

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

  /**
   * S'abonne aux changements du registre (créations, config, révocation,
   * suppression). Sert au transport WebSocket pour DIFFUSER l'état des agents
   * aux pages ouvertes SANS polling. Renvoie la fonction de désabonnement.
   * Les exceptions d'un listener sont isolées (jamais propagées à l'écriture).
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Résout un identifiant fourni par le modèle ou l'humain : d'abord l'ID
   * exact (compatibilité garantie), puis, à défaut, le NOM (insensible à la
   * casse). Renvoie `undefined` si ni l'un ni l'autre ne correspond.
   */
  resolve(identifier: string): AgentRecord | undefined {
    if (typeof identifier !== "string") return undefined;
    const exact = this.byId.get(identifier);
    if (exact) return exact;
    const trimmed = identifier.trim();
    if (trimmed === "") return undefined;
    const byId = this.byId.get(trimmed);
    if (byId) return byId;
    return this.findByName(trimmed);
  }

  /**
   * Recherche un agent par son NOM (insensible à la casse). L'unicité étant
   * imposée à l'écriture, au plus un agent correspond dans un store sain.
   */
  findByName(name: string): AgentRecord | undefined {
    if (typeof name !== "string") return undefined;
    const needle = name.trim().toLowerCase();
    if (needle === "") return undefined;
    for (const record of this.byId.values()) {
      if (record.name !== "" && record.name.toLowerCase() === needle) return record;
    }
    return undefined;
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

  /** Modifie la configuration d'un agent EXISTANT (niveau, privilège, nom). */
  configure(
    agentId: string,
    patch: { level?: AgentLevel; privilege?: AgentPrivilege; name?: string },
  ): AgentRecord {
    assertAgentId(agentId);
    if (!this.byId.has(agentId)) {
      throw new AgentError("AGENT_NOT_FOUND", `Agent inconnu : ${agentId}.`, { agentId });
    }
    const next: { level?: AgentLevel; privilege?: AgentPrivilege; name?: string } = {};
    if (patch.level !== undefined) {
      assertLevel(patch.level);
      next.level = patch.level;
    }
    if (patch.privilege !== undefined) {
      assertPrivilege(patch.privilege);
      next.privilege = patch.privilege;
    }
    if (patch.name !== undefined) {
      const name = normalizeAgentName(patch.name);
      if (nameTaken(this.byId.values(), agentId, name)) {
        throw new AgentError(
          "AGENT_NAME_TAKEN",
          `Le nom « ${name} » est déjà utilisé par un autre agent.`,
          { agentId },
        );
      }
      next.name = name;
    }
    if (Object.keys(next).length === 0) {
      return this.byId.get(agentId) as AgentRecord;
    }
    this.appendEvent(agentId, "upsert", next);
    return this.byId.get(agentId) as AgentRecord;
  }

  /** Renomme un agent EXISTANT (alias lisible ; l'ID reste la clé de stockage). */
  setName(agentId: string, name: string): AgentRecord {
    return this.configure(agentId, { name });
  }

  /**
   * Pré-remplit le nom d'un agent avec `candidate` (ex. son nom d'hôte) SI et
   * seulement s'il n'a PAS encore de nom. N'écrase jamais un nom choisi par
   * l'utilisateur ; ignore silencieusement une valeur invalide ou déjà prise
   * (l'unicité prime). Renvoie l'enregistrement (inchangé si non pré-rempli),
   * ou `undefined` si l'agent est inconnu.
   */
  prefillName(agentId: string, candidate: string | null | undefined): AgentRecord | undefined {
    assertAgentId(agentId);
    const record = this.byId.get(agentId);
    if (!record) return undefined;
    if (record.name !== "") return record;
    if (typeof candidate !== "string") return record;
    let name: string;
    try {
      name = normalizeAgentName(candidate);
    } catch {
      return record;
    }
    if (nameTaken(this.byId.values(), agentId, name)) return record;
    this.appendEvent(agentId, "upsert", { name });
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

  /**
   * Bascule ON/OFF de l'encart de la barre latérale :
   *  - `enabled === false` ⇒ niveau `disabled` (le niveau effectif d'avant est
   *    mémorisé par la projection) ;
   *  - `enabled === true` ⇒ restaure le niveau mémorisé ; si l'agent était DÉJÀ
   *    `disabled` (aucun précédent), applique `DEFAULT_ENABLED_LEVEL` (ou le
   *    défaut configuré s'il n'est pas `disabled`).
   * Réutilise le niveau existant : AUCUN second drapeau d'activation.
   */
  setEnabled(agentId: string, enabled: boolean): AgentRecord {
    assertAgentId(agentId);
    const record = this.byId.get(agentId);
    if (!record) {
      throw new AgentError("AGENT_NOT_FOUND", `Agent inconnu : ${agentId}.`, { agentId });
    }
    if (enabled) {
      if (record.level !== "disabled") return record; // déjà actif : no-op
      const remembered = this.lastEnabledLevel.get(agentId);
      const fallback =
        this.defaults.level !== "disabled"
          ? this.defaults.level
          : DEFAULT_ENABLED_LEVEL;
      const level = remembered && remembered !== "disabled" ? remembered : fallback;
      return this.configure(agentId, { level });
    }
    if (record.level === "disabled") return record; // déjà désactivé : no-op
    return this.configure(agentId, { level: "disabled" });
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
        lastEnabledLevel: this.lastEnabledLevel,
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
    this.notify();
    return event;
  }

  /** Informe les abonnés qu'un événement a été appliqué ET persisté. */
  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger?.warn("agents.store.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
