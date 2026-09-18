/**
 * Chargement des profils/manifestes et logique de résolution de profil.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Capabilities,
  CapabilityCheck,
  GpuInfo,
} from "../types/gpu.js";
import type {
  CompatManifest,
  CompatService,
  GpuProfile,
  ProfilesConfig,
} from "../types/profile.js";
import { driverMajor } from "./nvidia-smi.js";

export interface CapabilitySummary {
  capabilities: Capabilities;
  best: GpuInfo | null;
}

export interface ProfileEvaluation {
  profileId: string;
  ok: boolean;
  missing: string[];
  checks: CapabilityCheck[];
}

function defaultConfigDir(): string {
  // src/gpu/profiles.ts -> <root>/config ; dist/gpu/profiles.js -> <root>/config
  return fileURLToPath(new URL("../../config", import.meta.url));
}

function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fichier de configuration introuvable ou illisible : ${filePath} (${message})`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON invalide dans ${filePath} : ${message}`);
  }
}

function resolveConfigFile(configDir: string | undefined, file: string): string {
  const candidates: string[] = [];
  if (configDir && configDir.trim() !== "") {
    candidates.push(resolve(configDir, file));
  }
  candidates.push(resolve(defaultConfigDir(), file));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

/** Charge et valide `config/gpu-profiles.json`. */
export function loadProfiles(configDir?: string): ProfilesConfig {
  const filePath = resolveConfigFile(configDir, "gpu-profiles.json");
  const parsed = readJson(filePath) as ProfilesConfig;

  if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
    throw new Error(`Profils manquants dans ${filePath}`);
  }
  const seen = new Set<string>();
  for (const profile of parsed.profiles) {
    if (!profile || typeof profile.id !== "string" || profile.id === "") {
      throw new Error(`Profil sans identifiant dans ${filePath}`);
    }
    if (seen.has(profile.id)) {
      throw new Error(`Profil dupliqué « ${profile.id} » dans ${filePath}`);
    }
    seen.add(profile.id);
    if (typeof profile.rank !== "number") {
      throw new Error(`Profil « ${profile.id} » sans rang numérique dans ${filePath}`);
    }
  }
  return parsed;
}

/** Charge et valide `config/compat-manifest.json`. */
export function loadCompatManifest(configDir?: string): CompatManifest {
  const filePath = resolveConfigFile(configDir, "compat-manifest.json");
  const parsed = readJson(filePath) as CompatManifest;
  if (!parsed || !Array.isArray(parsed.capabilities)) {
    throw new Error(`Capacités manquantes dans ${filePath}`);
  }
  return parsed;
}

/**
 * Seuil d'avertissement de VRAM libre (informational uniquement, documenté).
 *
 * En dessous de ce ratio de VRAM totale disponible, la VRAM libre est signalée
 * comme basse dans le rapport (note + WARN). Cette mesure est **instantanée** :
 * elle ne doit JAMAIS influencer la résolution de profil (sinon une carte 12 Go
 * parfaitement capable serait rétrogradée à tort si un autre processus occupait
 * la VRAM au démarrage).
 */
export const LOW_VRAM_FREE_RATIO = 0.15;

/**
 * Sélectionne le « meilleur » GPU : VRAM totale, puis index.
 *
 * La VRAM libre n'intervient volontairement PAS : elle ne doit jamais
 * conditionner quelle carte — donc quelle compute capability / VRAM totale —
 * sert à résoudre le profil.
 */
export function pickBestGpu(gpus: GpuInfo[]): GpuInfo | null {
  let best: GpuInfo | null = null;
  for (const gpu of gpus) {
    if (!best) {
      best = gpu;
      continue;
    }
    const total = gpu.vramTotalMiB ?? -1;
    const bestTotal = best.vramTotalMiB ?? -1;
    if (total > bestTotal || (total === bestTotal && gpu.index < best.index)) {
      best = gpu;
    }
  }
  return best;
}

/**
 * Note d'avertissement si la VRAM libre du GPU retenu est basse, sinon `null`.
 *
 * Avertissement **documentaire** : n'entre ni dans `missingCapabilities`, ni
 * dans le choix du profil. Un GPU dont la VRAM totale suffit reste éligible au
 * profil correspondant quelle que soit la VRAM libre du moment.
 */
export function lowVramFreeWarning(gpu: GpuInfo | null): string | null {
  if (!gpu) return null;
  const total = gpu.vramTotalMiB;
  const free = gpu.vramFreeMiB;
  if (total === null || free === null || total <= 0) return null;
  if (free / total >= LOW_VRAM_FREE_RATIO) return null;
  const percent = Math.round((free / total) * 100);
  return (
    `VRAM libre basse : ${free} MiB / ${total} MiB (${percent} % < ${Math.round(
      LOW_VRAM_FREE_RATIO * 100,
    )} %) — avertissement uniquement, sans effet sur le profil résolu ; ` +
    `vérifier les processus occupant le GPU`
  );
}

/** Calcule les capacités observées à partir des GPU détectés. */
export function summarizeCapabilities(
  gpus: GpuInfo[],
  minDriver: number,
): CapabilitySummary {
  const best = pickBestGpu(gpus);
  const major = driverMajor(best?.driverVersion ?? null);
  const capabilities: Capabilities = {
    "gpu.present": best !== null,
    "gpu.computeCapability": best?.computeCapability ?? 0,
    "gpu.bf16": best?.bf16 ?? false,
    "gpu.vram.total": best?.vramTotalMiB ?? 0,
    "gpu.vram.free": best?.vramFreeMiB ?? 0,
    "driver.floor": major !== null && major >= minDriver,
  };
  return { capabilities, best };
}

function numberCapability(caps: Capabilities, id: string): number {
  const value = caps[id];
  return typeof value === "number" ? value : 0;
}

function booleanCapability(caps: Capabilities, id: string): boolean {
  return caps[id] === true;
}

export interface ServiceEvaluation {
  satisfied: boolean;
  missing: string[];
}

/**
 * Évalue une exigence de service (ex. `asr`, `tts`) face aux capacités
 * observées. Une valeur de capacité illisible/absente fait échouer l'exigence —
 * jamais de faux positif (même règle que pour les profils).
 */
export function evaluateService(
  definition: CompatService,
  caps: Capabilities,
): ServiceEvaluation {
  const missing = definition.capabilities.filter((id) => {
    const value = caps[id];
    if (typeof value === "boolean") return !value;
    if (typeof value === "number") return value <= 0;
    return true;
  });
  return { satisfied: missing.length === 0, missing };
}

/** Identifiants de capacités exigés par un profil. */
export function profileCapabilityIds(profile: GpuProfile): string[] {
  const ids: string[] = [];
  if (profile.requiresGpu) ids.push("gpu.present");
  if (profile.minComputeCapability !== null) ids.push("gpu.computeCapability");
  if (profile.bf16Required) ids.push("gpu.bf16");
  if (profile.minVramTotalMiB > 0) ids.push("gpu.vram.total");
  return [...new Set(ids)];
}

/** Évalue un profil face aux capacités observées. */
export function evaluateProfile(
  profile: GpuProfile,
  caps: Capabilities,
): ProfileEvaluation {
  const checks: CapabilityCheck[] = [];
  const add = (
    id: string,
    required: boolean,
    ok: boolean,
    detail?: string,
  ): void => {
    checks.push({ id, required, ok: !required || ok, requiredBy: [], ...(detail ? { detail } : {}) });
  };

  add(
    "gpu.present",
    profile.requiresGpu,
    booleanCapability(caps, "gpu.present"),
    profile.requiresGpu && !booleanCapability(caps, "gpu.present")
      ? "aucun GPU détecté"
      : undefined,
  );

  const ccRequired = profile.minComputeCapability !== null;
  const ccValue = numberCapability(caps, "gpu.computeCapability");
  const ccOk = ccRequired ? ccValue >= (profile.minComputeCapability ?? 0) : true;
  add(
    "gpu.computeCapability",
    ccRequired,
    ccOk,
    ccRequired
      ? `${ccValue} ${ccOk ? ">=" : "<"} ${profile.minComputeCapability}`
      : undefined,
  );

  add(
    "gpu.bf16",
    profile.bf16Required,
    booleanCapability(caps, "gpu.bf16"),
    profile.bf16Required && !booleanCapability(caps, "gpu.bf16")
      ? "BF16 requis (compute capability >= 8.0)"
      : undefined,
  );

  const totalRequired = profile.minVramTotalMiB > 0;
  const totalValue = numberCapability(caps, "gpu.vram.total");
  const totalOk = totalRequired ? totalValue >= profile.minVramTotalMiB : true;
  add(
    "gpu.vram.total",
    totalRequired,
    totalOk,
    totalRequired
      ? `VRAM totale ${totalValue} MiB ${totalOk ? ">=" : "<"} ${profile.minVramTotalMiB} MiB`
      : undefined,
  );

  const missing = checks
    .filter((check) => check.required && !check.ok)
    .map((check) => check.id);
  return { profileId: profile.id, ok: missing.length === 0, missing, checks };
}

/** Profil portant le plus haut rang. */
export function highestProfile(config: ProfilesConfig): GpuProfile {
  return [...config.profiles].sort((a, b) => b.rank - a.rank)[0] as GpuProfile;
}

/** Plus haut profil compatible avec les capacités observées. */
export function pickHighestCompatible(
  config: ProfilesConfig,
  caps: Capabilities,
): { profile: GpuProfile; evaluation: ProfileEvaluation } {
  const ordered = [...config.profiles].sort((a, b) => b.rank - a.rank);
  for (const profile of ordered) {
    const evaluation = evaluateProfile(profile, caps);
    if (evaluation.ok) return { profile, evaluation };
  }
  const fallback =
    ordered.find((profile) => profile.id === "texte-seul") ??
    (ordered[ordered.length - 1] as GpuProfile);
  return { profile: fallback, evaluation: evaluateProfile(fallback, caps) };
}

/** Recherche un profil par identifiant. */
export function findProfile(
  config: ProfilesConfig,
  id: string,
): GpuProfile | undefined {
  return config.profiles.find((profile) => profile.id === id);
}

/**
 * Construit la carte « capacité -> consommateurs » (profils + services).
 */
export function capabilityRequiredBy(
  config: ProfilesConfig,
  manifest: CompatManifest,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  const push = (id: string, consumer: string): void => {
    map[id] ??= [];
    if (!map[id].includes(consumer)) map[id].push(consumer);
  };

  for (const profile of config.profiles) {
    for (const id of profileCapabilityIds(profile)) push(id, profile.id);
  }
  for (const [service, definition] of Object.entries(manifest.services)) {
    for (const id of definition.capabilities) push(id, service);
  }
  for (const id of Object.keys(map)) map[id].sort();
  return map;
}
