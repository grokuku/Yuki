/**
 * IMAGES EN ENTRÉE DU MODÈLE — tour NORMAL (`session.prompt`).
 *
 * ⚠️ Le constat qui justifie ce fichier : le modèle de chat SAIT voir
 * (`src/llm/models.ts` — `input: ["text", "image"]`), le SDK 0.85.1 accepte des
 * images sur `prompt` (`PromptOptions.images`), mais `src/pi/sdk-host.ts` ne les
 * passait JAMAIS : le message utilisateur était du texte pur de bout en bout, et
 * une image jointe restait invisible pour le modèle.
 *
 * Ici le runtime SDK est STUBÉ, mais le VRAI `send` / `startRun` du host est
 * traversé : on observe donc exactement ce que le SDK reçoit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiEvent, PiLogger } from "../../src/pi/types.js";

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  /** Appels REÇUS par `session.prompt` (texte + options, images comprises). */
  prompts: [] as Array<{
    text: string;
    images?: Array<{ type: string; data: string; mimeType: string }>;
    expandPromptTemplates?: boolean;
  }>,
  releasePrompt: undefined as unknown,
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
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async (
        text: string,
        promptOptions?: {
          images?: Array<{ type: string; data: string; mimeType: string }>;
          expandPromptTemplates?: boolean;
        },
      ) => {
        stub.prompts.push({
          text,
          ...(promptOptions?.images !== undefined ? { images: promptOptions.images } : {}),
          ...(promptOptions?.expandPromptTemplates !== undefined
            ? { expandPromptTemplates: promptOptions.expandPromptTemplates }
            : {}),
        });
        stub.emit({ type: "agent_start" });
        await new Promise<void>((resolve) => {
          stub.releasePrompt = resolve;
        });
      },
      steer: async () => undefined,
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

/** Base64 d'un PNG 1×1 réel (l'image n'est pas décodée ici, elle est transmise). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const temps: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-images-"));
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

function releaseAndFinish(events: PiEvent[], runId: string): Promise<void> {
  const release = stub.releasePrompt as (() => void) | undefined;
  release?.();
  stub.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "réponse" }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
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

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.prompts.length = 0;
  stub.releasePrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — IMAGES d'un message utilisateur (tour normal)", () => {
  it("transmet l'image au SDK : `prompt(…, { images: [ImageContent] })`", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const handle = host.send(sessionId, "regarde cette capture", {
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    await delay(10);

    expect(stub.prompts).toHaveLength(1);
    const images = stub.prompts[0]?.images;
    // ⚠️ PREUVE : l'image arrive au SDK, dans la forme qu'il attend
    // (`ImageContent` : `{ type: "image", data, mimeType }`).
    expect(images).toHaveLength(1);
    expect(images?.[0]).toEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });
    // Le texte, lui, n'est pas altéré par la pièce jointe.
    expect(stub.prompts[0]?.text).toContain("regarde cette capture");

    await releaseAndFinish(events, handle.runId);
    expect(host.getState(sessionId)?.state).toBe("idle");
  });

  it("un message SANS image n'ajoute aucune option : le tour texte reste identique", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const handle = host.send(sessionId, "bonjour");
    await delay(10);

    expect(stub.prompts).toHaveLength(1);
    // Aucune clé `images` (ni tableau vide) : rien ne change pour un texte seul.
    expect(stub.prompts[0]?.images).toBeUndefined();
    expect(stub.prompts[0]?.expandPromptTemplates).toBe(false);

    await releaseAndFinish(events, handle.runId);
  });

  it("un message SYNTHÉTIQUE ne porte JAMAIS d'image (le chemin en file reste texte)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    // Report de job : prompt synthétique, avec des images fournies par erreur.
    host.send(sessionId, "Résultat du job", {
      origin: "job_report",
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    await delay(10);

    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]?.images).toBeUndefined();

    // ⚠️ Le prompt synthétique peut être MIS EN FILE et rejoué plus tard : c'est
    // précisément pourquoi il ne doit jamais transporter d'image.
    const runId = events.find((e) => e.type === "run_started")?.runId;
    if (runId) await releaseAndFinish(events, runId);
  });
});
