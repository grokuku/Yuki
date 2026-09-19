/**
 * Types PUBLICS de la façade `PiHost`.
 *
 * RÈGLE : aucun type du SDK Pi n'apparaît dans ce fichier. Tout ce qui sort de
 * la façade est du JSON simple, sérialisable, agnostique du SDK et du
 * fournisseur de modèle. La seule exception au principe d'encapsulation est
 * `src/pi/sdk-host.ts`, qui est le seul module autorisé à importer le SDK.
 */

import type { DelegateServicePort } from "../delegation/ports.js";
import type { ModelsConfig } from "../llm/models.js";

/** Niveaux de raisonnement acceptés par le SDK (repris tels quels). */
export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Sous-ensemble du logger d'observabilité utilisé par le domaine Pi. */
export interface PiLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Options de construction du host embarqué. */
export interface PiHostOptions {
  /** Répertoire d'état du SDK (settings.json, auth.json, models.json…). */
  agentDir: string;
  /** Répertoire de travail effectif (nomme le dossier de sessions). */
  cwd: string;
  /** Contenu du prompt système généraliste (remplace celui du SDK). */
  systemPrompt: string;
  /** Répertoire de stockage des sessions (JSONL). */
  sessionsDir?: string;
  /** Répertoire HOME inscriptible (replis du SDK via `os.homedir()`). */
  home?: string;
  /** Modèle par défaut, au format `provider/modelId` (ex. `llm-light/gemma4:31b`). */
  model?: string;
  /** Niveau de raisonnement initial. */
  thinking?: PiThinkingLevel;
  /** Fichier de réglages à seeder sur le volume au premier démarrage. */
  settingsSeedPath?: string;
  /**
   * Contenu GÉNÉRÉ de `models.json`, écrit sur le volume au démarrage (Lot 11).
   * Absent ⇒ le host n'écrit pas le fichier (tests, host nu).
   */
  modelsConfig?: ModelsConfig;
  /**
   * Allowlist d'outils (builtins + noms d'outils custom) imposée au SDK.
   * Remplace l'ancienne valeur `noTools: "all"` : le léger garde une liste
   * EXPLICITE (lecture seule + délégation), jamais d'écriture/exécution.
   */
  tools?: readonly string[];
  /** Outils custom opaques fournis par le câblage (SDK, hors façade). */
  customTools?: readonly unknown[];
  /** Source d'événements additionnels (délégation) relayée sur le bus. */
  eventSource?: PiEventSource;
  /**
   * Port de délégation. Présent ⇒ la façade construit et expose les outils
   * `delegate`/`job_status`/`cancel_job`. Absent ⇒ aucun outil de délégation.
   */
  delegation?: DelegateServicePort;
  /**
   * Faux ⇒ `send` échoue explicitement en `LLM_UNAVAILABLE` (clé légère
   * manquante). Une FONCTION est lue en direct (bascule à chaud des clés).
   */
  llmAvailable?: boolean | (() => boolean);
  logger: PiLogger;
}

/** Cible d'ouverture/remplacement de session. */
export interface EnsureSessionOptions {
  /** Reprend un fichier de session précis. */
  sessionFile?: string;
  /** Force la création d'une nouvelle session. */
  new?: boolean;
}

/** Options d'envoi d'un message (extensible — Lot 2 : origine et corrélation de job). */
export interface SendOptions {
  /** Modèle à utiliser pour ce tour (`provider/modelId`). Réservé. */
  model?: string;
  /** Niveau de raisonnement pour ce tour. Réservé. */
  thinking?: PiThinkingLevel;
  /**
   * Origine du message. `job_report` marque un prompt SYNTHÉTIQUE (report d'un
   * job d'arrière-plan) : l'UI ne doit pas afficher de bulle utilisateur.
   */
  origin?: string;
  /** Job d'arrière-plan à l'origine du message (corrélation). */
  jobId?: string;
}

/** Poignée renvoyée immédiatement par `send`. */
export interface RunHandle {
  runId: string;
  sessionId: string;
  /** `true` si le message a été mis en file derrière un run en vol. */
  queued: boolean;
}

/** États observables d'une session. */
export type PiSessionStateName = "idle" | "streaming" | "error";

/** Entrée de transcript : CONTENU SEUL (jamais de réflexion). */
export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

/** État d'une session, sérialisable tel quel. */
export interface SessionState {
  sessionId: string;
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
}

/** Informations sur une session persistée. */
export interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
  name?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
  firstMessage?: string;
}

/** Consommation de tokens d'un tour (agnostique du fournisseur). */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

/** Raison de fin de run. */
export type RunFinishReason = "done" | "abort" | "error";

/** Canal d'un delta : `thinking` transite mais n'est jamais une réponse. */
export type DeltaChannel = "content" | "thinking";

/** Statut terminal d'un job (sous-ensemble de `JobStatus`). */
export type PiJobTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/**
 * Événements de vie d'un job relayés sur le bus de la façade. Ils sont produits
 * par la couche délégation et rattachés à la session LÉGÈRE propriétaire.
 */
export type PiJobEvent =
  | { type: "job_started"; sessionId: string; jobId: string; task?: string }
  | {
      type: "job_finished";
      sessionId: string;
      jobId: string;
      status: PiJobTerminalStatus;
    }
  | { type: "job_report"; sessionId: string; jobId: string; runId?: string };

/** Événements normalisés émis par la façade. */
export type PiEvent =
  | {
      type: "run_started";
      sessionId: string;
      runId: string;
      userText?: string;
      /** Origine du run (`job_report` = prompt synthétique). */
      origin?: string;
      /** Job d'arrière-plan corrélé. */
      jobId?: string;
    }
  | {
      type: "delta";
      sessionId: string;
      runId: string;
      channel: DeltaChannel;
      text: string;
    }
  | {
      type: "run_finished";
      sessionId: string;
      runId: string;
      reason: RunFinishReason;
      usage?: PiUsage;
      errorMessage?: string;
    }
  | {
      type: "phase";
      sessionId: string;
      runId: string;
      stage: string;
      at: string;
      sinceT0Ms: number;
      /** Job corrélé à cet étage (instrumentation de la délégation). */
      jobId?: string;
    }
  | {
      type: "run_summary";
      sessionId: string;
      runId: string;
      ttftMs?: number;
      totalMs: number;
      tokensIn?: number;
      tokensOut?: number;
    }
  | {
      type: "state";
      sessionId: string;
      state: PiSessionStateName;
      activeRunId?: string;
    }
  | PiJobEvent;

/** Source d'événements additionnels relayés sur le bus (couche délégation). */
export interface PiEventSource {
  subscribe(listener: (event: PiEvent) => void): () => void;
}

export type PiEventListener = (event: PiEvent) => void;
