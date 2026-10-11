/**
 * `RulesStore` — règles strictes : fichier + historique + journal + réversion.
 *
 * Prouve : lecture tolérante (fichier absent), écriture atomique, BORNE à 8 000
 * caractères avec troncature SIGNALÉE, historique de 20 versions max (purge),
 * journal avant/après avec source et REDACTION des secrets, `revert()` qui
 * restaure réellement la version précédente, et emplacement DÉRIVÉ (`rules.md`
 * voisin de `personality.md`, dossiers `rules-history` / `rules-journal.jsonl`).
 *
 * Le mécanisme est le socle partagé `TextDocumentStore` — le même que la
 * personnalité (voir `tests/personality/store.test.ts`).
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
  RULES_HISTORY_MAX,
  RULES_MAX_CHARS,
  RulesStore,
  type RulesStoreOptions,
} from "../../src/rules/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-rules-"));
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

function makeStore(dir: string, options: Partial<RulesStoreOptions> = {}) {
  let tick = 0;
  return new RulesStore({
    path: join(dir, "rules.md"),
    logger: logger(),
    secretValues: [],
    now: () => Date.parse("2026-10-11T00:00:00Z") + tick++ * 1000,
    ...options,
  });
}

describe("RulesStore — lecture/écriture", () => {
  it("fichier ABSENT : contenu vide, aucune erreur (⇒ rien à injecter)", () => {
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
    const result = store.write("Ne jamais divulguer.", "user");
    expect(result).toMatchObject({ changed: true, truncated: false });
    expect(store.read().text).toBe("Ne jamais divulguer.");
    expect(readFileSync(join(dir, "rules.md"), "utf8")).toBe("Ne jamais divulguer.");
  });

  it("une écriture IDENTIQUE ne change rien (pas de version en trop)", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.write("Contenu", "user");
    const before = readdirSync(store.historyPath).length;
    const again = store.write("Contenu", "user");
    expect(again.changed).toBe(false);
    expect(readdirSync(store.historyPath).length).toBe(before);
  });

  it("BORNE : tronque à 8 000 points de code et le SIGNALE", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const tooLong = "a".repeat(RULES_MAX_CHARS + 50);
    const result = store.write(tooLong, "user");
    expect(result.truncated).toBe(true);
    expect(result.chars).toBe(RULES_MAX_CHARS);
    const onDisk = readFileSync(join(dir, "rules.md"), "utf8");
    expect(Array.from(onDisk).length).toBe(RULES_MAX_CHARS);
    // Le fichier écrit est déjà borné : une relecture n'est plus tronquée.
    expect(store.read().truncated).toBe(false);
  });

  it("un fichier EXTERNE trop long : read() tronque et le SIGNALE", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    writeFileSync(join(dir, "rules.md"), "b".repeat(RULES_MAX_CHARS + 10));
    const doc = store.read();
    expect(doc.truncated).toBe(true);
    expect(doc.chars).toBe(RULES_MAX_CHARS);
  });
});

describe("RulesStore — historique (20 max, purge)", () => {
  it("conserve au plus 20 versions et purge les plus anciennes", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let index = 0; index < 25; index += 1) {
      store.write(`version ${index}`, "user");
    }
    const files = readdirSync(store.historyPath).filter((name) => name.endsWith(".md"));
    expect(files.length).toBe(RULES_HISTORY_MAX);
    const history = store.history(100);
    expect(history.length).toBe(RULES_HISTORY_MAX);
    expect(history[0]?.text).toBe("version 24");
    expect(history.some((entry) => entry.text === "version 4")).toBe(false);
    expect(history.some((entry) => entry.text === "version 5")).toBe(true);
  });
});

describe("RulesStore — journal (avant/après, source, redaction)", () => {
  it("journalise avant/après + source + horodatage, sans secret", () => {
    const dir = tempDir();
    const store = makeStore(dir, { secretValues: ["S3CR3T-TOKEN"] });
    store.write("avant", "user");
    store.write("après avec S3CR3T-TOKEN", "user");

    const lines = readFileSync(store.journalFilePath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBe(2);
    const entry = JSON.parse(lines[1] as string);
    expect(entry).toMatchObject({ v: 1, source: "user", beforeChars: 5, before: "avant" });
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ⚠️ Aucun secret en clair dans le journal.
    expect(lines[1]).not.toContain("S3CR3T-TOKEN");
    expect(entry.after).toContain("[REDACTED]");
  });
});

describe("RulesStore — revert()", () => {
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
});

describe("RulesStore — emplacement", () => {
  it("dérive l'historique et le journal du dossier du fichier (rules.md voisin)", () => {
    const dir = tempDir();
    const store = makeStore(dir);
    expect(store.filePath).toBe(join(dir, "rules.md"));
    expect(store.historyPath).toBe(join(dir, "rules-history"));
    expect(store.journalFilePath).toBe(join(dir, "rules-journal.jsonl"));
    expect(existsSync(store.historyPath)).toBe(false); // créé à la 1re écriture
    store.write("x", "user");
    expect(existsSync(store.historyPath)).toBe(true);
    expect(existsSync(store.journalFilePath)).toBe(true);
  });
});
