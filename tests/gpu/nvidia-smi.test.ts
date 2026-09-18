import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { detectGpus } from "../../src/gpu/detect.js";
import {
  computeCapabilityFromName,
  deriveBf16,
  driverMajor,
  looksLikeSmiError,
  parseCsvGpus,
  parseCudaVersion,
  parseFixtureSections,
  parseFullQuery,
} from "../../src/gpu/nvidia-smi.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/gpu/", import.meta.url));

function fixture(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

function fixturePath(name: string): string {
  return `tests/fixtures/gpu/${name}`;
}

describe("parseCsvGpus", () => {
  it("parse la requête CSV avec compute_cap (RTX 4070 / Ada)", () => {
    const sections = parseFixtureSections(fixture("rtx4070-12g.txt"));
    const gpus = parseCsvGpus(sections.query ?? "");

    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: "NVIDIA GeForce RTX 4070",
      driverVersion: "615.71.09",
      computeCapability: 8.9,
      vramTotalMiB: 12288,
      vramFreeMiB: 11800,
      bf16: true,
    });
  });

  it("parse la requête CSV avec compute_cap (RTX 3060 / Ampere)", () => {
    const sections = parseFixtureSections(fixture("rtx3060-12g.txt"));
    const gpus = parseCsvGpus(sections.query ?? "");

    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: "NVIDIA GeForce RTX 3060",
      driverVersion: "580.65.06",
      computeCapability: 8.6,
      vramTotalMiB: 12288,
      vramFreeMiB: 11700,
      bf16: true,
    });
  });

  it("accepte une requête de repli à 5 champs (sans compute_cap)", () => {
    const gpus = parseCsvGpus(
      "0, NVIDIA GeForce RTX 3060, 580.65.06, 12288, 11700",
    );
    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.computeCapability).toBeNull();
    expect(gpus[0]?.vramTotalMiB).toBe(12288);
    expect(gpus[0]?.vramFreeMiB).toBe(11700);
  });

  it("ignore les lignes décalées/non typées sans faux positif", () => {
    const skipped: string[] = [];
    const gpus = parseCsvGpus(
      [
        '0, "NVIDIA, GeForce RTX 3060", 580.65.06, 8.6, 12288, 11700',
        "1, NVIDIA GeForce RTX 3060, 580.65.06, 8.6, 12288, 11700, extra",
        "2, NVIDIA GeForce RTX 3060, 580.65.06, huit.neuf, 12288, 11700",
        "x, NVIDIA GeForce RTX 3060, 580.65.06, 8.6, 12288, 11700",
        "3, NVIDIA GeForce RTX 3060, 580.65.06, 8.6, beaucoup, 11700",
      ].join("\n"),
      (reason) => skipped.push(reason),
    );

    // Champ quoté conservé (6 champs) ; compute_cap illisible -> capacité nulle
    // (jamais une valeur haute) ; les trois autres lignes sont ignorées.
    expect(gpus).toHaveLength(2);
    expect(gpus[0]?.name).toBe("NVIDIA, GeForce RTX 3060");
    expect(gpus[0]?.computeCapability).toBe(8.6);
    expect(gpus[1]?.computeCapability).toBeNull();
    // 3 lignes ignorées + 1 compute capability illisible signalée.
    expect(skipped).toHaveLength(4);
  });

  it("tolère compute_cap = N/A et les champs absents", () => {
    const sections = parseFixtureSections(fixture("quadro-rtx4000-8g.txt"));
    const gpus = parseCsvGpus(sections.query ?? "");

    expect(gpus).toHaveLength(1);
    expect(gpus[0]?.name).toBe("Quadro RTX 4000");
    expect(gpus[0]?.computeCapability).toBeNull();
    expect(gpus[0]?.vramTotalMiB).toBe(8192);
  });

  it("ignore une sortie d'erreur", () => {
    const sections = parseFixtureSections(fixture("no-gpu.txt"));
    expect(parseCsvGpus(sections.query ?? "")).toEqual([]);
  });
});

describe("parseFullQuery (repli `nvidia-smi -q`)", () => {
  it("extrait nom, VRAM, compute capability, driver et CUDA", () => {
    const sections = parseFixtureSections(fixture("quadro-rtx4000-8g.txt"));
    const result = parseFullQuery(sections.q ?? "");

    expect(result.cudaVersion).toBe("13.0");
    expect(result.driverVersion).toBe("580.65.06");
    expect(result.gpus).toHaveLength(1);
    expect(result.gpus[0]).toMatchObject({
      name: "Quadro RTX 4000",
      computeCapability: 7.5,
      vramTotalMiB: 8192,
      vramFreeMiB: 7900,
      bf16: false,
    });
  });
});

describe("utilitaires nvidia-smi", () => {
  it("parse la version CUDA", () => {
    expect(parseCudaVersion("| NVIDIA-SMI 615.71.09   CUDA Version: 13.4 |")).toBe("13.4");
    expect(parseCudaVersion("aucune information")).toBeNull();
  });

  it("dérive BF16 de la compute capability (>= 8.0)", () => {
    expect(deriveBf16(8.9)).toBe(true);
    expect(deriveBf16(8.0)).toBe(true);
    expect(deriveBf16(7.5)).toBe(false);
    expect(deriveBf16(null)).toBe(false);
  });

  it("extrait la majeure du driver", () => {
    expect(driverMajor("615.71.09")).toBe(615);
    expect(driverMajor("580.65.06")).toBe(580);
    expect(driverMajor(null)).toBeNull();
  });

  it("résout la compute capability depuis le nom", () => {
    expect(computeCapabilityFromName("NVIDIA GeForce RTX 4070")).toBe(8.9);
    expect(computeCapabilityFromName("NVIDIA GeForce RTX 3060")).toBe(8.6);
    expect(computeCapabilityFromName("Quadro RTX 4000")).toBe(7.5);
    expect(computeCapabilityFromName("GPU inconnu")).toBeNull();
  });

  it("reconnaît une erreur nvidia-smi", () => {
    expect(looksLikeSmiError("nvidia-smi: command not found")).toBe(true);
    expect(looksLikeSmiError("No devices were found")).toBe(true);
    expect(looksLikeSmiError("0, RTX 4070, ...")).toBe(false);
  });
});

describe("detectGpus", () => {
  it("mode simulé : RTX 4070 -> CC 8.9 et CUDA 13.4", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: fixturePath("rtx4070-12g.txt"),
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    expect(detection.source).toBe("simulated");
    expect(detection.cudaDriverVersion).toBe("13.4");
    expect(detection.gpus[0]?.computeCapability).toBe(8.9);
    expect(detection.gpus[0]?.cudaDriverVersion).toBe("13.4");
  });

  it("dernier repli : table nom→CC quand `-q` n'a pas le champ (Quadro)", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: fixturePath("quadro-rtx4000-8g-no-compute-cap.txt"),
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    expect(detection.gpus[0]?.name).toBe("Quadro RTX 4000");
    expect(detection.gpus[0]?.computeCapability).toBe(7.5);
    expect(detection.gpus[0]?.vramFreeMiB).toBe(7900);
    expect(detection.notes.join("\n")).toContain("table nom→CC");
  });

  it("requête principale en échec : détecte via le repli, PAS texte-seul", () => {
    const fullQuery = [
      "==============NVSMI LOG==============",
      "Driver Version                            : 580.65.06",
      "CUDA Version                              : 13.0",
      "GPU 00000000:01:00.0",
      "    Product Name                          : NVIDIA GeForce RTX 3060",
      "    FB Memory Usage",
      "        Total                             : 12288 MiB",
      "        Free                              : 11700 MiB",
      "    Compute Capability                    : 8.6",
    ].join("\n");

    const calls: string[] = [];
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: null,
      commandFromEnv: false,
      runner: (_command, args) => {
        const joined = args.join(" ");
        calls.push(joined);
        if (joined.includes("compute_cap")) {
          return {
            ok: false,
            stdout: "",
            stderr: "Field 'compute_cap' is not a valid field",
            error: "code de sortie 1",
          };
        }
        if (args.includes("-q")) {
          return { ok: true, stdout: fullQuery, stderr: "", error: null };
        }
        return {
          ok: true,
          stdout: "0, NVIDIA GeForce RTX 3060, 580.65.06, 12288, 11700\n",
          stderr: "",
          error: null,
        };
      },
    });

    expect(detection.gpus).toHaveLength(1);
    expect(detection.gpus[0]?.name).toBe("NVIDIA GeForce RTX 3060");
    expect(detection.gpus[0]?.computeCapability).toBe(8.6);
    expect(detection.error).toBeNull();
    expect(detection.source).toBe("auto");
    const notes = detection.notes.join("\n");
    expect(notes).toContain("requête de repli");
    expect(notes).toContain("chemin de détection retenu");
    // principale (échec) -> repli (succès) -> `-q` (compute capability)
    expect(calls).toHaveLength(3);
  });

  it("requêtes CSV indisponibles : détecte via `nvidia-smi -q`", () => {
    const fullQuery = [
      "==============NVSMI LOG==============",
      "Driver Version                            : 580.65.06",
      "CUDA Version                              : 13.0",
      "GPU 00000000:01:00.0",
      "    Product Name                          : NVIDIA GeForce RTX 3060",
      "    FB Memory Usage",
      "        Total                             : 12288 MiB",
      "        Free                              : 11700 MiB",
      "    Compute Capability                    : 8.6",
    ].join("\n");

    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: null,
      commandFromEnv: false,
      runner: (_command, args) =>
        args.includes("-q")
          ? { ok: true, stdout: fullQuery, stderr: "", error: null }
          : { ok: false, stdout: "", stderr: "boom", error: "sortie 1" },
    });

    expect(detection.gpus).toHaveLength(1);
    expect(detection.gpus[0]?.computeCapability).toBe(8.6);
    expect(detection.error).toBeNull();
    expect(detection.notes.join("\n")).toContain("nvidia-smi -q");
  });

  it("repli `nvidia-smi -q` quand compute_cap vaut N/A (Quadro)", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: fixturePath("quadro-rtx4000-8g.txt"),
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    expect(detection.gpus[0]?.computeCapability).toBe(7.5);
    expect(detection.gpus[0]?.vramFreeMiB).toBe(7900);
    expect(detection.notes.join("\n")).toContain("nvidia-smi -q");
  });

  it("mode simulé : aucune GPU", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: fixturePath("no-gpu.txt"),
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    expect(detection.gpus).toEqual([]);
    expect(detection.source).toBe("simulated");
    expect(detection.error).toBeNull();
  });

  it("commande en échec : capacités GPU à zéro, pas de crash", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: null,
      commandFromEnv: false,
      runner: () => ({
        ok: false,
        stdout: "",
        stderr: "nvidia-smi: command not found",
        error: "spawnSync nvidia-smi ENOENT",
      }),
    });
    expect(detection.gpus).toEqual([]);
    expect(detection.source).toBe("auto");
    expect(detection.error).toContain("ENOENT");
  });

  it("source `env-override` quand la commande vient de l'environnement", () => {
    const detection = detectGpus({
      command: "my-smi",
      fixture: null,
      commandFromEnv: true,
      runner: () => ({ ok: false, stdout: "", stderr: "", error: "boom" }),
    });
    expect(detection.source).toBe("env-override");
  });
});
