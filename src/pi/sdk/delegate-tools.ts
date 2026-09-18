/**
 * Outils custom `delegate` / `job_status` / `cancel_job` (confidentiel —
 * `src/pi/sdk/**` uniquement).
 *
 * ⚠️ SEUL endroit où `typebox` est importé. Les outils reçoivent un port
 * `DelegateServicePort` pur : aucune logique de délégation ici.
 *
 * `delegate` démarre le job IMMÉDIATEMENT en arrière-plan puis attend, borné par
 * `deadline_ms` (défaut 1500, bornes 200–60000, clamp, non numérique → défaut).
 * Le job n'est JAMAIS annulé du fait de la deadline.
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  DelegateOutcome,
  DelegateServicePort,
  ModelAvailability,
} from "../../delegation/ports.js";
import type { JobRecord } from "../../jobs/types.js";

/** Contexte du run léger en cours (pour corréler le job au tour déclencheur). */
export interface RunContext {
  sessionId: string;
  runId: string;
}

export interface RunContextTracker {
  set(context: RunContext): void;
  clear(sessionId: string): void;
  current(sessionId?: string): RunContext | undefined;
}

/** Registre interne : un seul run léger actif à la fois. */
export function createRunContextTracker(): RunContextTracker {
  const bySession = new Map<string, RunContext>();
  return {
    set(context: RunContext): void {
      bySession.set(context.sessionId, context);
    },
    clear(sessionId: string): void {
      bySession.delete(sessionId);
    },
    current(sessionId?: string): RunContext | undefined {
      if (sessionId) return bySession.get(sessionId);
      const values = [...bySession.values()];
      return values.length > 0 ? values[values.length - 1] : undefined;
    },
  };
}

export interface DelegateToolsConfig {
  service: DelegateServicePort;
  tracker: RunContextTracker;
  /** Réservé : garde-fou de disponibilité côté outil. */
  availability?: ModelAvailability;
  deadlineDefaultMs?: number;
}

function sessionIdFromContext(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId() || undefined;
  } catch {
    return undefined;
  }
}

/** Coerce une valeur LLM en nombre (entier) ou `undefined` (= défaut). */
function coerceDeadline(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function summarizeJob(record: JobRecord): Record<string, unknown> {
  return {
    job_id: record.id,
    status: record.status,
    task: record.task,
    ...(record.result.text !== undefined ? { result: record.result.text } : {}),
    ...(record.result.partial !== undefined
      ? { partial: record.result.partial }
      : {}),
    ...(record.result.usage !== undefined ? { usage: record.result.usage } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    notified: record.notified,
    created_at: record.createdAt,
    ...(record.startedAt !== undefined ? { started_at: record.startedAt } : {}),
    ...(record.finishedAt !== undefined
      ? { finished_at: record.finishedAt }
      : {}),
  };
}

function textResult(payload: unknown, details: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details,
  };
}

/** Construit les trois outils de délégation exposés au léger. */
export function createDelegateTools(
  config: DelegateToolsConfig,
): ToolDefinition[] {
  const delegate = defineTool({
    name: "delegate",
    label: "Déléguer une tâche",
    description:
      "Confie une tâche complexe à un worker lourd qui s'exécute en arrière-plan. " +
      "Renvoie le résultat inline si la tâche finit dans la deadline, sinon un " +
      "identifiant de job à suivre avec job_status. La tâche n'est jamais annulée.",
    promptSnippet: "delegate(task, context?, deadline_ms?) — tâche lourde en arrière-plan",
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "Description précise de la tâche à exécuter.",
      }),
      context: Type.Optional(
        Type.String({
          maxLength: 8000,
          description: "Contexte facultatif pour la tâche.",
        }),
      ),
      deadline_ms: Type.Optional(
        Type.Union([Type.Integer(), Type.String(), Type.Null()], {
          description:
            "Durée max d'attente inline en ms (défaut 1500, bornée 200–60000).",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const context = config.tracker.current() ?? undefined;
      const sessionId =
        context?.sessionId ?? sessionIdFromContext(ctx) ?? "";
      const deadlineMs = coerceDeadline(
        (params as { deadline_ms?: unknown }).deadline_ms,
      );
      const task = (params as { task: string }).task;
      const contextText = (params as { context?: string }).context;
      const outcome: DelegateOutcome = await config.service.delegate({
        task,
        lightSessionId: sessionId,
        ...(contextText !== undefined ? { context: contextText } : {}),
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        ...(context?.runId ? { parentRunId: context.runId } : {}),
        ...(signal ? { signal } : {}),
      });
      return textResult(outcome, outcome);
    },
  });

  const jobStatus = defineTool({
    name: "job_status",
    label: "État d'un job",
    description:
      "Renvoie l'état courant d'un job d'arrière-plan (statut, résultat partiel, erreur).",
    parameters: Type.Object({
      job_id: Type.String({ minLength: 1, description: "Identifiant du job." }),
    }),
    execute: async (_toolCallId, params) => {
      const jobId = (params as { job_id: string }).job_id;
      const record = config.service.jobStatus(jobId);
      if (!record) {
        return textResult({ status: "not_found", job_id: jobId }, null);
      }
      const summary = summarizeJob(record);
      return textResult(summary, summary);
    },
  });

  const cancelJob = defineTool({
    name: "cancel_job",
    label: "Annuler un job",
    description:
      "Annule un job d'arrière-plan en file ou en cours. Sans effet s'il est terminé.",
    parameters: Type.Object({
      job_id: Type.String({ minLength: 1, description: "Identifiant du job." }),
    }),
    execute: async (_toolCallId, params) => {
      const jobId = (params as { job_id: string }).job_id;
      const outcome = await config.service.cancelJob(jobId);
      return textResult(outcome, outcome);
    },
  });

  return [delegate, jobStatus, cancelJob];
}
