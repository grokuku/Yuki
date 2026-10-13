/**
 * Outils d'ACTION du worker lourd — RATTACHEMENT DE LA VALIDATION (piège ①).
 *
 * ⚠️ PIÈGE ① : une demande de validation est routée par `sessionId`. Le worker
 * tourne dans une session ÉPHÉMÈRE : si l'outil prenait l'ID de CETTE session,
 * la fenêtre de validation s'afficherait dans une conversation invisible (trou
 * de sécurité). On prouve ici que `buildHeavyActionTools` (utilisé par le vrai
 * worker) FORCE l'ID de la CONVERSATION propriétaire, et que l'ANCIEN
 * comportement (contexte seul) enverrait bien l'ID éphémère — ce que le test
 * NEUTRALISE en inversant l'assertion.
 */

import { describe, expect, it } from "vitest";

import type {
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionServicePort,
  ScreenshotOutcome,
  ScreenshotRequest,
  ScreenshotServicePort,
} from "../../src/agents/execution.js";
import {
  createExecutionTools,
  createScreenshotTool,
} from "../../src/pi/sdk/execution-tools.js";
import { buildHeavyActionTools } from "../../src/pi/sdk/heavy-worker.js";

/** Session ÉPHÉMÈRE du worker : un ID DIFFÉRENT de la conversation. */
const EPHEMERAL = "ephemeral-session-xyz";
const CONVERSATION = "conv-utilisateur-42";

/** Contexte d'outil du SDK : renvoie l'ID de la session ÉPHÉMÈRE. */
const ephemeralCtx = {
  sessionManager: { getSessionId: () => EPHEMERAL },
} as never;

function stubExecution(): {
  service: ExecutionServicePort;
  calls: ExecutionRequest[];
} {
  const calls: ExecutionRequest[] = [];
  const service: ExecutionServicePort = {
    execute: async (request: ExecutionRequest): Promise<ExecutionOutcome> => {
      calls.push(request);
      return {
        status: "completed",
        agentId: request.agentId,
        command: request.command,
        destructive: false,
        destructiveIds: [],
        exitCode: 0,
        framed: "<sortie>ok</sortie>",
        message: "ok",
      };
    },
  };
  return { service, calls };
}

function stubScreenshot(): {
  service: ScreenshotServicePort;
  calls: ScreenshotRequest[];
} {
  const calls: ScreenshotRequest[] = [];
  const service: ScreenshotServicePort = {
    capture: async (request: ScreenshotRequest): Promise<ScreenshotOutcome> => {
      calls.push(request);
      return { status: "captured", agentId: request.agentId, message: "ok" };
    },
  };
  return { service, calls };
}

type AnyTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

async function invoke(tool: AnyTool, params: Record<string, unknown>, ctx: unknown): Promise<void> {
  await tool.execute("call", params, undefined, undefined, ctx);
}

describe("outils d'action du worker lourd — rattachement de la validation", () => {
  it("buildHeavyActionTools expose run_command ET capturer_ecran quand les services sont fournis", () => {
    const { service: execution } = stubExecution();
    const { service: screenshots } = stubScreenshot();
    const tools = buildHeavyActionTools({ execution, screenshots }, CONVERSATION);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["capturer_ecran", "run_command"]);
  });

  it("buildHeavyActionTools n'expose RIEN sans service (worker sans exécution)", () => {
    expect(buildHeavyActionTools({}, CONVERSATION)).toEqual([]);
  });

  it("run_command RATTACHE la validation à la CONVERSATION, pas à la session éphémère", async () => {
    const { service, calls } = stubExecution();
    // Chemin RÉEL du worker : sessionId forcé à la conversation propriétaire.
    const tools = buildHeavyActionTools({ execution: service }, CONVERSATION);
    const runCommand = tools.find((tool) => tool.name === "run_command") as unknown as AnyTool;
    await invoke(runCommand, { agent_id: "nuc00", command: "echo hi" }, ephemeralCtx);
    expect(calls).toHaveLength(1);
    // ⚠️ L'ANCIEN comportement aurait mis l'ID éphémère ici : la fenêtre serait
    // apparue dans une conversation invisible. On exige la CONVERSATION.
    expect(calls[0]?.sessionId).toBe(CONVERSATION);
    expect(calls[0]?.sessionId).not.toBe(EPHEMERAL);
  });

  it("capturer_ecran RATTACHE aussi la validation à la CONVERSATION", async () => {
    const { service, calls } = stubScreenshot();
    const tools = buildHeavyActionTools({ screenshots: service }, CONVERSATION);
    const capture = tools.find((tool) => tool.name === "capturer_ecran") as unknown as AnyTool;
    await invoke(capture, { agent_id: "nuc00" }, ephemeralCtx);
    expect(calls[0]?.sessionId).toBe(CONVERSATION);
  });

  it("DÉTECTION DE L'ANCIEN COMPORTEMENT : sans ID forcé, l'outil prend l'ID du contexte (éphémère)", async () => {
    const { service, calls } = stubExecution();
    // C'est EXACTEMENT ce que faisait l'ancien câblage (contexte seul) : le
    // test prouve que le nouveau chemin DIFFÈRE (sinon la garantie serait vide).
    const tools = createExecutionTools(service);
    const runCommand = tools[0] as unknown as AnyTool;
    await invoke(runCommand, { agent_id: "nuc00", command: "echo hi" }, ephemeralCtx);
    expect(calls[0]?.sessionId).toBe(EPHEMERAL);
    expect(calls[0]?.sessionId).not.toBe(CONVERSATION);

    // Même preuve pour la capture : sans override, c'est l'ID du contexte.
    const shots = stubScreenshot();
    const shotTools = createScreenshotTool(shots.service);
    await invoke(shotTools[0] as unknown as AnyTool, { agent_id: "nuc00" }, ephemeralCtx);
    expect(shots.calls[0]?.sessionId).toBe(EPHEMERAL);
  });
});
