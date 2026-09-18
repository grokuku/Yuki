import { describe, expect, it } from "vitest";

import { type Env, loadEnv } from "../../src/config/env.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate, type GateResult } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();

function buildEnv(overrides: Record<string, string>, fixture: string): Env {
  return loadEnv({
    YUKI_GPU_FIXTURE: `tests/fixtures/gpu/${fixture}`,
    ...overrides,
  });
}

function run(overrides: Record<string, string>, fixture: string): {
  result: GateResult;
  lines: string[];
} {
  const lines: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line) => lines.push(line),
    secretValues: [],
  });
  const env = buildEnv(overrides, fixture);
  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
    cwd: process.cwd(),
  });
  return { result: runGate({ env, profiles, manifest, detection }, logger), lines };
}

function parsed(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("porte strict", () => {
  it("refuse un override `confort` non satisfait sur Quadro 8 Go", () => {
    const { result, lines } = run(
      { YUKI_PROFILE: "confort", YUKI_COMPAT_MODE: "strict" },
      "quadro-rtx4000-8g.txt",
    );

    expect(result.passed).toBe(false);
    expect(result.report.mode).toBe("fatal");
    expect(result.report.resolution).toBe("override-refused");
    expect(result.report.resolvedProfile).toBe("confort");
    expect(result.report.missingCapabilities).toContain("gpu.bf16");
    expect(result.report.missingCapabilities).toContain("gpu.vram.total");
    // Ni la VRAM libre ni le driver ne peuvent motiver un refus de profil.
    expect(result.report.missingCapabilities).not.toContain("gpu.vram.free");
    expect(result.report.missingCapabilities).not.toContain("driver.floor");
    expect(result.report.notes.join("\n")).toContain("YUKI_PROFILE");

    const refusal = parsed(lines).find((entry) => entry.msg === "gpu.gate refused");
    expect(refusal).toBeDefined();
    expect(refusal?.forcedByEnv).toBe(true);
  });

  it("accepte un override `confort` satisfait sur RTX 4070", () => {
    const { result } = run(
      { YUKI_PROFILE: "confort", YUKI_COMPAT_MODE: "strict" },
      "rtx4070-12g.txt",
    );

    expect(result.passed).toBe(true);
    expect(result.report.mode).toBe("ok");
    expect(result.report.resolution).toBe("override-accepted");
    expect(result.report.resolvedProfile).toBe("confort");
    expect(result.report.missingCapabilities).toEqual([]);
  });

  it("sans override, résout le plus haut profil compatible (Quadro -> compact)", () => {
    const { result, lines } = run({ YUKI_COMPAT_MODE: "strict" }, "quadro-rtx4000-8g.txt");

    expect(result.passed).toBe(true);
    expect(result.report.resolvedProfile).toBe("compact");
    expect(result.report.resolution).toBe("auto-highest-compatible");

    const resolved = parsed(lines).find((entry) => entry.msg === "gpu.gate resolved");
    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("simulated");
    expect(resolved?.overrideRequested).toBeNull();
    expect(resolved?.resolvedProfile).toBe("compact");
    expect(resolved?.resolution).toBe("auto-highest-compatible");
  });

  it("sans GPU, démarre en texte-seul dégradé", () => {
    const { result } = run({ YUKI_COMPAT_MODE: "strict" }, "no-gpu.txt");

    expect(result.passed).toBe(true);
    expect(result.report.resolvedProfile).toBe("texte-seul");
    expect(result.report.mode).toBe("degraded");
  });

  it("refuse un profil inconnu", () => {
    const { result } = run(
      { YUKI_PROFILE: "hyperspeed", YUKI_COMPAT_MODE: "strict" },
      "rtx4070-12g.txt",
    );
    expect(result.passed).toBe(false);
    expect(result.report.resolution).toBe("override-refused");
  });

  it("VRAM libre basse : `confort` conservé + avertissement WARN (aucun déclassement)", () => {
    const { result, lines } = run({ YUKI_COMPAT_MODE: "strict" }, "rtx4070-12g-low-free.txt");

    expect(result.passed).toBe(true);
    expect(result.report.resolvedProfile).toBe("confort");
    expect(result.report.resolution).toBe("auto-highest-compatible");
    expect(result.report.missingCapabilities).toEqual([]);
    expect(result.report.notes.join("\n")).toContain("VRAM libre basse");

    const warning = parsed(lines).find((entry) => entry.msg === "gpu.vram.free low");
    expect(warning).toBeDefined();
    expect(warning?.effect).toContain("sans effet sur le profil");
  });

  it("driver trop ancien : `confort` résolu, exigence de service asr/tts non satisfaite", () => {
    const { result } = run({ YUKI_COMPAT_MODE: "strict" }, "driver-too-old.txt");

    expect(result.passed).toBe(true);
    expect(result.report.resolvedProfile).toBe("confort");
    expect(result.report.capabilities["driver.floor"]).toBe(false);
    const asr = result.report.services.find((service) => service.service === "asr");
    const tts = result.report.services.find((service) => service.service === "tts");
    expect(asr?.satisfied).toBe(false);
    expect(asr?.missing).toContain("driver.floor");
    expect(tts?.satisfied).toBe(false);
  });
});

describe("porte auto-degrade", () => {
  it("descend de `confort` vers `compact` sur Quadro 8 Go", () => {
    const { result, lines } = run(
      { YUKI_PROFILE: "confort", YUKI_COMPAT_MODE: "auto-degrade" },
      "quadro-rtx4000-8g.txt",
    );

    expect(result.passed).toBe(true);
    expect(result.report.mode).toBe("degraded");
    expect(result.report.resolution).toBe("downgraded");
    expect(result.report.resolvedProfile).toBe("compact");

    const downgrade = parsed(lines).find((entry) => entry.msg === "gpu.gate downgraded");
    expect(downgrade).toBeDefined();
    expect(downgrade?.resolvedProfile).toBe("compact");
    expect(downgrade?.requestedProfile).toBe("confort");
  });

  it("journalise un downgrade même sans override explicite", () => {
    const { result, lines } = run(
      { YUKI_COMPAT_MODE: "auto-degrade" },
      "quadro-rtx4000-8g.txt",
    );

    expect(result.passed).toBe(true);
    expect(result.report.resolution).toBe("downgraded");
    expect(result.report.mode).toBe("degraded");
    const downgrade = parsed(lines).find((entry) => entry.msg === "gpu.gate downgraded");
    expect(downgrade).toBeDefined();
  });
});
