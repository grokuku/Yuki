/**
 * Sondage des points de montage — détection PRÉCOCE d'un volume non
 * inscriptible (`probeWritable`), indépendante des privilèges (le test
 * fonctionne même en root, contrairement à un `chmod 555`).
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { probeWritable } from "../../src/config/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-paths-"));
  tempDirs.push(dir);
  return dir;
}

describe("probeWritable", () => {
  it("écrit réellement, puis nettoie : un répertoire inscriptible est détecté", () => {
    const root = tempDir();
    const dir = join(root, "state");
    const result = probeWritable(dir);
    expect(result).toEqual({ writable: true });
    // Le répertoire est créé et ne conserve AUCUN fichier de sonde résiduel.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("détecte une écriture impossible (parent = fichier) sans lever", () => {
    const root = tempDir();
    const blocker = join(root, "state");
    writeFileSync(blocker, "not-a-directory");
    const result = probeWritable(join(blocker, "sub"));
    expect(result.writable).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
