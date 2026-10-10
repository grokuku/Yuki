/**
 * Intégration — PERSISTANCE des statistiques d'exécution (`run_metrics`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : les stats (TTFT / total / tokens) n'ont jamais
 * survécu au rechargement ; elles vivaient uniquement dans la trame éphémère
 * `run_summary`. On exerce ici le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé
 * par `vi.mock`, mais adossé à un `SessionManager` RÉEL du SDK) :
 *
 *   - un run RÉUSSI écrit une entrée `custom` (`yuki.run_metrics`) ENFANT du
 *     message assistant, avec les TROIS valeurs (nombres seuls) ;
 *   - RELIRE la session (nouveau `SessionManager`) restitue ces trois valeurs ;
 *   - un run en ERREUR n'écrit AUCUNE entrée `run_metrics` (aucune orpheline) ;
 *   - un run qui ne persiste RIEN (réponse vide) n'écrit rien non plus.
 *
 * Le JSONL BRUT est inspecté (preuve directe), pas seulement le transcript.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RUN_METRICS_CUSTOM_TYPE, transcriptFromEntries } from "../../src/pi/events.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

/**
 * Titulaire du runtime stubé. `manager` est le `SessionManager` RÉEL créé par
 * le host (passé à `createLightRuntime`). `onPrompt` simule ce que ferait le
 * SDK pendant un tour : persister un message assistant puis émettre ses
 * événements.
 */
type Manager = ReturnType<typeof SessionManager.create>;

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  manager: undefined as unknown,
  onPrompt: undefined as unknown,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: {
      getSessionId(): string;
      getSessionName(): string | undefined;
      getSessionFile(): string | undefined;
      getBranch(): unknown[];
    };
  }) => {
    stub.manager = options.sessionManager;
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async () => {
        const onPrompt = stub.onPrompt as ((manager: unknown) => Promise<void>) | undefined;
        if (onPrompt) await onPrompt(options.sessionManager);
      },
      abort: async () => undefined,
      sessionManager: options.sessionManager,
    };
    return { session, dispose: async () => undefined };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { createSdkPiHost } from "../../src/pi/sdk-host.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-run-metrics-"));
  temps.push(dir);
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
  });
  hosts.push(host);
  return host;
}

const USAGE = {
  input: 10,
  output: 412,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 422,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function errorMessage(): Record<string, unknown> {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: "error",
    errorMessage: "503 Service Unavailable",
    timestamp: Date.now(),
  };
}

/** Attend le `run_finished` du run, avec un délai de garde. */
function waitForRunFinished(events: PiEvent[], runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const tick = () => {
      if (events.some((e) => e.type === "run_finished" && e.runId === runId)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("run_finished non reçu"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function rawLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function metricsEntries(file: string): Array<Record<string, unknown>> {
  return rawLines(file).filter((entry) => entry.customType === RUN_METRICS_CUSTOM_TYPE);
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.manager = undefined;
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — persistance des statistiques d'exécution (run_metrics)", () => {
  it("run RÉUSSI : écrit une entrée custom enfant du message assistant et RELIT les 3 valeurs", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;
    const manager = stub.manager as Manager;

    stub.onPrompt = async (m: Manager) => {
      const assistant = assistantMessage("Bonjour depuis le modèle");
      m.appendMessage(assistant as never);
      stub.emit({ type: "agent_start" });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Bonjour" },
      });
      stub.emit({ type: "message_end", message: assistant });
    };

    const handle = host.send(sessionId, "question");
    await waitForRunFinished(events, handle.runId);

    const file = manager.getSessionFile();
    expect(file).toBeDefined();

    // — Preuve BRUTE : l'entrée custom est bien écrite, nombres seuls, et son
    //   `parentId` EST l'identifiant du message assistant.
    const lines = rawLines(file!);
    const custom = lines.filter((e) => e.customType === RUN_METRICS_CUSTOM_TYPE);
    expect(custom).toHaveLength(1);
    const assistantLine = lines.find(
      (e) => e.type === "message" && (e.message as { role?: string }).role === "assistant",
    );
    expect(assistantLine).toBeDefined();
    expect(custom[0].type).toBe("custom");
    expect(custom[0].parentId).toBe(assistantLine!.id);
    expect(Object.keys(custom[0].data as object).sort()).toEqual([
      "tokensOut",
      "totalMs",
      "ttftMs",
    ]);
    // ⚠️ Aucun TEXTE dans les données : uniquement des nombres.
    for (const value of Object.values(custom[0].data as Record<string, unknown>)) {
      expect(typeof value).toBe("number");
    }
    expect(JSON.stringify(custom[0].data)).not.toContain("question");
    expect(JSON.stringify(custom[0].data)).not.toContain("Bonjour");

    // — Le snapshot LIVE expose déjà les métriques sur le message assistant.
    const live = host.getState(sessionId)!;
    const liveAssistant = live.transcript.find((entry) => entry.role === "assistant");
    expect(liveAssistant?.metrics?.tokensOut).toBe(412);
    expect(typeof liveAssistant?.metrics?.totalMs).toBe("number");
    expect(typeof liveAssistant?.metrics?.ttftMs).toBe("number");

    // — ALLER-RETOUR COMPLET : on ROUVRE la session dans un SessionManager neuf
    //   (comme au redémarrage) et on restaure le transcript.
    const reopened = SessionManager.open(file!);
    const restored = transcriptFromEntries(reopened.getBranch(), {
      syntheticUserPrefixes: [],
    });
    const restoredAssistant = restored.find((entry) => entry.role === "assistant");
    expect(restoredAssistant?.text).toBe("Bonjour depuis le modèle");
    expect(restoredAssistant?.metrics?.ttftMs).toBe(
      liveAssistant?.metrics?.ttftMs,
    );
    expect(restoredAssistant?.metrics?.totalMs).toBe(
      liveAssistant?.metrics?.totalMs,
    );
    expect(restoredAssistant?.metrics?.tokensOut).toBe(412);
  });

  it("run en ERREUR : AUCUNE entrée run_metrics, aucune entrée orpheline (JSONL brut)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;
    const manager = stub.manager as Manager;

    stub.onPrompt = async (m: Manager) => {
      const assistant = errorMessage();
      m.appendMessage(assistant as never);
      stub.emit({ type: "agent_start" });
      stub.emit({ type: "message_end", message: assistant });
    };

    const handle = host.send(sessionId, "question qui échoue");
    await waitForRunFinished(events, handle.runId);

    const finished = events.find(
      (e) => e.type === "run_finished" && e.runId === handle.runId,
    );
    expect(finished?.type === "run_finished" && finished.reason).toBe("error");

    const file = manager.getSessionFile()!;
    expect(metricsEntries(file)).toHaveLength(0);
    // La seule entrée `message` est le message en erreur (contenu vide) : aucune
    // métrique ne lui est rattachée, et aucune entrée custom n'existe.
    const custom = rawLines(file).filter((e) => e.type === "custom");
    expect(custom).toEqual([]);

    const transcript = host.getState(sessionId)!.transcript;
    expect(transcript.some((entry) => entry.metrics !== undefined)).toBe(false);
  });

  it("run sans message persisté (réponse vide) : aucune entrée run_metrics", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;
    const manager = stub.manager as Manager;

    // Le prompt se termine SANS persister de message assistant.
    stub.onPrompt = async () => undefined;

    const handle = host.send(sessionId, "question restée sans réponse");
    await waitForRunFinished(events, handle.runId);

    const finished = events.find(
      (e) => e.type === "run_finished" && e.runId === handle.runId,
    );
    expect(finished?.type === "run_finished" && finished.reason).toBe("done");

    const file = manager.getSessionFile();
    // Le fichier n'est ÉCRIT qu'à la première réponse assistant : sans réponse,
    // il n'existe pas (aucune métrique ne peut donc y être orpheline).
    if (file && existsSync(file)) {
      expect(metricsEntries(file)).toHaveLength(0);
    }
    expect(
      host.getState(sessionId)!.transcript.some((e) => e.metrics !== undefined),
    ).toBe(false);
  });
});
