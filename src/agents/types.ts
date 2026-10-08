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

/**
 * Longueur maximale d'un nom personnalisé d'agent (alias lisible par l'humain).
 * Choisi volontairement court : un alias doit tenir sur une ligne d'interface.
 */
export const AGENT_NAME_MAX_LENGTH = 64;

/** Enregistrement d'un agent appairé. */
export interface AgentRecord {
  /** Identifiant stable (UUID fourni par Yuki au moment de l'appairage). */
  agentId: string;
  /**
   * Nom personnalisé (alias LISIBLE par l'humain), `""` si aucun. Ce n'est
   * JAMAIS la clé technique : `agentId` reste la référence de stockage.
   */
  name: string;
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
  /** Nouveau nom (déjà normalisé : espaces retirés, 1..64 caractères). */
  name?: string;
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

/**
 * `true` si `value` peut être stocké comme nom d'agent : chaîne, espaces de
 * bord retirés non vides, ≤ `AGENT_NAME_MAX_LENGTH`, sans caractère de
 * contrôle (nouveaux traits, etc.). La normalisation (trim) est faite par
 * `normalizeAgentName` (`store.ts`) ; ici on ne teste que la FORME.
 */
export function isValidAgentName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > AGENT_NAME_MAX_LENGTH) return false;
  // Caractères de contrôle interdits (C0 + DEL + C1).
  return !/[\u0000-\u001f\u007f-\u009f]/.test(trimmed);
}
