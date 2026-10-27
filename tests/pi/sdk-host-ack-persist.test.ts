/**
 * Intégration — PERSISTANCE de l'ACCUSÉ DE RÉCEPTION (`run_ack`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : l'accusé était une trame de CONTRÔLE purement
 * éphémère. Au rechargement, il DISPARAISSAIT en laissant une bulle de réponse
 * VIDE dans le fil — défaut signalé par l'utilisateur (« on croit que Yuki n'a
 * rien répondu »).
 *
 * On exerce ici le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé par `vi.mock`,
 * adossé à un `SessionManager` RÉEL) et on inspecte le JSONL BRUT :
 *
 *   - un run qui accuse réception puis répond écrit UNE entrée `custom`
 *     (`yuki.run_ack`) rattachée au message assistant ;
 *   - cette entrée ne contient QUE le NOM DE L'OUTIL — jamais la phrase, qui
 *     n'apparaît NULLE PART dans le JSONL (donc jamais dans le contexte du
 *     modèle : ce n'est pas un souvenir) ;
 *   - le TEXTE du message ne contient pas l'accusé (il n'est donc jamais
 *     prononcé par la synthèse vocale, qui ne lit que le contenu) ;
 *   - RELIRE la session (nouveau `SessionManager`) restitue l'accusé ;
 *   - un run qui accuse réception SANS produire de texte laisse une entrée de
 *     transcript portant l'accusé seul (aucune bulle vide) ;
 *   - un run SANS accusé n'écrit aucune entrée `run_ack`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ackTextForTool } from "../../src/pi/ack.js";
import { RUN_ACK_CUSTOM_TYPE, transcriptFromEntries } from "../../src/pi/events.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

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
        const onPrompt = stub.onPrompt as ((manager: Manager) => Promise<void>) | undefined;
        if (onPrompt) await onPrompt(options.sessionManager as unknown as Manager);
      },
      abort: async () => undefined,
      sessionManager: options.sessionManager,
      model: undefined,
      thinkingLevel: "off",
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
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
  const dir = mkdtempSync(join(tmpdir(), "yuki-ack-persist-"));
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
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
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

function waitForRunFinished(events: PiEvent[], runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
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

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.manager = undefined;
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Le tour réel du SDK : un texte éventuel, puis le démarrage d'un outil. */
async function runOnce(input: { tool?: string; text?: string; persistMessage: boolean }) {
  const host = makeHost();
  const events: PiEvent[] = [];
  host.subscribeAll((event) => events.push(event));
  await host.start();
  const sessionId = host.currentSessionId()!;
  const manager = stub.manager as Manager;

  stub.onPrompt = async (m: Manager) => {
    stub.emit({ type: "agent_start" });
    // ⚠️ Ordre RÉEL du cas utile : le modèle va DROIT à l'outil (rien n'a encore
    // été dit), l'accusé part, puis le texte arrive après le retour de l'outil.
    if (input.tool !== undefined) {
      stub.emit({ type: "tool_execution_start", toolName: input.tool });
      stub.emit({ type: "tool_execution_end", toolName: input.tool, isError: false });
    }
    if (input.text !== undefined) {
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: input.text },
      });
    }
    if (input.persistMessage && input.text !== undefined) {
      const message = assistantMessage(input.text);
      m.appendMessage(message as never);
      stub.emit({ type: "message_end", message });
    }
  };

  const handle = host.send(sessionId, "fais-moi une image");
  await waitForRunFinished(events, handle.runId);
  return { host, manager, sessionId, events, runId: handle.runId };
}

describe("sdk-host réel — l'accusé est PERSISTÉ avec le message (run_ack)", () => {
  it("accusé + réponse : entrée custom enfant du message, sans la phrase", async () => {
    const { host, manager, sessionId } = await runOnce({
      tool: "generer_image",
      text: "Voici l'image demandée.",
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;

    const lines = rawLines(file);
    const ackEntries = lines.filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE);
    expect(ackEntries).toHaveLength(1);
    // ⚠️ Les DONNÉES ne portent que le nom d'outil : le libellé reste dans
    // `src/pi/ack.ts` (source unique), il ne se fige pas dans l'historique.
    expect(ackEntries[0].data).toEqual({ tool: "generer_image" });
    expect(JSON.stringify(ackEntries[0].data)).not.toContain("C'est parti");

    // ⚠️ La PHRASE n'apparaît NULLE PART dans le JSONL de session : les entrées
    // `custom` étant retirées du contexte du modèle par le SDK, l'accusé ne peut
    // donc jamais être mémorisé ni relu comme une parole de Yuki.
    const raw = readFileSync(file, "utf8");
    for (const tool of ["generer_image", "delegate", "run_command"]) {
      const phrase = ackTextForTool(tool)!;
      expect(raw).not.toContain(phrase);
    }

    // Rattachement : le message assistant est bien dans la branche, et le
    // transcript LIVE porte l'accusé AVEC le texte, sans mélange.
    const live = host.getState(sessionId)!;
    const assistant = live.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.ack).toBe("C'est parti.");
    expect(assistant?.text).toBe("Voici l'image demandée.");
    expect(assistant?.text).not.toContain("C'est parti");

    // ALLER-RETOUR : relecture de la session par un SessionManager NEUF (comme
    // après un redémarrage du gateway) ⇒ l'accusé revient en tête du message.
    const restored = transcriptFromEntries(SessionManager.open(file).getBranch(), {
      syntheticUserPrefixes: [],
    });
    const restoredAssistant = restored.find((entry) => entry.role === "assistant");
    expect(restoredAssistant?.text).toBe("Voici l'image demandée.");
    expect(restoredAssistant?.ack).toBe("C'est parti.");
  });

  it("accusé SANS texte : la bulle existe quand même (jamais une bulle vide)", async () => {
    const { host, manager, sessionId } = await runOnce({
      tool: "delegate",
      persistMessage: false,
    });
    const transcript = host.getState(sessionId)!.transcript;
    const assistant = transcript.find((entry) => entry.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.ack).toBe("Je m'en occupe.");
    expect(assistant?.text).toBe("");
    // Aucun message assistant persisté ⇒ rien n'est écrit dans le JSONL (aucune
    // entrée `run_ack` orpheline, rattachable à un mauvais message).
    const file = manager.getSessionFile();
    if (file && existsSync(file)) {
      expect(rawLines(file).filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE)).toEqual([]);
    }
  });

  it("run SANS accusé : aucune entrée `run_ack` (jamais d'accusé inventé)", async () => {
    const { host, manager, sessionId } = await runOnce({
      text: "Réponse immédiate.",
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;
    expect(rawLines(file).filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE)).toEqual([]);
    const assistant = host.getState(sessionId)!.transcript.find((e) => e.role === "assistant");
    expect(assistant?.ack).toBeUndefined();
    expect(assistant?.text).toBe("Réponse immédiate.");
  });

  it("l'accusé ne part JAMAIS dans le contenu streamé (donc jamais prononcé)", async () => {
    const { events } = await runOnce({
      tool: "generer_image",
      text: "Voici l'image demandée.",
      persistMessage: true,
    });
    // Le moteur TTS ne consomme que les `delta` de canal `content` : on vérifie
    // que l'accusé n'est jamais passé par là.
    const contentDeltas = events
      .filter((event) => event.type === "delta" && event.channel === "content")
      .map((event) => (event.type === "delta" ? event.text : ""))
      .join("");
    expect(contentDeltas).toBe("Voici l'image demandée.");
    expect(contentDeltas).not.toContain("C'est parti");
  });
});
