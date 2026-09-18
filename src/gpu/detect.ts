/**
 * Détection GPU : orchestre l'interrogation de nvidia-smi (ou d'une fixture)
 * et la chaîne de repli compute capability.
 *
 * Ne calcule pas les capacités ni de profil : voir report.ts / gate.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { GpuInfo, GpuReportSource } from "../types/gpu.js";
import {
  type CommandResult,
  computeCapabilityFromName,
  deriveBf16,
  fallbackQueryArgs,
  looksLikeSmiError,
  parseCsvGpus,
  parseCudaVersion,
  parseFixtureSections,
  parseFullQuery,
  queryArgs,
  runCommand,
} from "./nvidia-smi.js";

export interface DetectOptions {
  /** Commande à exécuter (YUKI_GPU_CMD). */
  command: string;
  /** Fixture (YUKI_GPU_FIXTURE) : si présente, mode simulé. */
  fixture: string | null;
  /** Vrai si la commande provient explicitement de l'environnement. */
  commandFromEnv: boolean;
  cwd?: string;
  timeoutMs?: number;
  /** Exécuteur injectable (tests). */
  runner?: (command: string, args: string[]) => CommandResult;
}

export interface DetectionResult {
  gpus: GpuInfo[];
  source: GpuReportSource;
  cudaDriverVersion: string | null;
  notes: string[];
  error: string | null;
}

function withCuda(gpus: GpuInfo[], cuda: string | null): GpuInfo[] {
  return gpus.map((gpu) => ({ ...gpu, cudaDriverVersion: cuda }));
}

/** Fusionne des capacités calculées depuis le repli `-q`. */
function mergeFromFullQuery(gpus: GpuInfo[], fallback: GpuInfo[]): boolean {
  let used = false;
  for (const gpu of gpus) {
    if (gpu.computeCapability !== null) continue;
    const match =
      fallback.find((candidate) => candidate.index === gpu.index) ??
      fallback.find(
        (candidate) => candidate.name.toLowerCase() === gpu.name.toLowerCase(),
      );
    if (!match) continue;
    if (match.computeCapability !== null) {
      gpu.computeCapability = match.computeCapability;
      gpu.bf16 = deriveBf16(gpu.computeCapability);
      used = true;
    }
    gpu.driverVersion ??= match.driverVersion;
    gpu.vramTotalMiB ??= match.vramTotalMiB;
    gpu.vramFreeMiB ??= match.vramFreeMiB;
  }
  return used;
}

/** Dernier repli : table nom -> compute capability embarquée. */
function applyNameTable(gpus: GpuInfo[]): boolean {
  let used = false;
  for (const gpu of gpus) {
    if (gpu.computeCapability !== null) continue;
    const cc = computeCapabilityFromName(gpu.name);
    if (cc !== null) {
      gpu.computeCapability = cc;
      gpu.bf16 = deriveBf16(cc);
      used = true;
    }
  }
  return used;
}

/** Résout la compute capability manquante par `-q` puis table embarquée. */
function resolveComputeCapabilities(
  gpus: GpuInfo[],
  notes: string[],
  fullQueryText: string | null,
): void {
  const missing = gpus.some((gpu) => gpu.computeCapability === null);
  if (!missing) return;

  if (fullQueryText) {
    const full = parseFullQuery(fullQueryText);
    if (mergeFromFullQuery(gpus, full.gpus)) {
      notes.push("compute capability résolue via `nvidia-smi -q`");
    }
  }
  if (gpus.some((gpu) => gpu.computeCapability === null)) {
    if (applyNameTable(gpus)) {
      notes.push("compute capability résolue via la table nom→CC embarquée");
    }
  }
  for (const gpu of gpus) {
    if (gpu.computeCapability === null) {
      notes.push(`compute capability indéterminée pour « ${gpu.name} »`);
    }
  }
}

function detectFromFixture(options: DetectOptions): DetectionResult {
  const cwd = options.cwd ?? process.cwd();
  const fixturePath = resolve(cwd, options.fixture as string);
  const notes: string[] = [`mode simulé : fixture ${options.fixture}`];

  let text: string;
  try {
    text = readFileSync(fixturePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`fixture illisible : ${options.fixture}`);
    return {
      gpus: [],
      source: "simulated",
      cudaDriverVersion: null,
      notes,
      error: message,
    };
  }

  const sections = parseFixtureSections(text);
  const queryText = sections.query ?? text;
  const fullQueryText = sections.q ?? null;
  const plainText = sections.plain ?? null;

  const cuda =
    parseCudaVersion(plainText ?? "") ??
    parseCudaVersion(fullQueryText ?? "") ??
    parseCudaVersion(queryText);

  if (looksLikeSmiError(queryText) && parseCsvGpus(queryText).length === 0) {
    notes.push("la fixture indique l'absence de nvidia-smi ou de GPU");
    return {
      gpus: [],
      source: "simulated",
      cudaDriverVersion: cuda,
      notes,
      error: null,
    };
  }

  const gpus = parseCsvGpus(queryText, (reason) => notes.push(reason));
  if (gpus.length === 0) {
    notes.push("aucune ligne GPU exploitable dans la fixture");
  }
  resolveComputeCapabilities(gpus, notes, fullQueryText);
  return {
    gpus: withCuda(gpus, cuda),
    source: "simulated",
    cudaDriverVersion: cuda,
    notes,
    error: null,
  };
}

function detectFromCommand(options: DetectOptions): DetectionResult {
  const runner = options.runner ?? ((command, args) => runCommand(command, args));
  const notes: string[] = [];
  const source: GpuReportSource = options.commandFromEnv ? "env-override" : "auto";

  // --- 1. Requête principale (avec `compute_cap`) ---------------------------
  const primary = runner(options.command, queryArgs());
  let cuda = parseCudaVersion(primary.stdout);
  let gpus: GpuInfo[] = [];
  let error: string | null = null;
  let detectionPath = "requête principale (avec compute_cap)";

  if (primary.ok && !looksLikeSmiError(primary.stdout)) {
    gpus = parseCsvGpus(primary.stdout, (reason) => notes.push(reason));
    if (gpus.length === 0) {
      notes.push("la requête principale n'a retourné aucune ligne GPU exploitable");
    }
  } else {
    error = primary.error ?? "nvidia-smi a échoué";
    notes.push(`nvidia-smi indisponible : ${error}`);
  }

  // --- 2. Repli : requête sans `compute_cap` --------------------------------
  // Cas réel d'un driver qui ne connaît pas `compute_cap` : la requête
  // principale échoue, on retente sans le champ avant de conclure à l'absence.
  if (gpus.length === 0) {
    const fallback = runner(options.command, fallbackQueryArgs());
    if (fallback.ok && !looksLikeSmiError(fallback.stdout)) {
      const parsed = parseCsvGpus(fallback.stdout, (reason) => notes.push(reason));
      if (parsed.length > 0) {
        gpus = parsed;
        error = null;
        detectionPath = "requête de repli (sans compute_cap)";
        notes.push("GPU détecté via la requête de repli (sans compute_cap)");
      } else {
        notes.push("la requête de repli n'a retourné aucune ligne GPU exploitable");
      }
      cuda ??= parseCudaVersion(fallback.stdout);
    } else {
      notes.push(
        `requête de repli indisponible : ${fallback.error ?? "sortie en erreur"}`,
      );
    }
  }

  // --- 3. `-q` : compute capability, ou détection ultime --------------------
  let fullQueryText: string | null = null;
  const needsFullQuery =
    gpus.length === 0 ||
    gpus.some((gpu) => gpu.computeCapability === null) ||
    cuda === null;
  if (needsFullQuery) {
    const full = runner(options.command, ["-q"]);
    if (full.ok) {
      fullQueryText = full.stdout;
      const parsedFull = parseFullQuery(full.stdout);
      if (gpus.length === 0 && parsedFull.gpus.length > 0) {
        gpus = parsedFull.gpus;
        error = null;
        detectionPath = "nvidia-smi -q";
        notes.push("GPU détecté via `nvidia-smi -q`");
      }
    } else {
      notes.push(
        `nvidia-smi -q indisponible : ${full.error ?? "sortie en erreur"}`,
      );
    }
  }

  if (cuda === null) {
    if (fullQueryText) cuda = parseCudaVersion(fullQueryText);
    if (cuda === null) {
      const plain = runner(options.command, []);
      if (plain.ok) cuda = parseCudaVersion(plain.stdout);
    }
  }

  // --- 4. Dernier repli : table nom → compute capability --------------------
  resolveComputeCapabilities(gpus, notes, fullQueryText);

  if (gpus.length > 0) {
    notes.push(`chemin de détection retenu : ${detectionPath}`);
  } else if (error === null) {
    notes.push(
      "aucun GPU détecté après la chaîne de repli (requête, repli, nvidia-smi -q)",
    );
  }

  return {
    gpus: withCuda(gpus, cuda),
    source,
    cudaDriverVersion: cuda,
    notes,
    error,
  };
}

/** Point d'entrée de la détection GPU. */
export function detectGpus(options: DetectOptions): DetectionResult {
  return options.fixture
    ? detectFromFixture(options)
    : detectFromCommand(options);
}
