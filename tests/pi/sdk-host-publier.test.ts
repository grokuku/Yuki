/**
 * PUBLICATION SANS TOUR DE MODÈLE — `PiHost.publierMessage` (lot 26, moteur
 * horloge), exercée sur le VRAI `src/pi/sdk-host.ts`.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : le résultat d'un DÉCLENCHEUR PLANIFIÉ est produit
 * par le worker lourd. Le faire passer par un tour du léger serait un détour (et
 * un second rédacteur inutile) : le host doit donc savoir écrire un message
 * assistant dans une conversation LOCALE sans générer quoi que ce soit.
 *
 * Ce qui est verrouillé :
 *  - le message est PERSISTÉ dans la session (`appendMessage`, rôle `assistant`) ⇒
 *    il survit à un rechargement ;
 *  - il entre dans le transcript (donc dans un snapshot) ;
 *  - il est ANNONCÉ par les trames habituelles (`run_started` → `delta` →
 *    `run_finished`), sans `userText` : ce n'est pas une parole de l'utilisateur ;
 *  - un texte vide est REFUSÉ (aucun message fantôme), une session inconnue aussi.
 *
 * ⚠️ Échoue sur le code d'origine : `publierMessage` n'existe pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiEvent, PiLogger } from "../../src/pi/types.js";

const stub = vi.hoisted(() => ({
  appended: [] as Array<{ role?: unknown; content?: unknown }>,
  emit: (_event: unknown): void => undefined,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async () => {
    const session = {
      sessionId: "session-reelle",
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      sessionManager: {
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        getBranch: () => [],
        appendMessage: (message: { role?: unknown; content?: unknown }) => {
          stub.appended.push(message);
          return "entry-publiee";
        },
        appendCustomEntry: () => "entry-custom",
      },
    };
    return { session };
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

afterEach(() => {
  stub.appended.length = 0;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-host-publier-"));
  temps.push(dir);
  return createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
  });
}

describe("sdk-host réel — publier un message sans tour", () => {
  it("persiste le message assistant, l'ajoute au transcript et l'annonce", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId() as string;

    await host.publierMessage?.(sessionId, "Le disque est plein à 96 %.");
    await delay(20);

    // ① PERSISTÉ : un message assistant ordinaire (relisible après rechargement).
    expect(stub.appended).toHaveLength(1);
    expect(stub.appended[0]?.role).toBe("assistant");
    expect(JSON.stringify(stub.appended[0]?.content)).toContain("disque est plein");

    // ② TRANSCRIPT : le message apparaît comme une réponse de Yuki.
    const state = host.getState(sessionId);
    const assistant = state?.transcript.filter((entry) => entry.role === "assistant") ?? [];
    expect(assistant.at(-1)?.text).toBe("Le disque est plein à 96 %.");
    expect(assistant.at(-1)?.id).toBe("entry-publiee");

    // ③ TRAMES : bulle ouverte, texte, bulle close — SANS `userText`.
    const types = events.map((event) => event.type);
    expect(types).toContain("run_started");
    expect(types).toContain("delta");
    expect(types).toContain("run_finished");
    const started = events.find((event) => event.type === "run_started") as
      | { userText?: string }
      | undefined;
    expect(started?.userText).toBeUndefined();
    const delta = events.find((event) => event.type === "delta") as
      | { channel?: string; text?: string }
      | undefined;
    expect(delta?.channel).toBe("content");
    expect(delta?.text).toContain("disque est plein");

    await host.stop();
  });

  it("refuse un texte vide (aucun message fantôme) et une session inconnue", async () => {
    const host = makeHost();
    await host.start();
    const sessionId = host.currentSessionId() as string;

    await expect(host.publierMessage?.(sessionId, "   ")).rejects.toThrow(/Message vide/);
    await expect(host.publierMessage?.("session-inconnue", "texte")).rejects.toThrow(
      /Session inconnue/,
    );
    expect(stub.appended).toHaveLength(0);

    await host.stop();
  });
});
