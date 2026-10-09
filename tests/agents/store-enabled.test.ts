/**
 * `AgentStore.setEnabled` — bascule ON/OFF de l'encart de la barre latérale.
 *
 * Sémantique : OFF = niveau `disabled` (le niveau d'avant est MÉMORISÉ) ; ON =
 * restauration du niveau mémorisé, ou défaut si l'agent était DÉJÀ désactivé.
 * ⚠️ Aucun second drapeau d'activation : on réutilise le niveau (D118).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentError, AgentStore, DEFAULT_ENABLED_LEVEL } from "../../src/agents/index.js";
import type { AgentLevel } from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-enable-"));
  tempDirs.push(dir);
  return join(dir, "agents.jsonl");
}

function open(defaultLevel: AgentLevel = "destructive") {
  return AgentStore.open({
    path: tempStorePath(),
    defaults: { level: defaultLevel, privilege: "normal" },
    logger,
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AgentStore.setEnabled — on/off par le niveau, sans second drapeau", () => {
  it("OFF met `disabled`, ON restaure le niveau précédent", () => {
    const store = open();
    store.markSeen("a1"); // défaut = destructive
    expect(store.get("a1")?.level).toBe("destructive");
    expect(store.setEnabled("a1", false).level).toBe("disabled");
    expect(store.setEnabled("a1", true).level).toBe("destructive");
  });

  it("mémorise le niveau le plus récent (OFF puis ON après un changement direct)", () => {
    const store = open();
    store.markSeen("a1");
    store.setLevel("a1", "never");
    store.setEnabled("a1", false); // mémo = never
    store.setEnabled("a1", true);
    expect(store.get("a1")?.level).toBe("never");
  });

  it("ON sur un agent DÉJÀ désactivé applique le défaut (destructive)", () => {
    const store = open();
    store.markSeen("a1", { level: "disabled" });
    expect(store.setEnabled("a1", true).level).toBe(DEFAULT_ENABLED_LEVEL);
    expect(DEFAULT_ENABLED_LEVEL).toBe("destructive");
  });

  it("défaut configuré `disabled` ⇒ ON retombe sur `destructive`", () => {
    const store = open("disabled");
    store.markSeen("a1"); // défaut = disabled
    expect(store.setEnabled("a1", true).level).toBe("destructive");
  });

  it("idempotent : ne change rien si déjà dans l'état demandé", () => {
    const store = open();
    store.markSeen("a1");
    expect(store.setEnabled("a1", true).level).toBe("destructive"); // déjà actif
    store.setEnabled("a1", false);
    expect(store.setEnabled("a1", false).level).toBe("disabled"); // déjà off
  });

  it("agent inconnu ⇒ AgentError", () => {
    const store = open();
    expect(() => store.setEnabled("inconnu", true)).toThrowError(AgentError);
  });

  it("la suppression retire la mémoire : un agent recréé repart au défaut", () => {
    const store = open();
    store.markSeen("a1");
    store.setLevel("a1", "never");
    store.setEnabled("a1", false); // mémo = never
    store.remove("a1");
    store.markSeen("a1"); // recréé : défaut = destructive
    store.setEnabled("a1", false);
    store.setEnabled("a1", true);
    expect(store.get("a1")?.level).toBe("destructive");
  });

  it("le niveau restauré survit au redémarrage (journal rejoué)", () => {
    const path = tempStorePath();
    const store = AgentStore.open({
      path,
      defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    store.markSeen("a1");
    store.setLevel("a1", "always");
    store.setEnabled("a1", false);
    // Réouverture : la projection rejoue le journal et reconstruit la mémoire.
    const reopened = AgentStore.open({
      path,
      defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    expect(reopened.get("a1")?.level).toBe("disabled");
    expect(reopened.setEnabled("a1", true).level).toBe("always");
  });
});

describe("AgentStore.subscribe — notification des changements", () => {
  it("notifie à chaque mutation (création, config, révocation, suppression)", () => {
    const store = open();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.markSeen("a1");
    store.setLevel("a1", "always");
    store.revoke("a1");
    store.restore("a1");
    store.remove("a1");
    expect(listener).toHaveBeenCalledTimes(5);
    off();
    store.markSeen("a2");
    expect(listener).toHaveBeenCalledTimes(5); // désabonné
  });

  it("isole les exceptions d'un listener (l'écriture reste persistée)", () => {
    const store = open();
    store.subscribe(() => {
      throw new Error("listener cassé");
    });
    expect(() => store.markSeen("a1")).not.toThrow();
    expect(store.has("a1")).toBe(true);
  });
});
