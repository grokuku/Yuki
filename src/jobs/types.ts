/**
 * Types du domaine `jobs` (AUCUN import SDK/typebox).
 *
 * Le `JobStore` est un journal append-only JSONL ; l'état courant est une
 * projection en mémoire reconstruite en rejouant le journal. Le schéma est
 * versionné (`schemaVersion: 1`) et conçu pour accueillir le Lot 8 (réconcilia-
 * tion au démarrage, garde-fou de fraîcheur, file des reports) SANS refonte :
 * au Lot 2, seul le stockage, les transitions et l'émission immédiate du report
 * sont implémentés.
 */

export const JOB_SCHEMA_VERSION = 1;

/** États d'un job. */
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Nature d'un événement du journal append-only. */
export type JobKind =
  | "created"
  | "queued"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "notified";

/** Statuts terminaux. */
export const TERMINAL_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

export interface JobUsage {
  input: number;
  output: number;
  total?: number;
}

export interface JobResult {
  text?: string;
  partial?: string;
  usage?: JobUsage;
  truncated?: boolean;
}

export interface JobErrorInfo {
  message: string;
  code?: string;
}

/** Projection sérialisable et versionnée d'un job. */
export interface JobRecord {
  schemaVersion: typeof JOB_SCHEMA_VERSION;
  id: string;
  status: JobStatus;
  task: string;
  context?: string;
  deadlineMs: number;
  /** Session légère propriétaire (celle qui a émis le `delegate`). */
  lightSessionId: string;
  /** Run léger déclencheur (corrélation), si connu. */
  parentRunId?: string;
  /** Session éphémère du worker lourd, si démarrée. */
  heavySessionId?: string;
  result: JobResult;
  error?: JobErrorInfo;
  notified: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  reportedAt?: string;
  /** Origine du job (`user` par défaut, extensible). */
  origin: string;
}

/** Champs modifiables par un événement. Les objets `result` fusionnent. */
export interface JobPatch {
  status?: JobStatus;
  task?: string;
  context?: string;
  deadlineMs?: number;
  lightSessionId?: string;
  parentRunId?: string;
  heavySessionId?: string;
  result?: JobResult;
  error?: JobErrorInfo;
  notified?: boolean;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  reportedAt?: string;
  origin?: string;
}

/** Une entrée du journal. */
export interface JobEvent {
  seq: number;
  ts: string;
  eventId: string;
  jobId: string;
  kind: JobKind;
  patch: JobPatch;
}

/** Statut cible induit par la nature de l'événement (`undefined` = pas de changement). */
export function statusForKind(kind: JobKind): JobStatus | undefined {
  switch (kind) {
    case "created":
      return "queued";
    case "queued":
      // Marqueur de mise en file : le statut a déjà été posé par `created`.
      return undefined;
    case "started":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "progress":
    case "notified":
      return undefined;
  }
}

/**
 * Transitions autorisées :
 *   (∅) → queued → running → {completed | failed | cancelled | interrupted}
 *   {completed | failed} → notified
 * `progress` ne change pas le statut ; `notified` est monotone.
 */
export function isTransitionAllowed(
  from: JobStatus | undefined,
  to: JobStatus,
): boolean {
  if (from === undefined) return to === "queued";
  switch (from) {
    case "queued":
      return to === "running" || to === "cancelled" || to === "interrupted";
    case "running":
      return (
        to === "completed" ||
        to === "failed" ||
        to === "cancelled" ||
        to === "interrupted"
      );
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      // Aucune transition de statut depuis un état terminal (le passage à
      // `notified` est un booléen monotone, pas un statut).
      return false;
  }
}

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Compteurs exposés par `/health`. */
export interface JobCounts {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  interrupted: number;
}

export function emptyCounts(): JobCounts {
  return { running: 0, queued: 0, completed: 0, failed: 0, interrupted: 0 };
}
