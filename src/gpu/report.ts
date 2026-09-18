/**
 * Construction et mise en forme du rapport GPU.
 *
 * La même structure `GpuReport` alimente la console, `/health` et la CLI.
 */

import type {
  CapabilityCheck,
  Capabilities,
  GpuInfo,
  GpuReport,
  GpuReportMode,
  GpuReportSource,
  ResolutionKind,
  ServiceRequirement,
} from "../types/gpu.js";
import { CAPABILITY_ORDER } from "../types/gpu.js";
import type { CompatService, GpuProfile } from "../types/profile.js";
import type { DetectionResult } from "./detect.js";
import {
  evaluateProfile,
  evaluateService,
  lowVramFreeWarning,
  summarizeCapabilities,
} from "./profiles.js";

export interface BuildReportInput {
  detection: DetectionResult;
  minDriver: number;
  resolvedProfile: GpuProfile;
  resolution: ResolutionKind;
  overrideRequested: string | null;
  mode: GpuReportMode;
  source?: GpuReportSource;
  requiredBy: Record<string, string[]>;
  /** Exigences par service du manifeste (asr/tts), évaluées hors profil. */
  services: Record<string, CompatService>;
  extraNotes?: string[];
}

function orderChecks(
  checks: CapabilityCheck[],
  requiredBy: Record<string, string[]>,
): CapabilityCheck[] {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const ordered: CapabilityCheck[] = [];
  for (const id of CAPABILITY_ORDER) {
    const check = byId.get(id);
    if (check) ordered.push({ ...check, requiredBy: requiredBy[id] ?? [] });
  }
  return ordered;
}

/**
 * Capacité mesurée mais hors critères de profil : affichée à titre informatif
 * (jamais `required`, donc jamais source de refus ni de downgrade).
 */
function informationalCheck(id: string, caps: Capabilities): CapabilityCheck {
  const value = caps[id];
  let ok = true;
  if (typeof value === "boolean") ok = value;
  else if (typeof value === "number") ok = value > 0;
  const detail =
    id === "driver.floor"
      ? "exigence de service (asr/tts) — sans effet sur le profil"
      : id === "gpu.vram.free"
        ? "mesure instantanée — avertissement uniquement"
        : undefined;
  return { id, required: false, ok, requiredBy: [], ...(detail ? { detail } : {}) };
}

/** Complète l'évaluation du profil avec les capacités purement informatives. */
function withInformational(
  checks: CapabilityCheck[],
  caps: Capabilities,
): CapabilityCheck[] {
  const present = new Set(checks.map((check) => check.id));
  const completed = [...checks];
  for (const id of CAPABILITY_ORDER) {
    if (!present.has(id)) completed.push(informationalCheck(id, caps));
  }
  return completed;
}

/** Construit le rapport GPU à partir de la détection et de la résolution. */
export function buildGpuReport(input: BuildReportInput): GpuReport {
  const { capabilities, best } = summarizeCapabilities(
    input.detection.gpus,
    input.minDriver,
  );
  const evaluation = evaluateProfile(input.resolvedProfile, capabilities);
  const checks = orderChecks(
    withInformational(evaluation.checks, capabilities),
    input.requiredBy,
  );

  const services: ServiceRequirement[] = Object.entries(input.services)
    .map(([service, definition]) => {
      const { satisfied, missing } = evaluateService(definition, capabilities);
      return {
        service,
        requiresGpu: definition.requiresGpu,
        status: definition.status,
        satisfied,
        missing,
      };
    })
    .sort((a, b) => a.service.localeCompare(b.service));

  const warning = lowVramFreeWarning(best);

  return {
    generatedAt: new Date().toISOString(),
    mode: input.mode,
    source: input.source ?? input.detection.source,
    overrideRequested: input.overrideRequested,
    gpus: input.detection.gpus,
    capabilities,
    checks,
    missingCapabilities: evaluation.missing,
    resolvedProfile: input.resolvedProfile.id,
    resolution: input.resolution,
    services,
    notes: [
      ...input.detection.notes,
      ...(warning ? [warning] : []),
      ...(input.extraNotes ?? []),
    ],
  };
}

function formatCapabilityValue(
  caps: Capabilities,
  id: string,
): string {
  const value = caps[id];
  if (value === undefined) return "N/A";
  if (typeof value === "boolean") return value ? "oui" : "non";
  return String(value);
}

function formatGpu(gpu: GpuInfo): string[] {
  const cc = gpu.computeCapability === null ? "inconnue" : String(gpu.computeCapability);
  const lines = [
    `  [${gpu.index}] ${gpu.name}`,
    `      driver        : ${gpu.driverVersion ?? "inconnu"}${
      gpu.cudaDriverVersion ? ` (CUDA ${gpu.cudaDriverVersion})` : ""
    }`,
    `      compute cap.  : ${cc}${gpu.bf16 ? " (BF16 : oui)" : " (BF16 : non)"}`,
    `      VRAM          : ${gpu.vramTotalMiB ?? "N/A"} MiB total / ${
      gpu.vramFreeMiB ?? "N/A"
    } MiB libre`,
  ];
  return lines;
}

/** Rendu texte lisible (console / CLI), jamais du JSON. */
export function formatReportConsole(report: GpuReport): string {
  const lines: string[] = [];
  lines.push("==================== Yuki — rapport GPU ====================");
  lines.push(`généré le        : ${report.generatedAt}`);
  lines.push(`mode             : ${report.mode}`);
  lines.push(`source           : ${report.source}`);
  lines.push(`override demandé : ${report.overrideRequested ?? "(aucun)"}`);
  lines.push(`profil résolu    : ${report.resolvedProfile}`);
  lines.push(`résolution       : ${report.resolution}`);
  lines.push("");

  if (report.gpus.length === 0) {
    lines.push("GPU détectés     : aucun");
  } else {
    lines.push(`GPU détectés (${report.gpus.length}) :`);
    for (const gpu of report.gpus) lines.push(...formatGpu(gpu));
  }
  lines.push("");

  lines.push("Capacités :");
  for (const check of report.checks) {
    const mark = check.ok ? "ok " : "KO ";
    const scope = check.required ? "requis" : "optionnel";
    const detail = check.detail ? ` — ${check.detail}` : "";
    const consumers = check.requiredBy.length > 0 ? ` [${check.requiredBy.join(", ")}]` : "";
    lines.push(
      `  ${mark} ${check.id.padEnd(22)} ${formatCapabilityValue(
        report.capabilities,
        check.id,
      ).padEnd(6)} (${scope})${consumers}${detail}`,
    );
  }
  lines.push("");

  if (report.services.length > 0) {
    lines.push("Services (exigences, hors profil) :");
    for (const service of report.services) {
      const mark = service.satisfied ? "ok " : "KO ";
      const missing =
        service.missing.length > 0 ? ` — manque : ${service.missing.join(", ")}` : "";
      lines.push(
        `  ${mark} ${service.service.padEnd(10)} (${service.status})${missing}`,
      );
    }
    lines.push("");
  }

  if (report.missingCapabilities.length > 0) {
    lines.push(
      `CAPACITÉS MANQUANTES : ${report.missingCapabilities.join(", ")}`,
    );
    lines.push("");
  }

  if (report.notes.length > 0) {
    lines.push("Notes :");
    for (const note of report.notes) lines.push(`  - ${note}`);
    lines.push("");
  }

  lines.push("============================================================");
  return lines.join("\n");
}
