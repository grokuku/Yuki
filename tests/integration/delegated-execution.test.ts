/**
 * Intégration — INVERSION DES RÔLES : une tâche d'EXÉCUTION est DÉLÉGUÉE.
 *
 * Prouve la chaîne complète avec le VRAI worker lourd (`createSdkHeavyWorker`)
 * et le VRAI service d'exécution (`AgentExecutionService`) :
 *   1. Yuki (léger) LANCE une tâche via `delegate` → elle REND LA MAIN
 *      immédiatement (ticket non bloquant) ;
 *   2. le worker lourd, dans sa session ÉPHÉMÈRE, EXÉCUTE réellement la
 *      commande via l'outil `run_command` ;
 *   3. le RÉSULTAT revient dans la conversation (prompt de report).
 *
 * ⚠️ La session éphémère est un DOUBLE injecté (`createSession`) : aucun modèle
 * ni réseau n'est requis. Le reste du chemin (allowlist, outils d'action,
 * rattachement de la validation, service d'exécution, délégation) est RÉEL.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { HEAVY_MODEL, buildModelsConfig, toolAllowlist } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createSdkHeavyWorker } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";
import { FakePiHost } from "../pi/host-double.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await wait(5);
  }
}

/** Hub minimal : l'agent est EN LIGNE et répond à la commande. */
class StubHub {
  readonly sent: Array<{ agentId: string; command: string }> = [];
  isOnline(): boolean {
    return true;
  }
  hasCapability(): boolean {
    return true;
  }
  async sendCommand(
    agentId: string,
    request: { command: string },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    truncated: boolean;
    timedOut: boolean;
    stdoutTrunc: boolean;
    stderrTrunc: boolean;
  }> {
    this.sent.push({ agentId, command: request.command });
    return {
      exitCode: 0,
      stdout: "hello from nuc00",
      stderr: "",
      durationMs: 3,
      truncated: false,
      timedOut: false,
      stdoutTrunc: false,
      stderrTrunc: false,
    };
  }
}

type ToolLike = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

describe("intégration — la tâche d'exécution est DÉLÉGUÉE (inversion des rôles)", () => {
  it("Yuki lance, rend la main ; le worker exécute via run_command ; le résultat revient", async () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-deleg-exec-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const sessionsDir = join(agentDir, "sessions");

    // --- Service d'exécution RÉEL (store + audit + approbations) -------------
    const store = AgentStore.open({
      path: join(root, "agents.jsonl"),
      defaults: { level: "destructive", privilege: "normal" },
      logger,
    });
    store.markSeen("agent-nuc00");
    store.setName("agent-nuc00", "nuc00");
    const audit = AuditLog.open({
      path: join(root, "audit.jsonl"),
      maxSizeBytes: maxSizeBytesFromMb(1),
      retentionDays: 30,
      logger,
    });
    const approvals = new ApprovalRegistry({ logger });
    const hub = new StubHub();
    const execution = new AgentExecutionService({
      store,
      hub: hub as unknown as AgentHub,
      audit,
      approvals,
      logger,
    });

    // --- Chemins/modèles : `getSharedModelRuntime` doit réussir (hors ligne) --
    const paths = resolvePiPaths({ agentDir, cwd, home, sessionsDir, settingsSeedPath: "config/pi/settings.json" });
    seedSettingsFile(paths, logger);
    writeModelsFile(paths, buildModelsConfig(), logger);

    // --- Double de session ÉPHÉMÈRE : joue le modèle qui appelle `run_command` -
    const CONVERSATION = "conv-utilisateur-7";
    const EPHEMERAL = "ephemeral-heavy-99";
    type Listener = (event: unknown) => void;
    const capturedTools: ToolLike[] = [];
    let capturedAllowlist: readonly string[] | undefined;
    const fakeCreateSession = async (options: {
      tools?: readonly string[];
      customTools?: readonly unknown[];
    }): Promise<EphemeralSession> => {
      capturedAllowlist = options.tools;
      for (const tool of options.customTools ?? []) capturedTools.push(tool as ToolLike);
      let listener: Listener | undefined;
      const session = {
        sessionId: EPHEMERAL,
        subscribe(cb: Listener): () => void {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
        async prompt(): Promise<void> {
          // Le « modèle » invoque l'outil d'action. Le contexte de l'outil
          // expose l'ID ÉPHÉMÈRE : le rattachement à la conversation doit
          // malgré tout se faire (voir le test unitaire dédié).
          const runCommand = capturedTools.find((tool) => tool.name === "run_command");
          if (!runCommand) throw new Error("run_command absent de la session du worker");
          const result = await runCommand.execute(
            "call",
            { agent_id: "nuc00", command: "echo hi" },
            undefined,
            undefined,
            { sessionManager: { getSessionId: () => EPHEMERAL } },
          );
          const text = result.content.map((part) => part.text ?? "").join("\n");
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              stopReason: "stop",
              usage: { input: 1, output: 1 },
            },
          });
        },
        async abort(): Promise<void> {},
        dispose(): void {},
        async steer(): Promise<void> {},
      };
      return { session, diagnostics: [] } as unknown as EphemeralSession;
    };

    const heavy = createSdkHeavyWorker({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
      systemPrompt: readFileSync("config/pi/system-prompt-heavy.md", "utf8"),
      modelReference: HEAVY_MODEL.reference,
      thinking: HEAVY_MODEL.defaultThinking,
      // ⚠️ Le lourd porte l'exécution (allowlist) ET les services d'action.
      tools: toolAllowlist("heavy", { executionEnabled: true, screenshotsEnabled: true }),
      execution,
      screenshots: execution,
      createSession: fakeCreateSession as never,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
      logger,
    });

    const jobStore = JobStore.open({ path: join(root, "jobs.jsonl"), logger });
    const queue = new JobQueue({ maxConcurrent: 3, maxQueue: 10 });
    const service = createDelegationService({
      store: jobStore,
      queue,
      heavy,
      availability: { isAvailable: () => true },
      logger,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
    });

    // Waker ESPION : capture le prompt de report réellement envoyé au léger.
    const host = new FakePiHost({ sessionId: CONVERSATION });
    await host.start();
    const reports: Array<{ sessionId: string; text: string; origin?: string }> = [];
    service.setWaker({
      send: (sessionId, text, opts) => {
        reports.push({
          sessionId,
          text,
          ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
        });
        return host.send(sessionId, text, opts);
      },
    });

    // --- Yuki lance et REND LA MAIN (ticket non bloquant) --------------------
    const outcome = await service.delegate({
      task: "Exécute `echo hi` sur la machine nuc00",
      lightSessionId: CONVERSATION,
      background: true,
      origin: "delegate",
    });
    expect(outcome.status).toBe("dispatched");

    // --- Le worker exécute réellement la commande ----------------------------
    await waitFor(() => hub.sent.length > 0);
    expect(hub.sent[0]).toEqual({ agentId: "agent-nuc00", command: "echo hi" });

    // La session du worker a bien reçu l'outil d'action et l'allowlist du LOURD.
    expect(capturedTools.map((tool) => tool.name).sort()).toEqual([
      "capturer_ecran",
      "run_command",
    ]);
    expect(capturedAllowlist).toContain("run_command");
    expect(capturedAllowlist).toContain("capturer_ecran");

    // --- Le résultat revient dans la conversation ----------------------------
    service.flushPendingReports();
    await waitFor(() => reports.length > 0);
    expect(reports[0]?.sessionId).toBe(CONVERSATION);
    expect(reports[0]?.origin).toBe("job_report");
    // Le rapport porte l'issue de la commande exécutée par le worker.
    expect(reports[0]?.text ?? "").toContain("hello from nuc00");
    expect(reports[0]?.text ?? "").toContain("echo hi");
  });

  it("la validation d'une commande du WORKER remonte dans la CONVERSATION (session éphémère ≠ conversation)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-deleg-approval-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const sessionsDir = join(agentDir, "sessions");

    const store = AgentStore.open({
      path: join(root, "agents.jsonl"),
      defaults: { level: "always", privilege: "normal" },
      logger,
    });
    store.markSeen("agent-nuc00");
    store.setName("agent-nuc00", "nuc00");
    const audit = AuditLog.open({
      path: join(root, "audit.jsonl"),
      maxSizeBytes: maxSizeBytesFromMb(1),
      retentionDays: 30,
      logger,
    });
    const approvals = new ApprovalRegistry({ logger });
    const hub = new StubHub();
    const execution = new AgentExecutionService({
      store,
      hub: hub as unknown as AgentHub,
      audit,
      approvals,
      logger,
    });

    const paths = resolvePiPaths({ agentDir, cwd, home, sessionsDir, settingsSeedPath: "config/pi/settings.json" });
    seedSettingsFile(paths, logger);
    writeModelsFile(paths, buildModelsConfig(), logger);

    const CONVERSATION = "conv-utilisateur-8";
    const EPHEMERAL = "ephemeral-heavy-100";
    type Listener = (event: unknown) => void;
    const capturedTools: ToolLike[] = [];
    const fakeCreateSession = async (options: {
      customTools?: readonly unknown[];
    }): Promise<EphemeralSession> => {
      for (const tool of options.customTools ?? []) capturedTools.push(tool as ToolLike);
      let listener: Listener | undefined;
      const session = {
        sessionId: EPHEMERAL,
        subscribe(cb: Listener): () => void {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
        async prompt(): Promise<void> {
          const runCommand = capturedTools.find((tool) => tool.name === "run_command");
          const result = await runCommand!.execute(
            "call",
            { agent_id: "nuc00", command: "systemctl restart nginx" },
            undefined,
            undefined,
            { sessionManager: { getSessionId: () => EPHEMERAL } },
          );
          const text = result.content.map((part) => part.text ?? "").join("\n");
          listener?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text }],
              stopReason: "stop",
            },
          });
        },
        async abort(): Promise<void> {},
        dispose(): void {},
        async steer(): Promise<void> {},
      };
      return { session, diagnostics: [] } as unknown as EphemeralSession;
    };

    const heavy = createSdkHeavyWorker({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
      systemPrompt: readFileSync("config/pi/system-prompt-heavy.md", "utf8"),
      modelReference: HEAVY_MODEL.reference,
      thinking: HEAVY_MODEL.defaultThinking,
      tools: toolAllowlist("heavy", { executionEnabled: true, screenshotsEnabled: true }),
      execution,
      screenshots: execution,
      createSession: fakeCreateSession as never,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
      logger,
    });

    const jobStore = JobStore.open({ path: join(root, "jobs.jsonl"), logger });
    const queue = new JobQueue({ maxConcurrent: 3, maxQueue: 10 });
    const service = createDelegationService({
      store: jobStore,
      queue,
      heavy,
      availability: { isAvailable: () => true },
      logger,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 20_000,
    });

    await service.delegate({
      task: "Redémarre nginx sur nuc00",
      lightSessionId: CONVERSATION,
      background: true,
      origin: "delegate",
    });

    // La commande requiert une validation (niveau « always ») : elle N'EST PAS
    // exécutée, et la demande est rattachée à la CONVERSATION — jamais à la
    // session éphémère du worker.
    await waitFor(() => approvals.list().length > 0);
    const pending = approvals.list()[0]!;
    expect(pending.sessionId).toBe(CONVERSATION);
    expect(pending.sessionId).not.toBe(EPHEMERAL);
    expect(pending.command).toBe("systemctl restart nginx");
    // Aucune exécution n'a eu lieu tant que l'humain n'a pas validé.
    expect(hub.sent).toEqual([]);
  });
});
