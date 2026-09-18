/**
 * Porte de compatibilité.
 *
 * `strict` (défaut) : un profil explicitement requis et non satisfait entraîne
 * un refus bruyant (sortie ≠ 0, serveur non démarré).
 * `auto-degrade` : sélectionne le plus haut profil compatible et démarre.
 *
 * `texte-seul` est toujours accepté.
 */

import type { Env } from "../config/env.js";
import type { Logger } from "../observability/logger.js";
import type { GpuReport, GpuReportMode } from "../types/gpu.js";
import type { CompatManifest, GpuProfile, ProfilesConfig } from "../types/profile.js";
import type { DetectionResult } from "./detect.js";
import {
  capabilityRequiredBy,
  evaluateProfile,
  findProfile,
  highestProfile,
  lowVramFreeWarning,
  pickHighestCompatible,
  summarizeCapabilities,
  type ProfileEvaluation,
} from "./profiles.js";
import { buildGpuReport } from "./report.js";

export interface GateInput {
  env: Env;
  profiles: ProfilesConfig;
  manifest: CompatManifest;
  detection: DetectionResult;
}

export interface GateResult {
  /** Faux uniquement en cas de refus strict. */
  passed: boolean;
  report: GpuReport;
  resolvedProfile: GpuProfile;
}

function resolveMode(
  profile: GpuProfile,
  gpuPresent: boolean,
): GpuReportMode {
  if (profile.id === "texte-seul") return "degraded";
  if (profile.requiresGpu && !gpuPresent) return "degraded";
  return "ok";
}

/**
 * Capacités requises non satisfaites, avec le détail du seuil franchi : rend
 * visibles (logs / rapport) les seuils qui provoquent un refus ou un downgrade.
 */
function failedChecks(
  evaluation: ProfileEvaluation,
): Array<{ id: string; detail?: string }> {
  return evaluation.checks
    .filter((check) => check.required && !check.ok)
    .map((check) => ({
      id: check.id,
      ...(check.detail ? { detail: check.detail } : {}),
    }));
}

/**
 * Applique la porte de compatibilité et produit le rapport associé.
 * Ne démarre rien : l'appelant décide (index.ts, CLI, tests).
 */
export function runGate(input: GateInput, logger: Logger): GateResult {
  const { env, profiles, manifest, detection } = input;
  const { capabilities, best } = summarizeCapabilities(detection.gpus, env.minDriver);
  const requiredBy = capabilityRequiredBy(profiles, manifest);
  const gpuPresent = capabilities["gpu.present"] === true;
  const override = env.profile;

  // Trace honnête du chemin de détection effectivement emprunté.
  logger.info("gpu.detect", {
    source: detection.source,
    gpuCount: detection.gpus.length,
    cudaDriverVersion: detection.cudaDriverVersion,
    detectionError: detection.error,
    notes: detection.notes,
  });

  // La VRAM libre est un avertissement, jamais un critère de profil.
  const freeWarning = lowVramFreeWarning(best);
  if (freeWarning) {
    logger.warn("gpu.vram.free low", {
      gpu: best?.name,
      vramTotalMiB: best?.vramTotalMiB,
      vramFreeMiB: best?.vramFreeMiB,
      note: freeWarning,
      effect: "avertissement uniquement — sans effet sur le profil",
    });
  }

  // --- Override explicite ---------------------------------------------------
  if (override) {
    const target = findProfile(profiles, override);
    if (!target) {
      const fallback = highestProfile(profiles);
      const report = buildGpuReport({
        detection,
        minDriver: env.minDriver,
        resolvedProfile: fallback,
        resolution: "override-refused",
        overrideRequested: override,
        mode: "fatal",
        requiredBy,
        services: manifest.services,
        extraNotes: [`profil inconnu « ${override} » : override refusé`],
      });
      logger.error("gpu.gate refused", {
        source: report.source,
        overrideRequested: override,
        resolvedProfile: fallback.id,
        resolution: "override-refused",
        missingCapabilities: ["profil-inconnu"],
      });
      return { passed: false, report, resolvedProfile: fallback };
    }

    const evaluation = evaluateProfile(target, capabilities);
    if (evaluation.ok) {
      const report = buildGpuReport({
        detection,
        minDriver: env.minDriver,
        resolvedProfile: target,
        resolution: "override-accepted",
        overrideRequested: override,
        mode: resolveMode(target, gpuPresent),
        requiredBy,
        services: manifest.services,
      });
      logger.info("gpu.gate resolved", {
        source: report.source,
        overrideRequested: override,
        resolvedProfile: target.id,
        resolution: "override-accepted",
      });
      return { passed: true, report, resolvedProfile: target };
    }

    if (env.compatMode === "strict") {
      const report = buildGpuReport({
        detection,
        minDriver: env.minDriver,
        resolvedProfile: target,
        resolution: "override-refused",
        overrideRequested: override,
        mode: "fatal",
        requiredBy,
        services: manifest.services,
        extraNotes: [
          `profil « ${target.id} » forcé par variable d'environnement (YUKI_PROFILE) et non satisfait : refus strict`,
        ],
      });
      logger.error("gpu.gate refused", {
        source: report.source,
        overrideRequested: override,
        resolvedProfile: target.id,
        resolution: "override-refused",
        missingCapabilities: report.missingCapabilities,
        failedChecks: failedChecks(evaluation),
        forcedByEnv: true,
      });
      return { passed: false, report, resolvedProfile: target };
    }

    // auto-degrade : descente vers le plus haut profil compatible.
    const { profile: resolved } = pickHighestCompatible(profiles, capabilities);
    const report = buildGpuReport({
      detection,
      minDriver: env.minDriver,
      resolvedProfile: resolved,
      resolution: "downgraded",
      overrideRequested: override,
      mode: "degraded",
      requiredBy,
      services: manifest.services,
      extraNotes: [
        `profil « ${target.id} » non satisfait ; descente automatique vers « ${resolved.id} »`,
      ],
    });
    logger.warn("gpu.gate downgraded", {
      source: report.source,
      overrideRequested: override,
      requestedProfile: target.id,
      resolvedProfile: resolved.id,
      resolution: "downgraded",
      missingCapabilities: evaluation.missing,
      failedChecks: failedChecks(evaluation),
    });
    logger.info("gpu.gate resolved", {
      source: report.source,
      overrideRequested: override,
      resolvedProfile: resolved.id,
      resolution: "downgraded",
    });
    return { passed: true, report, resolvedProfile: resolved };
  }

  // --- Pas d'override : résolution automatique ------------------------------
  const { profile: resolved } = pickHighestCompatible(profiles, capabilities);
  const highest = highestProfile(profiles);
  const downgradedInAuto = env.compatMode === "auto-degrade" && resolved.id !== highest.id;
  const resolution = downgradedInAuto ? "downgraded" : "auto-highest-compatible";
  const mode = downgradedInAuto ? "degraded" : resolveMode(resolved, gpuPresent);

  const report = buildGpuReport({
    detection,
    minDriver: env.minDriver,
    resolvedProfile: resolved,
    resolution,
    overrideRequested: null,
    mode,
    requiredBy,
    services: manifest.services,
  });

  if (downgradedInAuto) {
    const highestEvaluation = evaluateProfile(highest, capabilities);
    logger.warn("gpu.gate downgraded", {
      source: report.source,
      overrideRequested: null,
      requestedProfile: highest.id,
      resolvedProfile: resolved.id,
      resolution,
      missingCapabilities: highestEvaluation.missing,
      failedChecks: failedChecks(highestEvaluation),
    });
  }
  logger.info("gpu.gate resolved", {
    source: report.source,
    overrideRequested: null,
    resolvedProfile: resolved.id,
    resolution,
  });
  return { passed: true, report, resolvedProfile: resolved };
}
