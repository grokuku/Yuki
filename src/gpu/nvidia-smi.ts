/**
 * Interrogation et analyse de `nvidia-smi`.
 *
 * Aucune dépendance externe : `node:child_process` et `node:fs` seulement.
 *
 * Chaîne de détection (voir detect.ts) :
 *   1. `--query-gpu=index,name,driver_version,compute_cap,memory.total,memory.free`
 *   2. repli `nvidia-smi -q` (champ « Compute Capability »)
 *   3. repli table nom -> compute capability embarquée
 */

import { spawnSync } from "node:child_process";

import type { GpuInfo } from "../types/gpu.js";

/** Champs demandés à la commande principale, dans l'ordre. */
export const QUERY_FIELDS = [
  "index",
  "name",
  "driver_version",
  "compute_cap",
  "memory.total",
  "memory.free",
] as const;

/** Variante de repli sans `compute_cap`. */
export const FALLBACK_QUERY_FIELDS = [
  "index",
  "name",
  "driver_version",
  "memory.total",
  "memory.free",
] as const;

/** Arguments de la requête CSV principale. */
export function queryArgs(): string[] {
  return [
    `--query-gpu=${QUERY_FIELDS.join(",")}`,
    "--format=csv,noheader,nounits",
  ];
}

/** Arguments de la requête CSV de repli (sans `compute_cap`). */
export function fallbackQueryArgs(): string[] {
  return [
    `--query-gpu=${FALLBACK_QUERY_FIELDS.join(",")}`,
    "--format=csv,noheader,nounits",
  ];
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
}

/** Exécute une commande de manière synchrone et capture sa sortie. */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): CommandResult {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (result.error) {
      return {
        ok: false,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error.message,
      };
    }
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const ok = result.status === 0;
    return {
      ok,
      stdout,
      stderr,
      error: ok
        ? null
        : stderr.trim() || `code de sortie ${result.status ?? "inconnu"}`,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Reconnaît les sorties d'erreur typiques de nvidia-smi / du shell. */
export function looksLikeSmiError(text: string): boolean {
  return /command not found|nvidia-smi: not found|no such file|No devices were found|NVIDIA-SMI has failed|Unable to determine|Insufficient Permissions|permission denied/i.test(
    text,
  );
}

/** Extrait la version CUDA du driver (« CUDA Version : 13.4 »). */
export function parseCudaVersion(text: string): string | null {
  const match = text.match(/CUDA Version\s*:\s*([0-9]+(?:\.[0-9]+)*)/i);
  return match?.[1] ?? null;
}

/** Extrait la version du driver d'une sortie `-q` (« Driver Version : x »). */
export function parseDriverVersion(text: string): string | null {
  const match = text.match(/^\s*Driver Version\s*:\s*([0-9]+(?:\.[0-9]+)*)/im);
  return match?.[1] ?? null;
}

/** BF16 dérivé de la compute capability (>= 8.0). */
export function deriveBf16(computeCapability: number | null): boolean {
  return computeCapability !== null && computeCapability >= 8.0;
}

/** Majeure d'une version de driver (« 615.71.09 » -> 615). */
export function driverMajor(driverVersion: string | null): number | null {
  if (!driverVersion) return null;
  const match = driverVersion.match(/^(\d+)/);
  return match ? Number.parseInt(match[1] as string, 10) : null;
}

function parseNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/\[|\]/g, "")
    .replace(/MiB|MB|GiB|N\/A/gi, "")
    .trim();
  if (cleaned === "") return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

function parseIntOrNull(raw: string): number | null {
  const value = parseNumber(raw);
  return value === null ? null : Math.trunc(value);
}

/** Entier strict d'un champ CSV (`nounits` ne produit que des entiers positifs). */
const CSV_INTEGER_RE = /^\d+$/;

/** Compute capability attendue en CSV : `majeure.mineure` (ex. `8.6`). */
const CSV_COMPUTE_CAP_RE = /^\d+\.\d+$/;

function parseCsvInteger(raw: string): number | null {
  const cleaned = raw.trim();
  return CSV_INTEGER_RE.test(cleaned) ? Number.parseInt(cleaned, 10) : null;
}

function parseComputeCapability(raw: string): number | null {
  const cleaned = raw.trim();
  return CSV_COMPUTE_CAP_RE.test(cleaned) ? Number(cleaned) : null;
}

function truncateForLog(text: string, max = 120): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Découpe une ligne CSV en respectant les guillemets doubles : nvidia-smi
 * encadre d'un `"` les champs contenant une virgule. Un `""` interne est un
 * guillemet échappé. Une virgule « nue » (hors guillemets) reste un séparateur.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

function parseStringOrNull(raw: string): string | null {
  const cleaned = raw.trim();
  if (cleaned === "" || /^N\/A$/i.test(cleaned)) return null;
  return cleaned;
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

interface CsvRow {
  index: number | null;
  name: string;
  driverVersion: string | null;
  computeCapability: number | null;
  vramTotalMiB: number | null;
  vramFreeMiB: number | null;
}

/**
 * Analyse une sortie `--format=csv,noheader,nounits`.
 *
 * Reconnaissance ancrée sur les **types** : l'index et les deux valeurs de VRAM
 * doivent être des entiers, la compute capability doit valoir `\d+.\d+` (ou
 * `N/A`/vide, traitée comme absente). Le nombre de champs doit être exactement
 * 6 (avec `compute_cap`) ou 5 (requête de repli).
 *
 * Toute ligne non conforme est **ignorée** (et signalée via `onSkip`) plutôt que
 * d'être alignée au hasard : un champ contenant une virgule non quotée décale
 * les colonnes et ne doit jamais produire un GPU fantôme ni une capacité haute.
 *
 * `onSkip` reçoit le motif d'ignorance (destiné au rapport / aux logs).
 */
export function parseCsvGpus(
  stdout: string,
  onSkip: (reason: string) => void = () => {},
): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (isIgnorableLine(line)) continue;
    const columns = splitCsvLine(line);

    if (columns.length !== 5 && columns.length !== 6) {
      onSkip(
        `ligne ignorée (${columns.length} champs, attendu 5 ou 6) : ${truncateForLog(line)}`,
      );
      continue;
    }

    const index = parseCsvInteger(columns[0] as string);
    if (index === null) {
      onSkip(
        `ligne ignorée (index non entier ${JSON.stringify(columns[0])}) : ${truncateForLog(line)}`,
      );
      continue;
    }

    const name = parseStringOrNull(columns[1] as string);
    if (name === null) {
      onSkip(`ligne ignorée (nom de GPU absent) : ${truncateForLog(line)}`);
      continue;
    }

    const hasComputeCap = columns.length === 6;
    const rawComputeCap = hasComputeCap ? (columns[3] as string) : "";
    const computeCapability = parseComputeCapability(rawComputeCap);
    if (
      hasComputeCap &&
      computeCapability === null &&
      parseStringOrNull(rawComputeCap) !== null
    ) {
      // Valeur présente mais illisible : la capacité échoue, on ne devine pas.
      onSkip(
        `compute capability illisible pour « ${name} » : ${JSON.stringify(rawComputeCap)}`,
      );
    }

    const totalColumn = hasComputeCap ? columns[4] : columns[3];
    const freeColumn = hasComputeCap ? columns[5] : columns[4];
    const vramTotalMiB = parseCsvInteger(totalColumn as string);
    const vramFreeMiB = parseCsvInteger(freeColumn as string);
    if (vramTotalMiB === null || vramFreeMiB === null) {
      onSkip(
        `ligne ignorée (VRAM non entière ${JSON.stringify(totalColumn)} / ${JSON.stringify(freeColumn)}) : ${truncateForLog(line)}`,
      );
      continue;
    }

    gpus.push({
      index,
      name,
      driverVersion: parseStringOrNull(columns[2] as string),
      cudaDriverVersion: null,
      computeCapability,
      vramTotalMiB,
      vramFreeMiB,
      bf16: deriveBf16(computeCapability),
    });
  }
  return gpus;
}

export interface FullQueryResult {
  gpus: GpuInfo[];
  driverVersion: string | null;
  cudaVersion: string | null;
}

/**
 * Analyse une sortie `nvidia-smi -q` (log multi-lignes).
 */
export function parseFullQuery(stdout: string): FullQueryResult {
  const driverVersion = parseDriverVersion(stdout);
  const cudaVersion = parseCudaVersion(stdout);

  const gpus: GpuInfo[] = [];
  const lines = stdout.split(/\r?\n/);
  let current: Partial<CsvRow> | null = null;
  let section = "";

  const flush = (): void => {
    if (!current || !current.name) {
      current = null;
      return;
    }
    gpus.push({
      index: current.index ?? gpus.length,
      name: current.name,
      driverVersion: current.driverVersion ?? driverVersion,
      cudaDriverVersion: cudaVersion,
      computeCapability: current.computeCapability ?? null,
      vramTotalMiB: current.vramTotalMiB ?? null,
      vramFreeMiB: current.vramFreeMiB ?? null,
      bf16: deriveBf16(current.computeCapability ?? null),
    });
    current = null;
  };

  for (const line of lines) {
    if (/^GPU\s+[0-9a-fA-F:.]+\s*$/.test(line.trim())) {
      flush();
      current = { index: gpus.length };
      section = "";
      continue;
    }
    if (!current) continue;

    const kv = line.match(/^\s+([A-Za-z][A-Za-z0-9 /()_-]*?)\s*:\s*(.*)$/);
    if (line.trim().length > 0 && !kv) {
      const heading = line.trim();
      section = /^FB Memory Usage$/i.test(heading) ? "fb-memory" : heading;
      continue;
    }
    if (!kv) continue;

    const key = (kv[1] as string).trim();
    const value = (kv[2] as string).trim();

    if (/^Product Name$/i.test(key)) {
      current.name = parseStringOrNull(value) ?? undefined;
      section = "";
    } else if (/^Compute Capability$/i.test(key)) {
      current.computeCapability = parseNumber(value);
      section = "";
    } else if (/^Total$/i.test(key) && section === "fb-memory") {
      current.vramTotalMiB = parseIntOrNull(value);
    } else if (/^Free$/i.test(key) && section === "fb-memory") {
      current.vramFreeMiB = parseIntOrNull(value);
    }
  }
  flush();

  return { gpus, driverVersion, cudaVersion };
}

/**
 * Table nom -> compute capability embarquée (dernier repli).
 *
 * Correspondance par sous-chaîne la plus longue, insensible à la casse.
 */
const NAME_TO_COMPUTE_CAPABILITY: ReadonlyArray<readonly [string, number]> = [
  ["Quadro RTX 8000", 7.5],
  ["Quadro RTX 6000", 7.5],
  ["Quadro RTX 5000", 7.5],
  ["Quadro RTX 4000", 7.5],
  ["Tesla T4", 7.5],
  ["NVIDIA T4", 7.5],
  ["RTX 4090", 8.9],
  ["RTX 4080", 8.9],
  ["RTX 4070", 8.9],
  ["RTX 4060", 8.9],
  ["RTX 3090", 8.6],
  ["RTX 3080", 8.6],
  ["RTX 3070", 8.6],
  ["RTX 3060", 8.6],
  ["RTX 2080", 7.5],
  ["RTX 2070", 7.5],
  ["RTX 2060", 7.5],
  ["A100", 8.0],
  ["H100", 9.0],
  ["A40", 8.6],
  ["A10", 8.6],
  ["L40", 8.9],
  ["L4", 8.9],
  ["V100", 7.0],
];

/** Dérive la compute capability depuis le nom du GPU (repli final). */
export function computeCapabilityFromName(name: string): number | null {
  const haystack = name.toLowerCase();
  let best: { length: number; value: number } | null = null;
  for (const [needle, value] of NAME_TO_COMPUTE_CAPABILITY) {
    if (haystack.includes(needle.toLowerCase())) {
      if (!best || needle.length > best.length) {
        best = { length: needle.length, value };
      }
    }
  }
  return best?.value ?? null;
}

/**
 * Découpe un fichier fixture en sections.
 *
 * Format : une ligne `#:section <nom>` ouvre une section. Les lignes
 * commençant par `#` (hors en-tête de section) sont des commentaires.
 * Sans en-tête, tout le contenu appartient à la section implicite `query`.
 */
export function parseFixtureSections(text: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let current = "query";
  let seenHeader = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*#:section\s+([A-Za-z0-9_-]+)\s*$/);
    if (header) {
      seenHeader = true;
      current = header[1] as string;
      if (!(current in sections)) sections[current] = [];
      continue;
    }
    if (!seenHeader && line.trim().startsWith("#")) continue;
    (sections[current] ??= []).push(line);
  }
  const out: Record<string, string> = {};
  for (const [name, lines] of Object.entries(sections)) {
    out[name] = lines.join("\n");
  }
  return out;
}
