/**
 * IMAGES EN ENTRÉE DU MODÈLE — injection dans un run EN COURS (`session.steer`).
 *
 * Un message utilisateur envoyé pendant qu'un tour tourne est INJECTÉ dans le run
 * en cours (`steer`). Une image qui l'accompagne doit suivre le MÊME chemin :
 * sinon l'utilisateur croit avoir envoyé une capture et le modèle ne voit rien.
 *
 * ⚠️ `src/pi/sdk-host.ts` appelait `steer(run.storedText)` sans second argument,
 * alors que le SDK 0.85.1 expose `steer(text, images?)`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiEvent, PiLogger } from "../../src/pi/types.js";

type StubImage = { type: string; data: string; mimeType: string };

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  /** Appels REÇUS par `session.steer` (texte + images). */
  steered: [] as Array<{ text: string; images?: Array<{ type: string; data: string; mimeType: string }> }>,
  /** Appels REÇUS par `session.prompt`. */
  prompts: [] as string[],
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
      prompt: async (text: string) => {
        stub.prompts.push(text);
        stub.emit({ type: "agent_start" });
        await new Promise<void>((resolve) => {
          stub.releasePrompt = resolve;
        });
      },
      steer: async (
        text: string,
        images?: Array<{ type: string; data: string; mimeType: string }>,
      ) => {
        stub.steered.push({ text, ...(images !== undefined ? { images } : {}) });
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

/** Base64 d'un PNG 1×1 réel (transmis tel quel, jamais décodé ici). */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const temps: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-steer-images-"));
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
  stub.steered.length = 0;
  stub.prompts.length = 0;
  stub.releasePrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — IMAGES d'un message injecté (steer)", () => {
  it("l'image accompagne l'injection : `steer(texte, [ImageContent])`", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "message initial");
    await delay(10);
    expect(stub.prompts).toHaveLength(1);

    // ⚠️ Le run tourne encore : ce message est INJECTÉ (`steer`), pas mis en file.
    const second = host.send(sessionId, "voici la capture", {
      images: [{ data: PNG_BASE64, mimeType: "image/png" }],
    });
    expect(second.queued).toBe(false);
    await delay(10);

    expect(stub.steered).toHaveLength(1);
    const images: StubImage[] | undefined = stub.steered[0]?.images;
    expect(stub.steered[0]?.text).toContain("voici la capture");
    // ⚠️ PREUVE : l'image arrive au SDK avec l'injection, dans la forme attendue.
    expect(images).toHaveLength(1);
    expect(images?.[0]).toEqual({
      type: "image",
      data: PNG_BASE64,
      mimeType: "image/png",
    });
    // Aucun nouveau tour normal : l'injection n'ouvre pas de run.
    expect(stub.prompts).toHaveLength(1);

    await releaseAndFinish(events, first.runId);
    expect(host.getState(sessionId)?.state).toBe("idle");
  });

  it("une injection SANS image ne change rien (texte seul)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "message initial");
    await delay(10);
    host.send(sessionId, "précision");
    await delay(10);

    expect(stub.steered).toHaveLength(1);
    expect(stub.steered[0]?.images).toBeUndefined();

    await releaseAndFinish(events, first.runId);
  });
});
