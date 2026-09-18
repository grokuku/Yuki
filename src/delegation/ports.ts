/**
 * Ports du domaine `delegation` (AUCUN import SDK/typebox).
 *
 * INVERSION DE DÉPENDANCE : ce module déclare les interfaces que
 * `src/pi/sdk/*` implémente. `src/delegation` ne connaît donc AUCUN type du SDK
 * Pi ; `src/index.ts` câble les implémentations.
 *
 * Ne contient que des types/interfaces (aucun code d'orchestration).
 */

import type { JobRecord, JobStatus, JobUsage } from "../jobs/types.js";
import type { PiEvent, PiEventSource } from "../pi/types.js";

export type { PiEventSource };

/** Rôle LLM, du point de vue de la disponibilité. */
export type AvailabilityRole = "light" | "heavy";

/** Vérifie la présence d'une clé configurée — sans aucun appel réseau. */
export interface ModelAvailability {
  isAvailable(role: AvailabilityRole): boolean;
}

/* -------------------------------------------------------------------------- */
/* Worker lourd                                                                */
/* -------------------------------------------------------------------------- */

export interface HeavyRunRequest {
  jobId: string;
  task: string;
  context?: string;
  /** Session légère propriétaire (instrumentation / corrélation). */
  lightSessionId: string;
  /** Durée d'inactivité maximale (sans événement) avant abort. */
  idleTimeoutMs: number;
  /** Durée totale maximale avant abort. */
  totalTimeoutMs: number;
  /** Premier delta de contenu (TTFT du job). */
  onFirstToken?: () => void;
  /** Travail partiel à chaque fin de tour (persisté). */
  onProgress?: (partial: string) => void;
  /** Identifiant de la session éphémère ouverte par le worker. */
  onSession?: (heavySessionId: string) => void;
}

export interface HeavyRunResult {
  status: "completed" | "failed" | "cancelled";
  /** Texte final (deltas `content` uniquement ; `thinking` ignoré). */
  text?: string;
  /** Dernier travail partiel connu. */
  partial?: string;
  usage?: JobUsage;
  /** Motif d'échec (`timeout`, `idle_timeout`, …). */
  error?: string;
}

export interface HeavyRunHandle {
  /** Résout toujours (jamais de rejet) avec l'issue du job. */
  readonly promise: Promise<HeavyRunResult>;
  /** Aborte la session éphémère et libère ses ressources. */
  cancel(): Promise<void>;
}

/** Exécute une tâche en session éphémère (une tâche = une session = une réponse). */
export interface HeavyWorker {
  run(request: HeavyRunRequest): HeavyRunHandle;
}

/* -------------------------------------------------------------------------- */
/* Réveil du léger (report)                                                    */
/* -------------------------------------------------------------------------- */

/** `PiHost` satisfait structurellement ce port. */
export interface LightWaker {
  send(
    sessionId: string,
    text: string,
    opts?: { origin?: string; jobId?: string },
  ): { runId?: string } | void;
}

/* -------------------------------------------------------------------------- */
/* Canal de notification sortant (Lot 10 — réservé, non implémenté)            */
/* -------------------------------------------------------------------------- */

export interface JobReporter {
  report(job: JobRecord): Promise<void> | void;
}

/* -------------------------------------------------------------------------- */
/* Service de délégation                                                       */
/* -------------------------------------------------------------------------- */

export interface DelegateRequest {
  task: string;
  context?: string;
  deadlineMs?: number;
  lightSessionId: string;
  parentRunId?: string;
  origin?: string;
  /** Abort du run léger : interrompt l'attente inline, JAMAIS le job. */
  signal?: AbortSignal;
}

export interface DelegateCompleted {
  status: "completed";
  result: string;
  duration_ms: number;
  usage_input?: number;
  usage_output?: number;
  truncated: boolean;
}

export interface DelegatePending {
  status: "pending";
  job_id: string;
  deadline_ms: number;
  note: string;
}

export interface DelegateFailed {
  status: "failed";
  error: string;
  partial?: string;
}

export interface DelegateTimeout {
  status: "timeout";
  error: "timeout";
  partial?: string;
}

export interface DelegateCancelled {
  status: "cancelled";
  job_id: string;
}

export interface DelegateRejected {
  status: "rejected";
  reason: "queue_full";
}

export interface DelegateUnavailable {
  status: "unavailable";
  reason: "heavy_unavailable";
}

export type DelegateOutcome =
  | DelegateCompleted
  | DelegatePending
  | DelegateFailed
  | DelegateTimeout
  | DelegateCancelled
  | DelegateRejected
  | DelegateUnavailable;

export interface CancelSucceeded {
  status: "cancelled";
  job_id: string;
}

export interface CancelNotFound {
  status: "not_found";
  job_id: string;
}

export interface CancelNotPossible {
  status: "not_cancellable";
  job_id: string;
  job_status: JobStatus;
}

export type CancelOutcome = CancelSucceeded | CancelNotFound | CancelNotPossible;

/** Surface consommée par les outils `delegate`/`job_status`/`cancel_job`. */
export interface DelegateServicePort {
  delegate(request: DelegateRequest): Promise<DelegateOutcome>;
  jobStatus(jobId: string): JobRecord | undefined;
  cancelJob(jobId: string): Promise<CancelOutcome>;
}

/** Le service publie ses événements (phases + lifecycle) sur le bus Pi. */
export type { PiEvent };
