/**
 * Seed de `models.json` : copie-si-absent, JAMAIS d'écrasement.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePiPaths, seedModelsFile, seedSettingsFile } from "../../src/pi/config.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { agentDir: string; seedPath: string } {
  const root = mkdtempSync(join(tmpdir(), "yuki-seed-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const seedPath = join(root, "seed-models.json");
  writeFileSync(seedPath, '{"providers":{}}', "utf8");
  return { agentDir, seedPath };
}

describe("pi.config — seedModelsFile", () => {
  it("copie le seed si absent puis ne l'écrase JAMAIS", () => {
    const { agentDir, seedPath } = setup();
    const paths = resolvePiPaths({
      agentDir,
      cwd: agentDir,
      home: join(agentDir, "..", "home"),
      modelsSeedPath: seedPath,
    });
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

    expect(seedModelsFile(paths, logger)).toEqual({
      seeded: true,
      reason: "created",
    });
    expect(readFileSync(paths.modelsPath, "utf8")).toContain("providers");

    // Une édition sur le volume fait foi : le seed ne la remplace pas.
    writeFileSync(paths.modelsPath, '{"edited":true}', "utf8");
    expect(seedModelsFile(paths, logger)).toEqual({
      seeded: false,
      reason: "already-present",
    });
    expect(readFileSync(paths.modelsPath, "utf8")).toBe('{"edited":true}');

    // seedSettingsFile suit la même règle.
    expect(seedSettingsFile(paths, logger)).toEqual({
      seeded: false,
      reason: "no-seed",
    });
  });
});
