/**
 * Contrat de transport WebSocket : types des messages client ↔ serveur.
 *
 * Aucun type du SDK ici : uniquement du JSON sérialisable. Chaque trame
 * serveur → client porte l'enveloppe `{ seq, ts, sessionId }`.
 */

import type {
  DeltaChannel,
  PiJobTerminalStatus,
  PiSessionStateName,
  PiUsage,
  RunFinishReason,
  TranscriptEntry,
} from "../../pi/types.js";

/** Trame client → serveur. */
export type ClientMessage =
  | { type: "hello"; clientVersion?: string; sessionId?: string }
  | { type: "resume"; sessionId: string; fromSeq: number }
  | { type: "message"; clientMsgId: string; text: string }
  | { type: "abort"; runId?: string }
  | { type: "playback"; runId: string; event: "started" | "aborted" }
  | { type: "ping"; t: number };

/** Corps d'une trame serveur → client. */
export type ServerMessage =
  | { type: "welcome"; serverVersion: string; resumed: boolean; replayFrom?: number }
  | { type: "accepted"; clientMsgId: string; runId: string; queued: boolean }
  | { type: "state"; state: PiSessionStateName; activeRunId?: string }
  | { type: "run_started"; runId: string; userText?: string; origin?: string; jobId?: string }
  | { type: "delta"; runId: string; channel: DeltaChannel; text: string }
  | {
      type: "run_finished";
      runId: string;
      reason: RunFinishReason;
      usage?: PiUsage;
      errorMessage?: string;
    }
  | {
      type: "phase";
      runId: string;
      stage: string;
      at: string;
      sinceT0Ms: number;
      jobId?: string;
    }
  | {
      type: "job_started";
      jobId: string;
      task?: string;
    }
  | {
      type: "job_finished";
      jobId: string;
      status: PiJobTerminalStatus;
    }
  | {
      type: "job_report";
      jobId: string;
      runId?: string;
    }
  | {
      type: "run_summary";
      runId: string;
      ttftMs?: number;
      totalMs: number;
      tokensIn?: number;
      tokensOut?: number;
      /** Lot 7 : t0 → premier octet PCM du 1er segment. */
      ttfaMs?: number;
      /** Lot 7 : cumul synthèse TTS du run. */
      ttsSynthMs?: number;
      /** Lot 7 : nombre de segments TTS synthétisés. */
      ttsSegments?: number;
    }
  | {
      type: "snapshot";
      state: PiSessionStateName;
      activeRunId?: string;
      transcript: TranscriptEntry[];
    }
  | { type: "error"; code: string; message: string; runId?: string }
  | { type: "pong"; t: number }
  | { type: "bye"; reason: string };

/** Enveloppe commune à toute trame serveur → client. */
export interface ServerEnvelope {
  /** Entier monotone PAR SESSION, démarrant à 1. */
  seq: number;
  ts: string;
  sessionId: string;
}

export type ServerFrame = ServerEnvelope & ServerMessage;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Analyse et valide une trame client. Tolérant sur les champs optionnels,
 * strict sur les champs requis. Ne lève jamais.
 */
export function parseClientMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "not_an_object" };
  }
  const type = parsed.type;
  switch (type) {
    case "hello": {
      const sessionId = optionalString(parsed, "sessionId");
      const clientVersion = optionalString(parsed, "clientVersion");
      return {
        ok: true,
        message: {
          type: "hello",
          ...(clientVersion !== undefined ? { clientVersion } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
      };
    }
    case "resume": {
      const sessionId = optionalString(parsed, "sessionId");
      const fromSeq = parsed.fromSeq;
      if (sessionId === undefined) {
        return { ok: false, error: "resume_missing_session_id" };
      }
      if (typeof fromSeq !== "number" || !Number.isInteger(fromSeq) || fromSeq < 0) {
        return { ok: false, error: "resume_invalid_from_seq" };
      }
      return { ok: true, message: { type: "resume", sessionId, fromSeq } };
    }
    case "message": {
      const clientMsgId = optionalString(parsed, "clientMsgId");
      const text = optionalString(parsed, "text");
      if (clientMsgId === undefined) {
        return { ok: false, error: "message_missing_client_msg_id" };
      }
      if (text === undefined || text.trim().length === 0) {
        return { ok: false, error: "message_empty_text" };
      }
      return { ok: true, message: { type: "message", clientMsgId, text } };
    }
    case "abort": {
      const runId = optionalString(parsed, "runId");
      return {
        ok: true,
        message: { type: "abort", ...(runId !== undefined ? { runId } : {}) },
      };
    }
    case "playback": {
      const runId = optionalString(parsed, "runId");
      const event = parsed.event;
      if (runId === undefined) {
        return { ok: false, error: "playback_missing_run_id" };
      }
      if (event !== "started" && event !== "aborted") {
        return { ok: false, error: "playback_invalid_event" };
      }
      return { ok: true, message: { type: "playback", runId, event } };
    }
    case "ping": {
      const t = parsed.t;
      if (typeof t !== "number" || !Number.isFinite(t)) {
        return { ok: false, error: "ping_invalid_t" };
      }
      return { ok: true, message: { type: "ping", t } };
    }
    default:
      return { ok: false, error: "unknown_type" };
  }
}
