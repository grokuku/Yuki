/**
 * Routes de santé.
 *
 * /health/live  : vivant tant que le process tourne
 * /health/ready : prêt seulement si la porte de compatibilité ET le PiHost
 *                 sont prêts (503 sinon)
 * /health       : rapport complet (GPU, profil, volumes, uptime, sous-systèmes)
 */

import type { MountStatus } from "../../config/paths.js";
import type { GpuReport } from "../../types/gpu.js";

export type PiSubsystemStatus = "ready" | "starting" | "error";

export interface PiSubsystemSnapshot {
  status: PiSubsystemStatus;
  cwd: string;
  agentDir: string;
  sessionsDir: string;
  model?: string;
  sessionsCount: number;
  activeRuns: number;
}

/** État d'un rôle LLM (aucune clé n'est jamais exposée). */
export interface LlmRoleSnapshot {
  provider: string;
  model: string;
  status: "ready" | "unavailable";
  keyPresent: boolean;
}

export interface LlmSubsystemSnapshot {
  light: LlmRoleSnapshot;
  heavy: LlmRoleSnapshot;
}

/** Compteurs de jobs d'arrière-plan. */
export interface JobsSubsystemSnapshot {
  running: number;
  queued: number;
  completed: number;
  failed: number;
  interrupted: number;
  maxConcurrent: number;
}

export interface SubsystemsSnapshot {
  pi: PiSubsystemSnapshot;
  transport: {
    ws: { clients: number; replayBufferSize: number };
    sse: false;
  };
  llm: LlmSubsystemSnapshot;
  jobs: JobsSubsystemSnapshot;
}

export interface HealthDeps {
  version: string;
  startedAt: number;
  report: GpuReport;
  gatePassed: boolean;
  volumes: MountStatus[];
  /** État des sous-systèmes (Pi, transport). Absent au Lot 0 pur. */
  subsystems?: SubsystemsSnapshot;
  now?: () => number;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

/** Snapshot par défaut (aucun sous-système branché). */
export function emptySubsystems(): SubsystemsSnapshot {
  return {
    pi: {
      status: "starting",
      cwd: "",
      agentDir: "",
      sessionsDir: "",
      sessionsCount: 0,
      activeRuns: 0,
    },
    transport: {
      ws: { clients: 0, replayBufferSize: 0 },
      sse: false,
    },
    llm: {
      light: { provider: "", model: "", status: "unavailable", keyPresent: false },
      heavy: { provider: "", model: "", status: "unavailable", keyPresent: false },
    },
    jobs: {
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      maxConcurrent: 0,
    },
  };
}

export function healthLive(): RouteResponse {
  return { status: 200, body: { status: "ok" } };
}

function piReady(subsystems: SubsystemsSnapshot | undefined): boolean {
  // Absence de sous-systèmes = Lot 0 pur : la porte GPU suffit.
  if (!subsystems) return true;
  return subsystems.pi.status === "ready";
}

/** Le service est prêt si le LLM léger est disponible (clé présente). */
function lightLlmReady(subsystems: SubsystemsSnapshot | undefined): boolean {
  if (!subsystems) return true;
  return subsystems.llm.light.status === "ready";
}

export function healthReady(deps: HealthDeps): RouteResponse {
  if (!deps.gatePassed) {
    return {
      status: 503,
      body: {
        status: "not-ready",
        profile: deps.report.resolvedProfile,
        missingCapabilities: deps.report.missingCapabilities,
      },
    };
  }
  if (!piReady(deps.subsystems)) {
    return {
      status: 503,
      body: {
        status: "not-ready",
        profile: deps.report.resolvedProfile,
        pi: deps.subsystems?.pi.status,
      },
    };
  }
  if (!lightLlmReady(deps.subsystems)) {
    return {
      status: 503,
      body: {
        status: "not-ready",
        profile: deps.report.resolvedProfile,
        llm: deps.subsystems?.llm.light,
      },
    };
  }
  return {
    status: 200,
    body: { status: "ready", profile: deps.report.resolvedProfile },
  };
}

export function healthFull(deps: HealthDeps): RouteResponse {
  const now = deps.now ?? Date.now;
  const uptimeSeconds = Math.max(0, Math.round((now() - deps.startedAt) / 1000));
  return {
    status: 200,
    body: {
      status: deps.report.mode,
      version: deps.version,
      uptime: uptimeSeconds,
      gpu: deps.report,
      profile: deps.report.resolvedProfile,
      volumes: deps.volumes.map((volume) => ({
        id: volume.id,
        path: volume.containerPath,
        mode: volume.mode,
        exists: volume.exists,
        writable: volume.writable,
      })),
      subsystems: deps.subsystems ?? emptySubsystems(),
    },
  };
}
