/**
 * `PersonalityStore` — fichier + historique + journal + réversion.
 *
 * Prouve : lecture tolérante (fichier absent), écriture atomique, BORNE à 8 000
 * caractères avec troncature SIGNALÉE, historique de 20 versions max (purge),
 * journal avant/après avec source et REDACTION des secrets, et `revert()` qui
 * restaure réellement la version précédente.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PERSONALITY_HISTORY_MAX,
  PERSONALITY_MAX_CHARS,
  PersonalityStore,
  type PersonalityStoreOptions,
} from "../../src/personality/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-personality-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

function makeStore(
  dir: string,
  options: Partial<PersonalityStoreOptions> = {},
) {
  let tick = 0;
  return new PersonalityStore({
    path: join(dir, "personality.md"),
    logger: logger(),
    secretValues: [],
    // Horodatages monotones : les noms de snapshots sont triables.
    now: () => Date.parse("2026-10-08T00:00:00Z") + tick++ * 1000,
    ...options,
  });
}

describe("PersonalityStore — lecture/écriture", () => {
  it("fichier ABSENT : contenu vide, aucune erreur", () => {
    const store = makeStore(tempDir());
    expect(store.read()).toEqual({
      text: "",
      chars: 0,
      truncated: false,
      exists: false,
    });
  });

  it("écrit puis relit le contenu (fichier présent sur disque)", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const result = store.write("Je suis Yuki.", "user");
    expect(result).toMatchObject({ changed: true, chars: 13, truncated: false });
    expect(store.read().text).toBe("Je suis Yuki.");
    expect(readFileSync(join(dir, "personality.md"), "utf8")).toBe("Je suis Yuki.");
  });

  it("une écriture IDENTIQUE ne change rien (pas de version en trop)", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.write("Contenu", "user");
    const before = readdirSync(store.historyPath).length;
    const again = store.write("Contenu", "model");
    expect(again.changed).toBe(false);
    expect(readdirSync(store.historyPath).length).toBe(before);
  });

  it("BORNE : tronque à 8 000 points de code et le SIGNALE", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const tooLong = "a".repeat(PERSONALITY_MAX_CHARS + 50);
    const result = store.write(tooLong, "user");
    expect(result.truncated).toBe(true);
    expect(result.chars).toBe(PERSONALITY_MAX_CHARS);
    const onDisk = readFileSync(join(dir, "personality.md"), "utf8");
    expect(Array.from(onDisk).length).toBe(PERSONALITY_MAX_CHARS);
    // Le fichier écrit est déjà borné : une relecture n'est plus tronquée.
    expect(store.read().truncated).toBe(false);
  });

  it("un fichier EXTERNE trop long : read() tronque et le SIGNALE", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    // Écrit à la main (comme un utilisateur), au-delà de la borne.
    writeFileSync(join(dir, "personality.md"), "b".repeat(PERSONALITY_MAX_CHARS + 10));
    const doc = store.read();
    expect(doc.truncated).toBe(true);
    expect(doc.chars).toBe(PERSONALITY_MAX_CHARS);
  });
});

describe("PersonalityStore — historique (20 max, purge)", () => {
  it("conserve au plus 20 versions et purge les plus anciennes", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let index = 0; index < 25; index += 1) {
      store.write(`version ${index}`, "user");
    }
    const files = readdirSync(store.historyPath).filter((name) => name.endsWith(".md"));
    expect(files.length).toBe(PERSONALITY_HISTORY_MAX);
    const history = store.history(100);
    expect(history.length).toBe(PERSONALITY_HISTORY_MAX);
    // La plus récente est bien la dernière écrite…
    expect(history[0]?.text).toBe("version 24");
    // …et les 5 plus anciennes ont été purgées.
    expect(history.some((entry) => entry.text === "version 4")).toBe(false);
    expect(history.some((entry) => entry.text === "version 5")).toBe(true);
  });
});

describe("PersonalityStore — journal (avant/après, source, redaction)", () => {
  it("journalise avant/après + source + horodatage, sans secret", () => {
    const dir = tempDir();
    const store = makeStore(dir, { secretValues: ["S3CR3T-TOKEN"] });
    store.write("avant", "user");
    store.write("après avec S3CR3T-TOKEN", "model");

    const lines = readFileSync(store.journalFilePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBe(2);
    const entry = JSON.parse(lines[1] as string);
    expect(entry).toMatchObject({
      v: 1,
      source: "model",
      beforeChars: 5,
      afterChars: Array.from("après avec S3CR3T-TOKEN").length,
      truncated: false,
      before: "avant",
    });
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ⚠️ Aucun secret en clair dans le journal.
    expect(lines[1]).not.toContain("S3CR3T-TOKEN");
    expect(entry.after).toContain("[REDACTED]");
  });
});

describe("PersonalityStore — revert()", () => {
  it("restaure la version PRÉCÉDENTE", () => {
    const store = makeStore(tempDir());
    store.write("version A", "user");
    store.write("version B", "user");
    expect(store.read().text).toBe("version B");

    const reverted = store.revert("user");
    expect(reverted?.changed).toBe(true);
    expect(store.read().text).toBe("version A");
  });

  it("sans version précédente : renvoie null (rien à restaurer)", () => {
    const store = makeStore(tempDir());
    store.write("unique", "user");
    expect(store.revert("user")).toBeNull();
    const empty = makeStore(tempDir());
    expect(empty.revert("user")).toBeNull();
  });

  it("permet de revenir en arrière plusieurs fois (historique, pas un seul pas)", () => {
    const store = makeStore(tempDir());
    store.write("V1", "user");
    store.write("V2", "user");
    store.write("V3", "user");
    store.revert("user"); // V2
    expect(store.read().text).toBe("V2");
    store.revert("user"); // V3 (le plus récent différent de V2)
    expect(store.read().text).toBe("V3");
  });
});

describe("PersonalityStore — emplacement", () => {
  it("dérive l'historique et le journal du dossier du fichier", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    expect(store.filePath).toBe(join(dir, "personality.md"));
    expect(existsSync(store.historyPath)).toBe(false); // créé à la 1re écriture
    store.write("x", "user");
    expect(existsSync(store.historyPath)).toBe(true);
    expect(existsSync(store.journalFilePath)).toBe(true);
  });
});
