/**
 * Annuaire d'agents injecté au MODÈLE à chaque tour : il doit indiquer l'état
 * VERROUILLÉ d'un agent « matériel sensible ».
 *
 * ⚠️ Sans cela, le modèle essaie d'exécuter, échoue et risque d'inventer une
 * cause (« le worker lourd n'est pas disponible » alors que c'était un 404) —
 * c'est exactement le piège que l'utilisateur a demandé d'éviter.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentDirectoryService,
  AgentHub,
  AgentLockService,
  AgentStore,
  AGENT_LIST_TAG,
  AuditLog,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import { frameAgentRoster } from "../../src/agents/output.js";
import { createAgentRosterExtensionFactory } from "../../src/pi/sdk/agent-roster-extension.js";
import { InstancePasswordStore } from "../../src/security/instance-password.js";
import { createLogger } from "../../src/observability/logger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-roster-lock-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const PASSWORD = "mot-de-passe-instance-42";

type Handler = (event: unknown) => unknown;

function capture(
  directory: { list: () => unknown },
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const factory = createAgentRosterExtensionFactory(directory as never);
  const run = typeof factory === "function" ? factory : factory.factory;
  run({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never);
  return handlers;
}

function inject(handlers: Map<string, Handler>, systemPrompt = "BASE"): string {
  const handler = handlers.get("before_agent_start");
  expect(handler).toBeDefined();
  const result = handler!({ prompt: "Bonjour", systemPrompt }) as { systemPrompt?: string };
  return result.systemPrompt ?? "";
}

describe("Annuaire injecté — état VERROUILLÉ", () => {
  it("un agent sensible verrouillé est signalé au modèle ; l'agent ordinaire ne l'est pas", () => {
    const dir = tempDir();
    const password = InstancePasswordStore.open({ path: join(dir, "instance-password.json") });
    password.set(PASSWORD);
    const store = AgentStore.open({
      path: join(dir, "agents.jsonl"),
      defaults: { level: "destructive", privilege: "normal" },
      logger,
      canMarkSensitive: () => password.isConfigured(),
    });
    const audit = AuditLog.open({
      path: join(dir, "audit.jsonl"),
      maxSizeBytes: maxSizeBytesFromMb(1),
      retentionDays: 30,
      logger,
    });
    const lock = new AgentLockService({ store, password, logger });
    store.markSeen("agent-nuc00");
    store.setName("agent-nuc00", "nuc00");
    store.setSensitive("agent-nuc00", true);
    store.markSeen("agent-nuc01");
    store.setName("agent-nuc01", "nuc01");

    const directory = new AgentDirectoryService({
      store,
      hub: new AgentHub({ logger }),
      audit,
      lock,
      logger,
    });
    const handlers = capture(directory);

    // Agent sensible VERROUILLÉ au démarrage.
    const lockedPrompt = inject(handlers);
    expect(lockedPrompt).toContain(`<${AGENT_LIST_TAG}>`);
    expect(lockedPrompt).toContain("nuc00 (agent-nuc00)");
    expect(lockedPrompt).toContain("VERROUILLÉ");
    // L'agent ordinaire reste une entrée NORMALE (aucune mention de verrou).
    const ordinaryIndex = lockedPrompt.indexOf("nuc01 (agent-nuc01)");
    expect(ordinaryIndex).toBeGreaterThan(0);
    expect(lockedPrompt.slice(ordinaryIndex, ordinaryIndex + 80)).not.toContain("VERROUILLÉ");

    // Après déverrouillage : plus de mention (mais l'agent reste listé).
    expect(lock.unlock("agent-nuc00", PASSWORD).ok).toBe(true);
    const unlockedPrompt = inject(handlers);
    expect(unlockedPrompt).toContain("nuc00 (agent-nuc00)");
    expect(unlockedPrompt).not.toContain("VERROUILLÉ");
    // ⚠️ Le mot de passe n'apparaît JAMAIS dans le contexte du modèle (octets).
    expect(Buffer.from(unlockedPrompt, "utf8").includes(Buffer.from(PASSWORD, "utf8"))).toBe(false);
  });

  it("le rappel d'annuaire ne change pas quand rien n'est verrouillé (non-régression)", () => {
    const text = frameAgentRoster([
      { name: "a", agentId: "agent-a" },
      { name: "b", agentId: "agent-b" },
    ]);
    expect(text).toBe(
      frameAgentRoster([
        { name: "a", agentId: "agent-a", locked: false },
        { name: "b", agentId: "agent-b", locked: false },
      ]),
    );
    expect(text).not.toContain("VERROUILLÉ");
  });

  it("l'annuaire TRONQUÉ signale quand même le nombre d'agents verrouillés", () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      name: `a${index}`,
      agentId: `agent-${index}`,
      locked: index === 1,
    }));
    const text = frameAgentRoster(entries, { max: 1 });
    expect(text).toContain("3 agents appairés");
    expect(text).toContain("1 agent(s) VERROUILLÉ(s)");
  });
});
