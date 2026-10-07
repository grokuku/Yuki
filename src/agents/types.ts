/**
 * Types du domaine `agents` — store des agents appairés (Lot 4).
 *
 * AUCUN import du SDK Pi ni de typebox : JSON sérialisable.
 *
 * ⚠️ Ce store est DYNAMIQUE (des agents s'ajoutent/partent à chaud) : il vit
 * HORS de `CONFIG_SCHEMA` (comme le `JobStore`), persisté sur le volume `state`.
 * Les conventions de nommage suivent le projet (camelCase) ; la correspondance
 * avec les libellés de la spec est : `agentId` ↔ `agent_id`,
 * `lastSeen` ↔ `last_seen`.
 */

/** Niveaux de confirmation PAR AGENT (D118). */
export const AGENT_LEVELS = [
  "disabled",
  "always",
  "destructive",
  "never",
] as const;
export type AgentLevel = (typeof AGENT_LEVELS)[number];

/** Privilèges du processus de l'agent, PAR MACHINE (D120). */
export const AGENT_PRIVILEGES = ["root", "normal"] as const;
export type AgentPrivilege = (typeof AGENT_PRIVILEGES)[number];

/** Version de schéma des enregistrements d'agents. */
export const AGENT_SCHEMA_VERSION = 1 as const;

/** Enregistrement d'un agent appairé. */
export interface AgentRecord {
  /** Identifiant stable (UUID fourni par Yuki au moment de l'appairage). */
  agentId: string;
  /** Niveau de garde-fou (D118). */
  level: AgentLevel;
  /** Privilège du processus (D120). */
  privilege: AgentPrivilege;
  /** Dernière connexion (ISO 8601), `null` si jamais vue. */
  lastSeen: string | null;
  /** `true` si l'agent a été révoqué (dé-appairage). */
  revoked: boolean;
  /** Version de schéma (migration future). */
  schemaVersion: typeof AGENT_SCHEMA_VERSION;
}

/** Champs modifiables par un événement. */
export interface AgentPatch {
  level?: AgentLevel;
  privilege?: AgentPrivilege;
  lastSeen?: string;
}

/** Nature d'un événement du journal d'agents. */
export type AgentEventKind = "upsert" | "revoked" | "restored" | "removed";

/** Événement append-only du journal d'agents. */
export interface AgentEvent {
  seq: number;
  ts: string;
  eventId: string;
  agentId: string;
  kind: AgentEventKind;
  patch?: AgentPatch;
}

/** Valeurs par défaut d'un agent découvert pour la première fois. */
export interface AgentDefaults {
  level: AgentLevel;
  privilege: AgentPrivilege;
}

export function isAgentLevel(value: unknown): value is AgentLevel {
  return typeof value === "string" && (AGENT_LEVELS as readonly string[]).includes(value);
}

export function isAgentPrivilege(value: unknown): value is AgentPrivilege {
  return (
    typeof value === "string" && (AGENT_PRIVILEGES as readonly string[]).includes(value)
  );
}
