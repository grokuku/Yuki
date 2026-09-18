import { describe, expect, it } from "vitest";

import { detectGpus } from "../../src/gpu/detect.js";
import {
  capabilityRequiredBy,
  evaluateProfile,
  evaluateService,
  loadCompatManifest,
  loadProfiles,
  pickHighestCompatible,
  summarizeCapabilities,
} from "../../src/gpu/profiles.js";
import { CAPABILITY_ORDER } from "../../src/types/gpu.js";

const MIN_DRIVER = 580;

const profiles = loadProfiles();
const manifest = loadCompatManifest();

function resolveFor(fixture: string, minDriver = MIN_DRIVER): string {
  const detection = detectGpus({
    command: "nvidia-smi",
    fixture: `tests/fixtures/gpu/${fixture}`,
    commandFromEnv: false,
    cwd: process.cwd(),
  });
  const { capabilities } = summarizeCapabilities(detection.gpus, minDriver);
  return pickHighestCompatible(profiles, capabilities).profile.id;
}

describe("table de résolution des profils", () => {
  it("RTX 4070 12 Go -> confort", () => {
    expect(resolveFor("rtx4070-12g.txt")).toBe("confort");
  });

  it("RTX 3060 12 Go -> confort", () => {
    expect(resolveFor("rtx3060-12g.txt")).toBe("confort");
  });

  it("Quadro RTX 4000 8 Go -> compact", () => {
    expect(resolveFor("quadro-rtx4000-8g.txt")).toBe("compact");
  });

  it("GTX 1660 Ti 6 Go (entre 6 000 et 8 000 MiB) -> repli", () => {
    expect(resolveFor("gtx1660ti-6g.txt")).toBe("repli");
  });

  it("sans GPU -> texte-seul", () => {
    expect(resolveFor("no-gpu.txt")).toBe("texte-seul");
  });

  it("driver trop ancien (560) -> confort : le driver ne conditionne plus le profil", () => {
    expect(resolveFor("driver-too-old.txt")).toBe("confort");
  });

  it("VRAM libre basse (4070, 256 MiB libres) -> confort : la VRAM libre n'influence plus", () => {
    expect(resolveFor("rtx4070-12g-low-free.txt")).toBe("confort");
  });
});

describe("capacités observées", () => {
  it("RTX 4070 : BF16 vrai et VRAM totale 12 288 MiB", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/rtx4070-12g.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    expect(capabilities["gpu.present"]).toBe(true);
    expect(capabilities["gpu.bf16"]).toBe(true);
    expect(capabilities["gpu.vram.total"]).toBe(12288);
    expect(capabilities["driver.floor"]).toBe(true);
  });

  it("Quadro : BF16 faux et driver conforme", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/quadro-rtx4000-8g.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    expect(capabilities["gpu.bf16"]).toBe(false);
    expect(capabilities["driver.floor"]).toBe(true);
  });

  it("driver 560 : driver.floor faux", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/driver-too-old.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    expect(capabilities["driver.floor"]).toBe(false);
    expect(capabilities["gpu.present"]).toBe(true);
  });

  it("GTX 1660 Ti : VRAM 6 144 MiB et pas de BF16 (profil repli)", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/gtx1660ti-6g.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    expect(capabilities["gpu.present"]).toBe(true);
    expect(capabilities["gpu.computeCapability"]).toBe(7.5);
    expect(capabilities["gpu.bf16"]).toBe(false);
    expect(capabilities["gpu.vram.total"]).toBe(6144);
    expect(capabilities["driver.floor"]).toBe(true);
  });
});

describe("évaluation d'un profil", () => {
  it("confort échoue sur le Quadro avec les capacités manquantes listées", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/quadro-rtx4000-8g.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    const confort = profiles.profiles.find((profile) => profile.id === "confort");
    expect(confort).toBeDefined();
    const evaluation = evaluateProfile(confort!, capabilities);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.missing).toContain("gpu.bf16");
    expect(evaluation.missing).toContain("gpu.vram.total");
    // La VRAM libre et le driver ne sont plus des critères de profil.
    expect(evaluation.missing).not.toContain("gpu.vram.free");
    expect(evaluation.missing).not.toContain("driver.floor");
  });

  it("texte-seul est toujours satisfait", () => {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: "tests/fixtures/gpu/no-gpu.txt",
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    const { capabilities } = summarizeCapabilities(detection.gpus, MIN_DRIVER);
    const texte = profiles.profiles.find((profile) => profile.id === "texte-seul");
    expect(evaluateProfile(texte!, capabilities).ok).toBe(true);
  });
});

describe("exigences de service (hors profil)", () => {
  function capsFor(fixture: string): Record<string, boolean | number> {
    const detection = detectGpus({
      command: "nvidia-smi",
      fixture: `tests/fixtures/gpu/${fixture}`,
      commandFromEnv: false,
      cwd: process.cwd(),
    });
    return summarizeCapabilities(detection.gpus, MIN_DRIVER).capabilities;
  }

  it("driver.floor est exigé par asr/tts, jamais par un profil", () => {
    const requiredBy = capabilityRequiredBy(profiles, manifest);
    expect(requiredBy["driver.floor"]).toEqual(["asr", "tts"]);
    for (const id of ["confort", "compact", "repli", "texte-seul"]) {
      expect(requiredBy["driver.floor"]).not.toContain(id);
    }
  });

  it("gpu.vram.free n'est exigé par aucun consommateur", () => {
    const requiredBy = capabilityRequiredBy(profiles, manifest);
    expect(requiredBy["gpu.vram.free"] ?? []).toEqual([]);
  });

  it("driver 560 : exigence de service asr/tts NON satisfaite (profil inchangé)", () => {
    const caps = capsFor("driver-too-old.txt");
    expect(caps["driver.floor"]).toBe(false);
    expect(evaluateService(manifest.services.asr, caps).satisfied).toBe(false);
    expect(evaluateService(manifest.services.tts, caps).satisfied).toBe(false);
  });

  it("RTX 4070 : exigences asr/tts satisfaites, gateway sans GPU satisfait", () => {
    const caps = capsFor("rtx4070-12g.txt");
    expect(evaluateService(manifest.services.asr, caps).satisfied).toBe(true);
    expect(evaluateService(manifest.services.tts, caps).satisfied).toBe(true);
    expect(evaluateService(manifest.services.gateway, caps).satisfied).toBe(true);
  });
});

describe("capacité -> consommateurs", () => {
  it("gpu.bf16 est exigé par confort et tts", () => {
    const requiredBy = capabilityRequiredBy(profiles, manifest);
    expect(requiredBy["gpu.bf16"]).toContain("confort");
    expect(requiredBy["gpu.bf16"]).toContain("tts");
    expect(requiredBy["gpu.bf16"]).not.toContain("compact");
  });

  it("l'ordre des capacités du rapport est stable", () => {
    expect([...CAPABILITY_ORDER]).toEqual([
      "gpu.present",
      "gpu.computeCapability",
      "gpu.bf16",
      "gpu.vram.total",
      "gpu.vram.free",
      "driver.floor",
    ]);
  });
});
