import { describe, expect, it } from "vitest";

import { PHASE, RunInstrumentation } from "../../src/pi/instrumentation.js";
import type { PiEvent } from "../../src/pi/types.js";
import { createLogger } from "../../src/observability/logger.js";

function collect(): { events: PiEvent[]; lines: string[] } {
  const events: PiEvent[] = [];
  const lines: string[] = [];
  return { events, lines };
}

describe("RunInstrumentation", () => {
  it("émet les étages, le TTFT et la synthèse, avec journalisation corrélée", () => {
    const { events, lines } = collect();
    const logger = createLogger({
      level: "info",
      sink: (line) => lines.push(line),
      secretValues: [],
    });

    let now = 1_000;
    const clock = () => now;
    const instr = new RunInstrumentation({
      runId: "run-1",
      sessionId: "sess-1",
      t0: now,
      emit: (event) => events.push(event),
      logger,
      now: clock,
    });

    instr.markStage(PHASE.sendReceived);
    now = 1_010;
    instr.markStage(PHASE.promptAccepted);
    now = 1_050;
    instr.markFirstToken();
    // Un second appel ne doit pas déplacer le TTFT.
    now = 1_060;
    instr.markFirstToken();
    now = 1_200;
    instr.markStage(PHASE.turnEnd);
    instr.setUsage({ input: 30, output: 7, total: 37 });
    now = 1_250;
    instr.complete("done");
    const summary = instr.emitSummary();

    const phases = events.filter((event) => event.type === "phase");
    expect(phases.map((event) => (event.type === "phase" ? event.stage : ""))).toEqual([
      "send_received",
      "prompt_accepted",
      "first_token",
      "turn_end",
      "run_finished",
    ]);

    for (const phase of phases) {
      if (phase.type !== "phase") continue;
      expect(phase.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(phase.sinceT0Ms).toBeGreaterThanOrEqual(0);
    }

    expect(summary.ttftMs).toBe(50);
    expect(summary.totalMs).toBe(250);
    expect(summary.tokensIn).toBe(30);
    expect(summary.tokensOut).toBe(7);

    const summaryEvent = events.find((event) => event.type === "run_summary");
    expect(summaryEvent).toMatchObject({
      type: "run_summary",
      sessionId: "sess-1",
      runId: "run-1",
      ttftMs: 50,
      totalMs: 250,
      tokensIn: 30,
      tokensOut: 7,
    });

    const phaseLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === "pi.phase");
    expect(phaseLines).toHaveLength(5);
    expect(phaseLines[0]).toMatchObject({
      msg: "pi.phase",
      session_id: "sess-1",
      run_id: "run-1",
      stage: "send_received",
    });

    const summaryLines = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.msg === "pi.run_summary");
    expect(summaryLines).toHaveLength(1);
    expect(summaryLines[0]).toMatchObject({
      msg: "pi.run_summary",
      session_id: "sess-1",
      run_id: "run-1",
      ttft_ms: 50,
      total_ms: 250,
      usage_in: 30,
      usage_out: 7,
    });
  });

  it("marque abort/error avant run_finished", () => {
    const events: PiEvent[] = [];
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
    const instr = new RunInstrumentation({
      runId: "run-2",
      sessionId: "sess-1",
      t0: 0,
      emit: (event) => events.push(event),
      logger,
      now: () => 5,
    });
    instr.complete("abort");
    instr.complete("error"); // ignoré : déjà complété
    const stages = events
      .filter((event) => event.type === "phase")
      .map((event) => (event.type === "phase" ? event.stage : ""));
    expect(stages).toEqual(["abort", "run_finished"]);
  });
});
