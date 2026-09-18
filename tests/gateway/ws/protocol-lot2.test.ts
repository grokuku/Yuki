/**
 * Mapping des nouveaux `ServerMessage` (Lot 2) — le `default` reste exhaustif.
 */

import { describe, expect, it } from "vitest";

import { toServerMessage } from "../../../src/gateway/ws/server.js";
import type { PiEvent } from "../../../src/pi/types.js";

describe("protocol — mapping serveur (Lot 2)", () => {
  it("mappe run_started avec origin et jobId", () => {
    const event: PiEvent = {
      type: "run_started",
      sessionId: "s1",
      runId: "r1",
      userText: "report",
      origin: "job_report",
      jobId: "job-1",
    };
    expect(toServerMessage(event)).toEqual({
      type: "run_started",
      runId: "r1",
      userText: "report",
      origin: "job_report",
      jobId: "job-1",
    });
  });

  it("mappe phase avec jobId", () => {
    const event: PiEvent = {
      type: "phase",
      sessionId: "s1",
      runId: "r1",
      stage: "job_started",
      at: "2026-01-01T00:00:00.000Z",
      sinceT0Ms: 3,
      jobId: "job-1",
    };
    expect(toServerMessage(event)).toEqual({
      type: "phase",
      runId: "r1",
      stage: "job_started",
      at: "2026-01-01T00:00:00.000Z",
      sinceT0Ms: 3,
      jobId: "job-1",
    });
  });

  it("mappe job_started / job_finished / job_report", () => {
    expect(
      toServerMessage({
        type: "job_started",
        sessionId: "s1",
        jobId: "job-1",
        task: "t",
      }),
    ).toEqual({ type: "job_started", jobId: "job-1", task: "t" });
    expect(
      toServerMessage({
        type: "job_finished",
        sessionId: "s1",
        jobId: "job-1",
        status: "completed",
      }),
    ).toEqual({ type: "job_finished", jobId: "job-1", status: "completed" });
    expect(
      toServerMessage({
        type: "job_report",
        sessionId: "s1",
        jobId: "job-1",
        runId: "r2",
      }),
    ).toEqual({ type: "job_report", jobId: "job-1", runId: "r2" });
  });

  it("le default est exhaustif (type inconnu → erreur, jamais silencieux)", () => {
    expect(() =>
      toServerMessage({ type: "inconnu" } as unknown as PiEvent),
    ).toThrowError(/inconnu/i);
  });
});
