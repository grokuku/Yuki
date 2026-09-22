/**
 * Sondage des points de montage — détection PRÉCOCE d'un volume non
 * inscriptible (`probeWritable`), indépendante des privilèges (le test
 * fonctionne même en root, contrairement à un `chmod 555`).
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { describeWriteFailure, probeWritable } from "../../src/config/paths.js";

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

  it("détecte une écriture impossible (parent = fichier) sans lever, et remonte le code système", () => {
    const root = tempDir();
    const blocker = join(root, "state");
    writeFileSync(blocker, "not-a-directory");
    const result = probeWritable(join(blocker, "sub"));
    expect(result.writable).toBe(false);
    expect(result.error).toBeTruthy();
    // La cause système est exploitée par `describeWriteFailure` : elle est
    // remontée telle quelle (aucune invention).
    expect(result.code).toBe("ENOTDIR");
  });
});

describe("describeWriteFailure — conseil EXACT selon la cause réelle", () => {
  const context = { volume: "models", path: "/models", service: "gateway" };

  it("EROFS → montage en LECTURE SEULE, jamais un conseil de permissions", () => {
    const hint = describeWriteFailure({ ...context, code: "EROFS" });
    expect(hint).toMatch(/LECTURE SEULE/);
    expect(hint).toContain(":ro");
    expect(hint).toContain("models");
    expect(hint).toContain("/models");
    expect(hint).toContain("gateway");
    // Ne prétend JAMAIS une cause de permissions pour un montage `ro`.
    expect(hint).not.toContain("chown");
    expect(hint).not.toMatch(/appartie[nt]/);
  });

  it("EACCES et EPERM → permissions (uid/gid du conteneur)", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const hint = describeWriteFailure({ ...context, code });
      expect(hint).toMatch(/permissions/i);
      expect(hint).toContain("chown 1000:1000");
      expect(hint).toContain("models");
      expect(hint).toContain("/models");
      // Ne prétend JAMAIS un montage en lecture seule.
      expect(hint).not.toMatch(/LECTURE SEULE/);
      expect(hint).not.toContain(":ro");
    }
  });

  it("ENOENT → volume absent", () => {
    const hint = describeWriteFailure({ ...context, code: "ENOENT" });
    expect(hint).toMatch(/absent/);
    expect(hint).toContain("models");
    expect(hint).toContain("/models");
    expect(hint).not.toContain("chown");
    expect(hint).not.toMatch(/LECTURE SEULE/);
  });

  it("code INCONNU → message honnête citant le code brut, sans cause inventée", () => {
    const hint = describeWriteFailure({ ...context, code: "EWEIRD" });
    expect(hint).toContain("EWEIRD");
    expect(hint).toContain("models");
    expect(hint).toContain("/models");
    // Aucune cause attribuée au hasard.
    expect(hint).not.toContain("chown");
    expect(hint).not.toMatch(/LECTURE SEULE/);
    expect(hint).not.toMatch(/absent/);
  });

  it("code INDISPONIBLE → message honnête mentionnant « inconnu »", () => {
    const hint = describeWriteFailure({ ...context });
    expect(hint).toContain("inconnu");
    expect(hint).toContain("models");
    expect(hint).not.toContain("chown");
    expect(hint).not.toMatch(/LECTURE SEULE/);
  });

  it("le service par défaut est « gateway » et le volume/chemin nommés", () => {
    const hint = describeWriteFailure({
      volume: "state",
      path: "/data/state",
      code: "EROFS",
    });
    expect(hint).toContain("state");
    expect(hint).toContain("/data/state");
    expect(hint).toContain("gateway");
  });
});
