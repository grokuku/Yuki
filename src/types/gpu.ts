/**
 * Types du rapport GPU — structure unique partagée par la console, l'API
 * `/health` et la CLI `gpu:report`.
 */

export type GpuReportMode = "ok" | "degraded" | "fatal";

export type GpuReportSource = "auto" | "env-override" | "simulated";

export type ResolutionKind =
  | "auto-highest-compatible"
  | "override-accepted"
  | "downgraded"
  | "override-refused";

/** Informations normalisées sur un GPU détecté. */
export interface GpuInfo {
  index: number;
  name: string;
  driverVersion: string | null;
  cudaDriverVersion: string | null;
  computeCapability: number | null;
  vramTotalMiB: number | null;
  vramFreeMiB: number | null;
  bf16: boolean;
}

/** Valeur d'une capacité : booléenne ou numérique (ex. MiB). */
export type CapabilityValue = boolean | number;

export type Capabilities = Record<string, CapabilityValue>;

/** Résultat d'évaluation d'une capacité dans le rapport. */
export interface CapabilityCheck {
  id: string;
  required: boolean;
  ok: boolean;
  requiredBy: string[];
  detail?: string;
}

/**
 * Exigence GPU d'un service du manifeste (ex. `asr`, `tts`), évaluée
 * indépendamment du profil résolu. Au Lot 0, aucune de ces exigences ne bloque
 * le démarrage : elles sont exposées à titre informatif (`to-confirm`).
 */
export interface ServiceRequirement {
  service: string;
  requiresGpu: boolean;
  status: "confirmed" | "to-confirm";
  satisfied: boolean;
  missing: string[];
}

/** Rapport GPU complet et sérialisable. */
export interface GpuReport {
  generatedAt: string;
  mode: GpuReportMode;
  source: GpuReportSource;
  overrideRequested: string | null;
  gpus: GpuInfo[];
  capabilities: Capabilities;
  checks: CapabilityCheck[];
  missingCapabilities: string[];
  resolvedProfile: string;
  resolution: ResolutionKind;
  /** Exigences de service (asr/tts), distinctes du profil résolu. */
  services: ServiceRequirement[];
  notes: string[];
}

/** Ordre d'affichage stable des capacités du rapport. */
export const CAPABILITY_ORDER = [
  "gpu.present",
  "gpu.computeCapability",
  "gpu.bf16",
  "gpu.vram.total",
  "gpu.vram.free",
  "driver.floor",
] as const;

export type CapabilityId = (typeof CAPABILITY_ORDER)[number];
