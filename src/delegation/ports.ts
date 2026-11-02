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
  /**
   * Consignes de l'orchestrateur arrivées AVANT le démarrage du job (tampon de
   * la file d'admission) : intégrées au PREMIER message du sous-agent, sous un
   * cadrage explicite. Jamais perdues.
   */
  initialSteers?: readonly string[];
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
  /**
   * FICHIERS produits par la tâche (identifiants du store des fichiers de la
   * conversation propriétaire).
   *
   * ⚠️ Un job qui GÉNÈRE une image la copie dans ce store ; sans ce retour, le
   * rapport annoncerait du texte et l'image resterait invisible. Le worker les
   * remonte donc ICI, le service les journalise avec le résultat, et le réveil
   * les joint au message publié dans le canal.
   */
  fichiers?: readonly string[];
  /**
   * PHRASE écrite par le SERVEUR (jamais par un modèle), ajoutée TELLE QUELLE au
   * rapport de tâche.
   *
   * ⚠️ Elle voyage à part du texte parce que le rapport brut peut être reformulé :
   * un fait aussi structurant ne doit pas dépendre de la fidélité d'une rédaction.
   * Le réveil de canal l'insère dans le message SYSTÈME injecté
   * (`src/chat/reply/job-report.ts`), avant que Yuki ne rédige — donc jamais perdue.
   * ⚠️ Le worker lourd ne publie plus rien (invariant « un seul rédacteur ») : ce
   * champ n'a donc plus de producteur côté worker, mais le TRANSPORT reste : c'est
   * le seul endroit où le serveur peut faire passer une phrase sans passer par un
   * modèle.
   */
  repli?: string;
}

/**
 * Issue d'un `steer` remis au worker lourd.
 * - `injected` : remis au run EN COURS (pris en compte avant le prochain tour) ;
 * - `buffered` : session pas encore prête → tamponné, intégré au PREMIER message ;
 * - `full` : tampon plein (borne `MAX_PENDING_STEERS`) ;
 * - `finished` : job déjà terminé → non steerable.
 */
export type HeavySteerResult = "injected" | "buffered" | "full" | "finished";

export interface HeavyRunHandle {
  /** Résout toujours (jamais de rejet) avec l'issue du job. */
  readonly promise: Promise<HeavyRunResult>;
  /** Aborte la session éphémère et libère ses ressources. */
  cancel(): Promise<void>;
  /**
   * Transmet une consigne de l'orchestrateur au sous-agent. Tamponne tant que
   * le premier prompt n'a pas démarré (jamais perdue) ; l'injecte dans le run en
   * cours ensuite. Ne rejette jamais : renvoie une issue honnête.
   */
  steer(text: string): Promise<HeavySteerResult>;
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
    opts?: {
      origin?: string;
      jobId?: string;
      /**
       * FICHIERS produits par le job (identifiants du store de la
       * conversation). Le réveil de CANAL les RATTACHE au message système injecté,
       * pour que Yuki puisse les publier (ou qu'ils partent avec sa réponse) ; le
       * réveil LOCAL les ignore (le host ne connaît que du texte).
       *
       * ⚠️ Sans ce transport, déléguer une image donnerait une image que
       * personne ne voit : le rapport dirait « c'est fait », et le fichier
       * resterait dans le store.
       */
      fichiers?: readonly string[];
      /**
       * PHRASE écrite par le SERVEUR (`JobResult.repli`), insérée TELLE QUELLE dans
       * le message système injecté — jamais reformulée, jamais perdue.
       *
       * ⚠️ Le réveil LOCAL ne l'utilise pas : il reçoit le rapport BRUT, qui la
       * contient déjà.
       */
      repli?: string;
    },
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
  /**
   * E4 — `true` (DÉFAUT) : tâche de fond NON BLOQUANTE. On rend la main
   * IMMÉDIATEMENT avec un ticket ; le résultat sera réinjecté plus tard.
   * `false` : attente inline bornée par `deadlineMs` (enchaînement explicite).
   */
  background?: boolean;
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

/**
 * E4 — ACCUSÉ DE LANCEMENT d'une tâche de fond NON BLOQUANTE. ⚠️ Ce ticket
 * n'affirme AUCUN résultat : il annonce un lancement. Le résultat réel sera
 * réinjecté plus tard (`job_report`).
 */
export interface DelegateDispatched {
  status: "dispatched";
  job_id: string;
  note: string;
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
  /**
   * Motif EXACT du dépassement :
   *  - `timeout` — délai TOTAL de la tâche (`delegation.totalTimeoutMs`) ;
   *  - `idle_timeout` — plus aucun signe de vie du modèle (`delegation.idleTimeoutMs`) ;
   *  - `tool_timeout` — un OUTIL n'a pas rendu la main (chien de garde du worker).
   * ⚠️ Absent sur un ancien enregistrement de job (journal rejoué).
   */
  cause?: TimeoutCode;
  /**
   * Phrase EXPLICATIVE du worker, en français (durée, outil, incertitude sur
   * l'état de la machine). Destinée au MODÈLE : c'est elle qui l'empêche
   * d'inventer une cause (« la machine n'a pas répondu »).
   */
  note?: string;
  partial?: string;
}

/**
 * Codes d'échec d'un job qui sont des DÉPASSEMENTS DE DÉLAI (et non des pannes
 * du fournisseur ou de la machine). Source unique du classement.
 */
export const TIMEOUT_CODES = ["timeout", "idle_timeout", "tool_timeout"] as const;

/** Code d'un dépassement de délai. */
export type TimeoutCode = (typeof TIMEOUT_CODES)[number];

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
  | DelegateDispatched
  | DelegatePending
  | DelegateFailed
  | DelegateTimeout
  | DelegateCancelled
  | DelegateRejected
  | DelegateUnavailable;

/* -------------------------------------------------------------------------- */
/* Steer orchestrateur → sous-agent                                            */
/* -------------------------------------------------------------------------- */

/**
 * Consigne ACCEPTÉE : `injected` (remise au run en cours) ou `buffered`
 * (intégrée au PREMIER message car le sous-agent n'avait pas encore démarré).
 */
export interface SteerAccepted {
  status: "steered";
  job_id: string;
  delivery: "injected" | "buffered";
  /** Nombre de consignes en attente de démarrage (`buffered` uniquement). */
  pending?: number;
  note: string;
}

/** Aucun job ne porte cet identifiant. */
export interface SteerNotFound {
  status: "not_found";
  job_id: string;
  note: string;
}

/** Job non steerable : terminé, déjà livré, ou en cours d'achèvement. */
export interface SteerNotPossible {
  status: "not_steerable";
  job_id: string;
  job_status: JobStatus;
  reason: "job_finished" | "already_delivered" | "delivery_failed";
  note: string;
}

/** Tampon plein : borné volontairement, on refuse plutôt que de jeter en silence. */
export interface SteerBufferFull {
  status: "buffer_full";
  job_id: string;
  limit: number;
  note: string;
}

export type SteerOutcome =
  | SteerAccepted
  | SteerNotFound
  | SteerNotPossible
  | SteerBufferFull;

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
  /**
   * STEER orchestrateur → sous-agent : transmet une consigne à un job EN COURS
   * ou, s'il n'a pas encore démarré, la TAMPONNE pour son PREMIER message.
   * Renvoie toujours une issue honnête (jamais de succès silencieux).
   */
  steerJob(jobId: string, text: string): Promise<SteerOutcome>;
  /**
   * E5 — VÉRITÉ DE COMPLÉTION, lue dans le `JobStore` (jamais dans le texte du
   * modèle). `true` s'il reste du travail NON achevé pour cette session : au
   * moins un job NON terminal, OU un job terminé dont le résultat n'a pas
   * encore été livré. Le host s'en sert pour exposer l'état `waiting`.
   */
  hasPendingWork(sessionId: string): boolean;
  /**
   * E4/relais — JOBS D'ARRIÈRE-PLAN NON TERMINAUX d'une session légère : lecture
   * PURE du `JobStore` (source de vérité). Sert à injecter dans le prompt du
   * léger l'information « telle tâche tourne » (`job_id` utilisable pour
   * `steer_job`, intitulé, statut `queued`/`running`). Ne lève jamais.
   */
  pendingJobs(sessionId: string): PendingJobSummary[];
}

/**
 * Résumé MINIMAL d'un job d'arrière-plan NON terminal, pour l'injection
 * « quelle tâche tourne » dans le prompt du léger (relais).
 */
export interface PendingJobSummary {
  jobId: string;
  /** Intitulé de tâche fourni au `delegate`. */
  task: string;
  /** `queued` (en file d'admission) ou `running` (sous-agent en cours). */
  status: Extract<JobStatus, "queued" | "running">;
  /** Instant de démarrage réel (ISO), présent dès que le job a démarré. */
  startedAt?: string;
}

/** Le service publie ses événements (phases + lifecycle) sur le bus Pi. */
export type { PiEvent };
