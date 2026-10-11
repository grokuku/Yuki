/**
 * Intégration — E0 : REGISTRE DE SESSIONS CONCURRENTES (fondation du
 * parallélisme). On exerce le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé par
 * `vi.mock`, chaque `createLightRuntime` renvoyant un runtime PROPRE à la
 * session) adossé à des `SessionManager` RÉELS.
 *
 * ⚠️ CE QUE CE TEST PROUVE (critère de réussite de E0) :
 *   - DEUX conversations peuvent avoir un run EN VOL simultanément : un 2ᵉ
 *     `send` (sur une autre session) N'ANNULE PAS le 1er run — l'ancien host
 *     mono-runtime l'aurait tué (`replaceSession` ⇒ `host.abort(previous)`).
 *   - AUCUNE contamination croisée : l'abonné d'une session ne reçoit QUE les
 *     événements de SA session (isolation par sessionId).
 *   - `stop()` ferme TOUS les runtimes (aucun runtime orphelin).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiEvent, PiLogger } from "../../src/pi/types.js";

/** État de suivi par session (clé = sessionId), partagé avec le mock hoisté. */
const stub = vi.hoisted(() => ({
  sessions: new Map<
    string,
    {
      listeners: Set<(event: unknown) => void>;
      abortCount: number;
      disposed: boolean;
      resolvePrompt?: () => void;
    }
  >(),
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: { sessionManager: { getSessionId(): string } }) => {
    const sessionId = options.sessionManager.getSessionId();
    const entry = {
      listeners: new Set<(event: unknown) => void>(),
      abortCount: 0,
      disposed: false,
      resolvePrompt: undefined as undefined | (() => void),
    };
    stub.sessions.set(sessionId, entry);
    const session = {
      sessionId,
      subscribe: (cb: (event: unknown) => void) => {
        entry.listeners.add(cb);
        return () => entry.listeners.delete(cb);
      },
      // Le SDK réel émet `agent_start` au début d'un tour, puis le prompt reste
      // en vol jusqu'à la fin du tour : on reproduit exactement ces deux temps.
      prompt: async () => {
        for (const cb of [...entry.listeners]) cb({ type: "agent_start" });
        await new Promise<void>((resolve) => {
          entry.resolvePrompt = resolve;
        });
      },
      abort: async () => {
        entry.abortCount += 1;
        entry.resolvePrompt?.();
      },
      sessionManager: options.sessionManager,
    };
    return {
      session,
      dispose: async () => {
        entry.disposed = true;
      },
    };
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

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-e0-"));
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

/** Achève le prompt en vol de la session (le run se termine en `done`). */
function finishPrompt(sessionId: string): void {
  stub.sessions.get(sessionId)?.resolvePrompt?.();
}

/** Attend un `run_finished` (délai de garde). */
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

afterEach(() => {
  stub.sessions.clear();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("E0 — registre de sessions concurrentes", () => {
  it("DEUX runs simultanés : le 2ᵉ send n'annule PAS le 1er ; non-contamination ; shutdown ferme tout", async () => {
    const host = makeHost();
    const all: PiEvent[] = [];
    const aEvents: PiEvent[] = [];
    host.subscribeAll((event) => all.push(event));
    await host.start();

    const sidA = host.currentSessionId();
    expect(sidA).toBeTruthy();
    host.subscribe(sidA!, (event) => aEvents.push(event));

    // (1) run 1 sur la conversation A — reste EN VOL.
    const runA = host.send(sidA!, "un");
    expect(host.getState(sidA!)?.state).toBe("streaming");

    // (2) on ouvre une 2ᵉ CONVERSATION (B) : le focus bascule SANS tuer le run de A.
    await host.newSession();
    const sidB = host.currentSessionId();
    expect(sidB).toBeTruthy();
    expect(sidB).not.toBe(sidA);
    expect(stub.sessions.get(sidA!)?.abortCount).toBe(0);
    expect(host.getState(sidA!)?.state).toBe("streaming");
    expect(host.getState(sidB!)?.state).toBe("idle");

    // (3) run 2 sur B — les DEUX runs vivent en parallèle.
    const runB = host.send(sidB!, "deux");
    expect(host.getState(sidA!)?.state).toBe("streaming");
    expect(host.getState(sidB!)?.state).toBe("streaming");
    expect(stub.sessions.get(sidA!)?.abortCount).toBe(0);

    // (4) les deux runs produisent leurs PROPRES événements (bon sessionId).
    expect(
      all.some(
        (e) => e.type === "run_started" && e.sessionId === sidA && e.runId === runA.runId,
      ),
    ).toBe(true);
    expect(
      all.some(
        (e) => e.type === "run_started" && e.sessionId === sidB && e.runId === runB.runId,
      ),
    ).toBe(true);

    // (5) les deux runs se terminent normalement.
    finishPrompt(sidA!);
    await waitForRunFinished(all, runA.runId);
    finishPrompt(sidB!);
    await waitForRunFinished(all, runB.runId);
    expect(stub.sessions.get(sidA!)?.abortCount).toBe(0);

    // NON-CONTAMINATION : l'abonné de A n'a JAMAIS reçu un événement de B.
    expect(aEvents.length).toBeGreaterThan(0);
    expect(aEvents.every((e) => e.sessionId === sidA)).toBe(true);
    expect(aEvents.some((e) => e.sessionId === sidB)).toBe(false);

    // SHUTDOWN PROPRE : les DEUX runtimes sont fermés.
    await host.stop();
    expect(stub.sessions.get(sidA!)?.disposed).toBe(true);
    expect(stub.sessions.get(sidB!)?.disposed).toBe(true);
    expect(host.currentSessionId()).toBeUndefined();
  });

  it("re-focaliser une session dont le run est EN VOL ne le tue pas et ne reconstruit rien", async () => {
    const host = makeHost();
    const all: PiEvent[] = [];
    host.subscribeAll((event) => all.push(event));
    await host.start();

    const sidA = host.currentSessionId()!;
    const runA = host.send(sidA, "un");
    expect(host.getState(sidA)?.state).toBe("streaming");

    // Nouvelle conversation B, puis retour sur A via son fichier.
    await host.newSession();
    const sidB = host.currentSessionId()!;
    const fileA = await host.sessionFileFor(sidA);
    // Le runtime de A n'est PAS encore persisté sur disque (aucune réponse) :
    // `sessionFileFor` le retrouve quand même via le registre vivant.
    expect(fileA).toBeTruthy();
    await host.resume(fileA!);

    // Re-focus : le run de A est TOUJOURS en vol, aucune annulation.
    expect(host.currentSessionId()).toBe(sidA);
    expect(host.getState(sidA)?.state).toBe("streaming");
    expect(stub.sessions.get(sidA)?.abortCount).toBe(0);
    // Aucun nouveau runtime A n'a été fabriqué (le registre l'a réutilisé).
    expect(stub.sessions.size).toBe(2);

    finishPrompt(sidA);
    await waitForRunFinished(all, runA.runId);
    expect(host.currentSessionId()).toBe(sidA);

    await host.stop();
    expect(stub.sessions.get(sidA)?.disposed).toBe(true);
    expect(stub.sessions.get(sidB)?.disposed).toBe(true);
  });
});
