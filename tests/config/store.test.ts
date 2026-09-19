/**
 * Store de configuration — écriture atomique, 0600, sparse, schemaVersion,
 * repli sans écrasement.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore, ConfigStoreWriteError, CONFIG_STORE_SCHEMA_VERSION } from "../../src/config/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), "yuki-store-"));
  tempDirs.push(root);
  return join(root, "state", "config.json");
}

describe("ConfigStore", () => {
  it("fichier absent → défauts (valeurs vides), source 'absent'", () => {
    const store = new ConfigStore(storePath());
    expect(store.load()).toEqual({ values: {}, source: "absent" });
  });

  it("écrit de façon atomique, sparse, avec schemaVersion et mode 0600", () => {
    const path = storePath();
    const store = new ConfigStore(path);
    store.write({ "llm.light.model": "small" });

    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      values: Record<string, unknown>;
    };
    expect(raw.schemaVersion).toBe(CONFIG_STORE_SCHEMA_VERSION);
    expect(raw.values).toEqual({ "llm.light.model": "small" });
    // Sparse : seules les valeurs saisies sont présentes.
    expect(Object.keys(raw.values)).toHaveLength(1);
    // Pas de fichier temporaire résiduel.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    // Permissions 0600.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("recharge les valeurs écrites (source 'file')", () => {
    const path = storePath();
    const store = new ConfigStore(path);
    store.write({ "gpu.profile": "compact", "delegation.maxQueue": 4 });
    expect(store.load()).toEqual({
      values: { "gpu.profile": "compact", "delegation.maxQueue": 4 },
      source: "file",
    });
  });

  it("JSON invalide → défauts + fichier CONSERVÉ tel quel", () => {
    const path = storePath();
    const store = new ConfigStore(path);
    // Parent inexistant : on écrit nous-mêmes un fichier invalide.
    store.write({});
    writeFileSync(path, "{ not json", "utf8");
    const loaded = store.load();
    expect(loaded.source).toBe("invalid");
    expect(loaded.values).toEqual({});
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("schemaVersion inconnue → défauts + fichier conservé", () => {
    const path = storePath();
    const store = new ConfigStore(path);
    store.write({});
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 999, values: { "gpu.profile": "compact" } }),
      "utf8",
    );
    const loaded = store.load();
    expect(loaded.source).toBe("invalid");
    expect(loaded.values).toEqual({});
    expect(readFileSync(path, "utf8")).toContain("999");
  });

  it("re-force 0600 même si le fichier a été relâché", () => {
    const path = storePath();
    const store = new ConfigStore(path);
    store.write({ "gpu.minDriver": 580 });
    chmodSync(path, 0o644);
    store.write({ "gpu.minDriver": 600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("écriture impossible → ConfigStoreWriteError exploitable (jamais un échec muet)", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-store-ro-"));
    tempDirs.push(root);
    // Un FICHIER là où le store attend un répertoire : l'écriture échoue pour
    // TOUT utilisateur (y compris root), donc le test est reproductible en CI.
    const blocker = join(root, "state");
    writeFileSync(blocker, "not-a-directory");
    const path = join(blocker, "config.json");
    const store = new ConfigStore(path);

    let thrown: unknown;
    try {
      store.write({ "gpu.profile": "compact" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigStoreWriteError);
    const error = thrown as ConfigStoreWriteError;
    expect(error.path).toBe(path);
    expect(error.reason.length).toBeGreaterThan(0);
    expect(error.message).toContain("Impossible d'écrire la configuration");
    expect(error.message).toContain(path);
  });
});
