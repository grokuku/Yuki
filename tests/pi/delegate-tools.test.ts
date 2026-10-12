/**
 * Outils de délégation — présence de `steer_job` et branchement sur le port.
 *
 * ⚠️ `steer_job` est la SEULE voie par laquelle Yuki (orchestrateur) peut
 * transmettre une consigne à un sous-agent DÉJÀ lancé. On prouve qu'il est
 * exposé avec les trois autres outils et qu'il délègue bien à `steerJob`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { DelegateServicePort, SteerOutcome } from "../../src/delegation/ports.js";
import {
  createDelegateTools,
  createRunContextTracker,
} from "../../src/pi/sdk/delegate-tools.js";

function contextFor(sessionId: string): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function serviceWith(steerJob: DelegateServicePort["steerJob"]): DelegateServicePort {
  return {
    delegate: vi.fn(),
    jobStatus: () => undefined,
    cancelJob: vi.fn(),
    hasPendingWork: () => false,
    steerJob,
  } as unknown as DelegateServicePort;
}

describe("outils de délégation — steer_job", () => {
  it("expose delegate, job_status, cancel_job et steer_job", () => {
    const tools = createDelegateTools({
      service: serviceWith(vi.fn()),
      tracker: createRunContextTracker(),
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "delegate",
      "job_status",
      "cancel_job",
      "steer_job",
    ]);
  });

  it("steer_job transmet (job_id, text) au service et renvoie son issue", async () => {
    const outcome: SteerOutcome = {
      status: "steered",
      job_id: "job-1",
      delivery: "buffered",
      pending: 2,
      note: "tamponnée",
    };
    const steerJob = vi.fn(async () => outcome);
    const tools = createDelegateTools({
      service: serviceWith(steerJob),
      tracker: createRunContextTracker(),
    });
    const steerTool = tools.find((tool) => tool.name === "steer_job");
    expect(steerTool).toBeDefined();
    const result = await steerTool!.execute(
      "call-1",
      { job_id: "job-1", text: "consigne" },
      undefined,
      undefined,
      contextFor("sess-1"),
    );
    expect(steerJob).toHaveBeenCalledWith("job-1", "consigne");
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: "steered",
      delivery: "buffered",
    });
  });

  it("steer_job relaie un job inconnu tel quel (jamais de succès silencieux)", async () => {
    const outcome: SteerOutcome = {
      status: "not_found",
      job_id: "inconnu",
      note: "Aucun job ne porte cet identifiant.",
    };
    const tools = createDelegateTools({
      service: serviceWith(vi.fn(async () => outcome)),
      tracker: createRunContextTracker(),
    });
    const steerTool = tools.find((tool) => tool.name === "steer_job")!;
    const result = await steerTool.execute(
      "call-2",
      { job_id: "inconnu", text: "x" },
      undefined,
      undefined,
      contextFor("sess-1"),
    );
    expect(JSON.parse((result.content[0] as { text: string }).text).status).toBe(
      "not_found",
    );
  });
});
