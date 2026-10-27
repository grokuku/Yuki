/**
 * Intégration — PERSISTANCE de l'ACCUSÉ DE RÉCEPTION (`run_ack`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : l'accusé ne pouvait pas rester une trame de
 * CONTRÔLE purement éphémère. Au rechargement, il DISPARAISSAIT en laissant une
 * bulle de réponse VIDE dans le fil — défaut signalé par l'utilisateur (« on
 * croit que Yuki n'a rien répondu »).
 *
 * ⚠️ CE QUI A CHANGÉ : l'accusé est désormais le PREMIER TEXTE DU TOUR, écrit par
 * le MODÈLE (plus une phrase figée par le code). Il est donc :
 *  - RETENU côté host (jamais émis comme `delta` de contenu) ⇒ jamais prononcé par
 *    la synthèse vocale, et jamais dans le corps de la réponse ;
 *  - PERSISTÉ à part (`yuki.run_ack`, données `{tool, text}`) ⇒ il revient à
 *    l'identique après un rechargement, même s'il est écrit par le repli en dur ;
 *  - EXCLU du corps au rechargement (le message qui n'était que l'accusé n'ouvre pas
 *    de bulle) ⇒ la phrase n'est jamais affichée deux fois.
 *
 * On exerce ici le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé par `vi.mock`,
 * adossé à un `SessionManager` RÉEL) et on inspecte le JSONL BRUT.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACK_FALLBACK_TEXTS } from "../../src/pi/ack.js";
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

/** Message assistant du SDK : blocs `text` PUIS blocs `toolCall`. */
function assistantMessage(text: string, tool?: string): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (text.length > 0) content.push({ type: "text", text });
  if (tool !== undefined) {
    content.push({ type: "toolCall", id: `call-${tool}`, name: tool, arguments: {} });
  }
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: tool !== undefined ? "toolUse" : "stop",
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

/**
 * Joue un run avec l'ORDRE RÉEL du SDK : texte de l'accusé (ou rien), `message_end`
 * du message portant l'outil, démarrage de l'outil, puis réponse éventuelle.
 */
async function runOnce(input: {
  tool?: string;
  /** Premier texte du tour (celui que le MODÈLE écrit, ou rien du tout). */
  ackText?: string;
  answer?: string;
  persistMessage: boolean;
}) {
  const host = makeHost();
  const events: PiEvent[] = [];
  host.subscribeAll((event) => events.push(event));
  await host.start();
  const sessionId = host.currentSessionId()!;
  const manager = stub.manager as Manager;
  const ackText = input.ackText ?? "";

  stub.onPrompt = async (m: Manager) => {
    stub.emit({ type: "agent_start" });
    if (input.tool !== undefined) {
      stub.emit({ type: "message_start", message: { role: "assistant" } });
      if (ackText.length > 0) {
        stub.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: ackText },
        });
      }
      const toolMessage = assistantMessage(ackText, input.tool);
      if (input.persistMessage) m.appendMessage(toolMessage as never);
      stub.emit({ type: "message_end", message: toolMessage });
      stub.emit({ type: "tool_execution_start", toolName: input.tool });
      stub.emit({ type: "tool_execution_end", toolName: input.tool, isError: false });
    }
    if (input.answer !== undefined) {
      stub.emit({ type: "message_start", message: { role: "assistant" } });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: input.answer },
      });
      const message = assistantMessage(input.answer);
      if (input.persistMessage) m.appendMessage(message as never);
      stub.emit({ type: "message_end", message });
    }
  };

  const handle = host.send(sessionId, "fais-moi une image");
  await waitForRunFinished(events, handle.runId);
  return { host, manager, sessionId, events, runId: handle.runId };
}

describe("sdk-host réel — l'accusé du MODÈLE est PERSISTÉ avec le message (run_ack)", () => {
  it("accusé du modèle + réponse : entrée custom enfant du message, texte VERBATIM", async () => {
    const ackSentence = "Deux secondes, je m'en occupe.";
    const { host, manager, sessionId } = await runOnce({
      tool: "generer_image",
      ackText: ackSentence,
      answer: "Voici l'image demandée.",
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;

    const lines = rawLines(file);
    const ackEntries = lines.filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE);
    expect(ackEntries).toHaveLength(1);
    // ⚠️ Les DONNÉES portent le texte RÉEL : sans lui, un rechargement montrerait
    // une autre phrase que celle qui a été dite (le modèle l'a écrite).
    expect(ackEntries[0].data).toEqual({ tool: "generer_image", text: ackSentence });

    // Le message persisté PAR LE SDK contient la phrase (c'est le texte du modèle) ;
    // l'entrée `custom` est retirée du contexte du modèle par le SDK, donc la
    // persistance de l'accusé ne le transforme pas en souvenir du modèle.
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(ackSentence);

    // Transcription LIVE : le corps ne contient PAS l'accusé (jamais un doublon).
    const live = host.getState(sessionId)!;
    const assistant = live.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.ack).toBe(ackSentence);
    expect(assistant?.text).toBe("Voici l'image demandée.");
    expect(assistant?.text).not.toContain(ackSentence);

    // ALLER-RETOUR : relecture par un `SessionManager` NEUF (comme après un
    // redémarrage du gateway) ⇒ l'accusé revient, et n'est PAS répété dans le corps.
    const restored = transcriptFromEntries(SessionManager.open(file).getBranch(), {
      syntheticUserPrefixes: [],
    });
    const restoredAssistant = restored.find((entry) => entry.role === "assistant");
    expect(restoredAssistant?.ack).toBe(ackSentence);
    expect(restoredAssistant?.text).toBe("Voici l'image demandée.");
  });

  it("run qui s'achève sur l'accusé : il revient SEUL après rechargement (jamais une bulle vide)", async () => {
    const ackSentence = "C'est parti.";
    const { host, manager, sessionId } = await runOnce({
      tool: "generer_image",
      ackText: ackSentence,
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;
    const live = host.getState(sessionId)!;
    const assistant = live.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.ack).toBe(ackSentence);
    expect(assistant?.text).toBe("");
    // Rechargement : le corps est vide, l'accusé est là. La phrase n'apparaît QU'UNE
    // fois (elle est retranchée du message persisté).
    const restored = transcriptFromEntries(SessionManager.open(file).getBranch(), {
      syntheticUserPrefixes: [],
    });
    const restoredAssistant = restored.find((entry) => entry.role === "assistant");
    expect(restoredAssistant?.ack).toBe(ackSentence);
    expect(restoredAssistant?.text).toBe("");
  });

  it("REPLI (le modèle n'a rien écrit) : le texte du repli est persisté et revient", async () => {
    const { host, manager, sessionId } = await runOnce({
      tool: "delegate",
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;
    const expected = (ACK_FALLBACK_TEXTS.delegate ?? [])[0];
    const ackEntries = rawLines(file).filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE);
    expect(ackEntries).toHaveLength(1);
    expect(ackEntries[0].data).toEqual({ tool: "delegate", text: expected });
    const live = host.getState(sessionId)!.transcript.find((e) => e.role === "assistant");
    expect(live?.ack).toBe(expected);
    const restored = transcriptFromEntries(SessionManager.open(file).getBranch(), {
      syntheticUserPrefixes: [],
    });
    expect(restored.find((e) => e.role === "assistant")?.ack).toBe(expected);
  });

  it("accusé SANS aucun message persisté : aucune entrée `run_ack` orpheline", async () => {
    const { host, manager, sessionId } = await runOnce({
      tool: "delegate",
      persistMessage: false,
    });
    const transcript = host.getState(sessionId)!.transcript;
    const assistant = transcript.find((entry) => entry.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.ack).toBe("Je m'en occupe.");
    expect(assistant?.text).toBe("");
    const file = manager.getSessionFile();
    if (file && existsSync(file)) {
      expect(rawLines(file).filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE)).toEqual([]);
    }
  });

  it("run SANS accusé : aucune entrée `run_ack` (jamais d'accusé inventé)", async () => {
    const { host, manager, sessionId } = await runOnce({
      answer: "Réponse immédiate.",
      persistMessage: true,
    });
    const file = manager.getSessionFile()!;
    expect(rawLines(file).filter((e) => e.customType === RUN_ACK_CUSTOM_TYPE)).toEqual([]);
    const assistant = host.getState(sessionId)!.transcript.find((e) => e.role === "assistant");
    expect(assistant?.ack).toBeUndefined();
    expect(assistant?.text).toBe("Réponse immédiate.");
  });

  it("l'accusé ne part JAMAIS dans le contenu streamé (donc jamais prononcé)", async () => {
    const ackSentence = "Je m'y mets.";
    const { events } = await runOnce({
      tool: "generer_image",
      ackText: ackSentence,
      answer: "Voici l'image demandée.",
      persistMessage: true,
    });
    // Le moteur TTS ne consomme que les `delta` de canal `content` : on vérifie
    // que l'accusé n'est jamais passé par là.
    const contentDeltas = events
      .filter((event) => event.type === "delta" && event.channel === "content")
      .map((event) => (event.type === "delta" ? event.text : ""))
      .join("");
    expect(contentDeltas).toBe("Voici l'image demandée.");
    expect(contentDeltas).not.toContain(ackSentence);
  });
});
