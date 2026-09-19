/**
 * `models.json` GÉNÉRÉ (Lot 11) : écriture atomique, toujours réécrite.
 * `settings.json` conserve son seed copie-si-absent (jamais écrasé).
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolvePiPaths,
  seedSettingsFile,
  writeModelsFile,
} from "../../src/pi/config.js";
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
  const seedPath = join(root, "seed-settings.json");
  writeFileSync(seedPath, '{"defaultProjectTrust":"never"}', "utf8");
  return { agentDir, seedPath };
}

describe("pi.config — models.json généré", () => {
  it("écrit le contenu donné puis le RÉÉCRIT toujours", () => {
    const { agentDir } = setup();
    const paths = resolvePiPaths({
      agentDir,
      cwd: agentDir,
      home: join(agentDir, "..", "home"),
    });
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

    writeModelsFile(paths, { providers: { a: 1 } }, logger);
    expect(JSON.parse(readFileSync(paths.modelsPath, "utf8"))).toEqual({
      providers: { a: 1 },
    });

    // Une édition manuelle est ÉCRASÉE au démarrage suivant (généré).
    writeFileSync(paths.modelsPath, '{"edited":true}', "utf8");
    writeModelsFile(paths, { providers: { b: 2 } }, logger);
    expect(JSON.parse(readFileSync(paths.modelsPath, "utf8"))).toEqual({
      providers: { b: 2 },
    });
  });

  it("écrit de façon atomique (aucun fichier temporaire résiduel)", () => {
    const { agentDir } = setup();
    const paths = resolvePiPaths({
      agentDir,
      cwd: agentDir,
      home: join(agentDir, "..", "home"),
    });
    writeModelsFile(paths, { providers: {} });
    expect(statSync(paths.modelsPath).isFile()).toBe(true);
    const leftovers = [".tmp"];
    for (const suffix of leftovers) {
      expect(() => statSync(`${paths.modelsPath}${suffix}`)).toThrow();
    }
  });
});

describe("pi.config — seedSettingsFile (copie-si-absent)", () => {
  it("copie le seed si absent puis ne l'écrase JAMAIS", () => {
    const { agentDir, seedPath } = setup();
    const paths = resolvePiPaths({
      agentDir,
      cwd: agentDir,
      home: join(agentDir, "..", "home"),
      settingsSeedPath: seedPath,
    });
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

    expect(seedSettingsFile(paths, logger)).toEqual({
      seeded: true,
      reason: "created",
    });
    expect(readFileSync(paths.settingsPath, "utf8")).toContain("defaultProjectTrust");

    writeFileSync(paths.settingsPath, '{"edited":true}', "utf8");
    expect(seedSettingsFile(paths, logger)).toEqual({
      seeded: false,
      reason: "already-present",
    });
    expect(readFileSync(paths.settingsPath, "utf8")).toBe('{"edited":true}');
  });
});
