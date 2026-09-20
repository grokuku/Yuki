/**
 * Étages TTS de l'instrumentation (Lot 7 §8) — définition et contrat de
 * `run_summary` enrichi. Aucune émission réelle dans ce lot : on vérifie que le
 * contrat existe et reste rétro-compatible.
 */

import { describe, expect, it } from "vitest";

import {
  PHASE,
  RunInstrumentation,
  type RunSummary,
} from "../../src/pi/instrumentation.js";
import type { PiEvent } from "../../src/pi/types.js";
import { createLogger } from "../../src/observability/logger.js";

describe("étages TTS de la table PHASE", () => {
  it("reprend la nomenclature de la spec", () => {
    expect(PHASE.sentenceSegmented).toBe("sentence_segmented");
    expect(PHASE.ttsQueued).toBe("tts_queued");
    expect(PHASE.ttsRequested).toBe("tts_requested");
    expect(PHASE.ttsFirstByte).toBe("tts_first_byte");
    expect(PHASE.ttsSegmentDone).toBe("tts_segment_done");
    expect(PHASE.ttsRetry).toBe("tts_retry");
    expect(PHASE.ttsCancel).toBe("tts_cancel");
    expect(PHASE.playbackStarted).toBe("playback_started");
    expect(PHASE.playbackAborted).toBe("playback_aborted");
  });
});

describe("run_summary enrichi (rétro-compatible)", () => {
  function instrument(): { instr: RunInstrumentation; events: PiEvent[] } {
    const events: PiEvent[] = [];
    const instr = new RunInstrumentation({
      runId: "run-tts",
      sessionId: "sess-1",
      t0: 1_000,
      emit: (event) => events.push(event),
      logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
      now: () => 1_500,
    });
    return { instr, events };
  }

  it("sans métriques TTS, aucun champ tts_* n'est émis", () => {
    const { instr, events } = instrument();
    const summary: RunSummary = instr.summarize();
    expect(summary.ttfaMs).toBeUndefined();
    expect(summary.ttsSegments).toBeUndefined();
    instr.emitSummary();
    const event = events.find((e) => e.type === "run_summary");
    expect(event).toBeDefined();
    expect(Object.keys(event ?? {})).not.toContain("ttfaMs");
  });

  it("avec métriques TTS, les champs sont présents", () => {
    const { instr, events } = instrument();
    instr.recordTtsMetrics({ ttfaMs: 780, ttsSynthMs: 640, ttsSegments: 4 });
    const summary = instr.emitSummary();
    expect(summary.ttfaMs).toBe(780);
    expect(summary.ttsSynthMs).toBe(640);
    expect(summary.ttsSegments).toBe(4);
    const event = events.find((e) => e.type === "run_summary");
    expect(event).toMatchObject({
      ttfaMs: 780,
      ttsSynthMs: 640,
      ttsSegments: 4,
    });
  });
});
