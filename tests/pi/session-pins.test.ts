/**
 * `SessionPinStore` — épinglage des conversations (volume `state`).
 *
 * ⚠️ L'état vit HORS du JSONL de session (propriété du SDK Pi) : ces tests
 * vérifient la persistance, l'idempotence et le nettoyage des orphelins.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionPinStore } from "../../src/pi/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-pins-"));
  tempDirs.push(dir);
  return join(dir, "session-pins.json");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionPinStore — épinglage persistant", () => {
  it("fichier absent ⇒ aucune épingle", () => {
    const store = SessionPinStore.open({ path: tempPath(), logger });
    expect(store.size).toBe(0);
    expect(store.isPinned("s1")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("épingle puis survit à la réouverture (persistance)", () => {
    const path = tempPath();
    const store = SessionPinStore.open({ path, logger });
    expect(store.setPinned("s1", true)).toBe(true);
    expect(store.setPinned("s2", true)).toBe(true);
    expect(store.isPinned("s1")).toBe(true);

    const reopened = SessionPinStore.open({ path, logger });
    expect(reopened.size).toBe(2);
    expect(reopened.isPinned("s1")).toBe(true);
    expect(reopened.isPinned("s2")).toBe(true);
    expect(reopened.isPinned("s3")).toBe(false);
  });

  it("désépingler retire l'entrée ; idempotent (aucun changement superflu)", () => {
    const store = SessionPinStore.open({ path: tempPath(), logger });
    store.setPinned("s1", true);
    expect(store.setPinned("s1", true)).toBe(false); // déjà épinglée
    expect(store.remove("s1")).toBe(true);
    expect(store.remove("s1")).toBe(false); // déjà retirée
    expect(store.isPinned("s1")).toBe(false);
  });

  it("ignore un identifiant vide sans planter", () => {
    const store = SessionPinStore.open({ path: tempPath(), logger });
    expect(store.setPinned("", true)).toBe(false);
    expect(store.setPinned("   ", true)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("prune retire les épingles orphelines et renvoie la liste", () => {
    const store = SessionPinStore.open({ path: tempPath(), logger });
    store.setPinned("keep-1", true);
    store.setPinned("gone", true);
    store.setPinned("keep-2", true);
    const removed = store.prune(["keep-1", "keep-2"]);
    expect(removed).toEqual(["gone"]);
    expect(store.isPinned("gone")).toBe(false);
    expect(store.isPinned("keep-1")).toBe(true);
    expect(store.prune(["keep-1", "keep-2"])).toEqual([]);
  });

  it("fichier corrompu ⇒ store vide, jamais d'exception", () => {
    const path = tempPath();
    writeFileSync(path, "{ pas du json");
    const store = SessionPinStore.open({ path, logger });
    expect(store.size).toBe(0);
    expect(store.setPinned("s1", true)).toBe(true); // récupère en réécrivant
    const reopened = SessionPinStore.open({ path, logger });
    expect(reopened.isPinned("s1")).toBe(true);
  });

  it("expose le chemin du fichier (volume state)", () => {
    const path = tempPath();
    const store = SessionPinStore.open({ path, logger });
    expect(store.filePath).toBe(path);
  });
});
