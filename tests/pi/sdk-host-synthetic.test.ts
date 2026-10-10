/**
 * Garde d'ÉPHÉMÉRITÉ du VRAI hôte (`src/pi/sdk-host.ts`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : le harnais WS teste un `FakePiHost`
 * (`tests/pi/host-double.ts`) dont le garde miroir EST couvert — mais le garde
 * du VRAI hôte ne l'était PAS : en retirant la ligne
 * `...(isSyntheticOrigin(run.origin) ? {} : { userText: run.text })` de
 * `sdk-host.ts`, aucun test ne tombait. Un garde non couvert casse en SILENCE.
 *
 * ⚠️ CE TEST EXERCE LE CODE RÉEL : on instancie le VRAI `createSdkPiHost` avec un
 * SDK STUBÉ (runtime de session factice injecté par `vi.mock`) — donc le vrai
 * `startRun` / `handleSdkEvent` de `sdk-host.ts` s'exécute. Un prompt
 * SYNTHÉTIQUE ne doit JAMAIS produire de `run_started` portant `userText`
 * (sinon la sortie d'une machine fuiterait dans le rejeu / le snapshot).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ORIGIN_APPROVAL_RESULT } from "../../src/agents/approval-report.js";
import { ORIGIN_JOB_REPORT } from "../../src/pi/synthetic.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";

/**
 * Titulaire du runtime stubé, créé avant les `vi.mock` (hoisté).
 * `sessionListeners` = les callbacks posés par le VRAI host sur la session ;
 * `emit` déclenche un événement SDK comme le ferait le SDK réel.
 */
const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async () => {
    const session = {
      sessionId: "real-host-stub-session",
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      // Le SDK émet `agent_start` au début d'un tour : c'est CE code
      // (`handleSdkEvent` de sdk-host.ts) que l'on veut exercer.
      prompt: async () => {
        stub.emit({ type: "agent_start" });
      },
      abort: async () => undefined,
      sessionManager: {
        getSessionName: () => undefined,
        getSessionFile: () => undefined,
        getBranch: () => [],
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

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-host-"));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  stub.sessionListeners.clear();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — garde d'éphémérité du prompt synthétique", () => {
  it("un prompt SYNTHÉTIQUE ne diffuse PAS userText dans run_started", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId();
    expect(sessionId).toBe("real-host-stub-session");

    host.send(sessionId!, "RÉSULTAT-SYNTHÉTIQUE-SECRET", {
      origin: ORIGIN_APPROVAL_RESULT,
    });
    await delay(20);

    const started = events.find((event) => event.type === "run_started");
    expect(started).toBeDefined();
    if (started?.type !== "run_started") throw new Error("run_started attendu");
    // ⚠️ LE GARDE : aucun `userText` pour une origine synthétique.
    expect(started.userText).toBeUndefined();
    expect(started.origin).toBe(ORIGIN_APPROVAL_RESULT);
    // Et la bulle utilisateur n'entre pas non plus dans le transcript.
    const transcript = host.getState(sessionId)?.transcript ?? [];
    expect(transcript.some((entry) => entry.role === "user")).toBe(false);

    await host.stop();
  });

  it("un prompt UTILISATEUR normal diffuse bien son userText", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId();

    host.send(sessionId!, "bonjour Yuki");
    await delay(20);

    const started = events.find((event) => event.type === "run_started");
    if (started?.type !== "run_started") throw new Error("run_started attendu");
    expect(started.userText).toBe("bonjour Yuki");
    expect(started.origin).toBeUndefined();

    await host.stop();
  });

  it("couvre aussi l'origine job_report (même canal synthétique)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId();

    host.send(sessionId!, "RAPPORT-DE-JOB", { origin: ORIGIN_JOB_REPORT });
    await delay(20);

    const started = events.find((event) => event.type === "run_started");
    if (started?.type !== "run_started") throw new Error("run_started attendu");
    expect(started.userText).toBeUndefined();
    expect(started.origin).toBe(ORIGIN_JOB_REPORT);

    await host.stop();
  });
});
