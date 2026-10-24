/**
 * Exécution d'une commande sur un agent « MATÉRIEL SENSIBLE VERROUILLÉ ».
 *
 * Ce que ces tests prouvent (exigences explicites) :
 *  - verrouillé ⇒ REFUS explicite ET **AUCUNE commande transmise** à l'agent
 *    (le faux hub enregistre TOUT ce qui part : il ne reçoit rien) ;
 *  - même un agent au niveau « Pas de validation » est refusé (l'état verrouillé
 *    est SÉPARÉ du niveau) ;
 *  - le refus ne crée AUCUNE demande de validation (inutile de faire valider une
 *    commande qui ne partira pas) ;
 *  - une commande EN VOL au moment du reverrouillage VA AU BOUT (on ne la tue
 *    pas) ; la SUIVANTE est refusée ;
 *  - une commande réellement transmise remet le compte d'inactivité à zéro ;
 *  - un agent NON sensible n'est pas affecté (aucune régression).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentExecutionService,
  AgentHub,
  AgentLockService,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  maxSizeBytesFromMb,
  SENSITIVE_IDLE_TIMEOUT_MS,
} from "../../src/agents/index.js";
import type { OutboundCommand, ResultFrame } from "../../src/agents/protocol.js";
import { InstancePasswordStore } from "../../src/security/instance-password.js";
import { createLogger } from "../../src/observability/logger.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-exec-lock-"));
  dirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const PASSWORD = "mot-de-passe-instance-42";

/** Hub FACTICE : enregistre ce qui PART réellement (preuve « rien n'a été transmis »). */
class RecordingHub {
  readonly sent: Array<{ agentId: string; cmd: OutboundCommand }> = [];
  readonly online = new Set<string>();
  private readonly listeners = new Set<() => void>();

  isOnline(agentId: string): boolean {
    return this.online.has(agentId);
  }

  hasCapability(): boolean {
    return true;
  }

  caps(): string[] {
    return [];
  }

  get(): undefined {
    return undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onlineIds(): string[] {
    return [...this.online];
  }

  connect(agentId: string): void {
    this.online.add(agentId);
    for (const listener of this.listeners) listener();
  }

  disconnect(agentId: string): void {
    this.online.delete(agentId);
    for (const listener of this.listeners) listener();
  }

  /** Résolution optionnelle différée : permet de tester une commande EN VOL. */
  private pending: (() => void) | null = null;

  holdNext(): void {
    this.pending = () => undefined;
  }

  release(): void {
    this.pending = null;
  }

  async sendCommand(agentId: string, cmd: OutboundCommand): Promise<ResultFrame> {
    this.sent.push({ agentId, cmd });
    if (this.pending) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      this.pending = null;
    }
    return {
      cmdId: cmd.cmdId,
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 1,
      truncated: false,
      timedOut: false,
      stdoutTrunc: false,
      stderrTrunc: false,
    } as unknown as ResultFrame;
  }
}

interface Fixture {
  store: AgentStore;
  hub: RecordingHub;
  lock: AgentLockService;
  approvals: ApprovalRegistry;
  execution: AgentExecutionService;
  clock: { now: number };
  advance(ms: number): void;
}

function fixture(): Fixture {
  const dir = tempDir();
  const clock = { now: Date.parse("2026-10-24T10:00:00.000Z") };
  const password = InstancePasswordStore.open({ path: join(dir, "instance-password.json") });
  password.set(PASSWORD);
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
    now: () => clock.now,
    canMarkSensitive: () => password.isConfigured(),
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
    now: () => clock.now,
  });
  const hub = new RecordingHub();
  const lock = new AgentLockService({ store, password, logger, now: () => clock.now });
  lock.attachHub(hub);
  const approvals = new ApprovalRegistry({ logger, now: () => clock.now });
  const execution = new AgentExecutionService({
    store,
    hub: hub as unknown as AgentHub,
    audit,
    approvals,
    logger,
    now: () => clock.now,
    lock,
  });
  // Agents : un sensible (niveau « Pas de validation ») et un ordinaire.
  store.markSeen("sensible");
  store.setLevel("sensible", "never");
  store.setSensitive("sensible", true);
  store.markSeen("ordinaire");
  store.setLevel("ordinaire", "never");
  hub.connect("sensible");
  hub.connect("ordinaire");
  return {
    store,
    hub,
    lock,
    approvals,
    execution,
    clock,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

describe("Exécution — agent sensible VERROUILLÉ", () => {
  it("REFUS explicite et AUCUNE commande transmise", async () => {
    const f = fixture();
    const outcome = await f.execution.execute({ agentId: "sensible", command: "sudo reboot" });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("VERROUILLÉ");
    expect(outcome.message).toContain("n'a PAS");
    // ⚠️ LA preuve : rien n'est parti vers l'agent.
    expect(f.hub.sent).toHaveLength(0);
    // Aucune validation humaine n'a été ouverte (la commande ne partira pas).
    expect(f.approvals.list()).toHaveLength(0);
  });

  it("déverrouillé ⇒ la commande PART (et remet le compte d'inactivité à zéro)", async () => {
    const f = fixture();
    expect(f.lock.unlock("sensible", PASSWORD).ok).toBe(true);
    f.advance(14 * 60_000);
    const outcome = await f.execution.execute({ agentId: "sensible", command: "uptime" });
    expect(outcome.status).toBe("completed");
    expect(f.hub.sent).toHaveLength(1);
    expect(f.lock.status("sensible").remainingMs).toBe(SENSITIVE_IDLE_TIMEOUT_MS);
  });

  it("un agent NON sensible n'est pas affecté (aucune régression)", async () => {
    const f = fixture();
    const outcome = await f.execution.execute({ agentId: "ordinaire", command: "uptime" });
    expect(outcome.status).toBe("completed");
    expect(f.hub.sent).toHaveLength(1);
    expect(f.hub.sent[0]?.agentId).toBe("ordinaire");
  });

  it("une commande EN VOL au reverrouillage va AU BOUT ; la suivante est REFUSÉE", async () => {
    const f = fixture();
    expect(f.lock.unlock("sensible", PASSWORD).ok).toBe(true);
    f.hub.holdNext();
    const inFlight = f.execution.execute({ agentId: "sensible", command: "sleep 30" });
    // Pendant qu'elle est en vol, l'inactivité expire.
    f.advance(SENSITIVE_IDLE_TIMEOUT_MS);
    expect(f.lock.isLocked("sensible")).toBe(true);

    const first = await inFlight;
    // ⚠️ Elle n'a PAS été tuée : elle rend son résultat complet.
    expect(first.status).toBe("completed");
    expect(f.hub.sent).toHaveLength(1);

    const second = await f.execution.execute({ agentId: "sensible", command: "uptime" });
    expect(second.status).toBe("refused");
    expect(f.hub.sent).toHaveLength(1); // aucune nouvelle commande transmise
  });

  it("un refus pour cause de verrou ne remet PAS le compte à zéro (il n'a rien transmis)", async () => {
    const f = fixture();
    f.lock.unlock("sensible", PASSWORD);
    f.advance(SENSITIVE_IDLE_TIMEOUT_MS);
    const outcome = await f.execution.execute({ agentId: "sensible", command: "uptime" });
    expect(outcome.status).toBe("refused");
    expect(f.lock.isLocked("sensible")).toBe(true);
  });
});
