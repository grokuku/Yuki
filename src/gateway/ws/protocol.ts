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
  | { type: "message"; clientMsgId: string; text: string; tz?: string }
  | { type: "abort"; runId?: string }
  | { type: "playback"; runId: string; event: "started" | "aborted" }
  | { type: "switch"; sessionId: string }
  | { type: "new" }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "setAside"; sessionId: string }
  | { type: "ping"; t: number };

/** Session exposée au client (liste des conversations de la barre latérale). */
export interface WireSession {
  id: string;
  /** Titre PRÊT À L'EMPLOI (jamais vide : repli géré côté serveur). */
  title: string;
  /** Date de dernière activité (ISO), si connue. */
  updatedAt?: string;
  messageCount: number;
  /** Extrait (premiers mots du premier message), si connu. */
  excerpt?: string;
}

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
  | {
      /** Liste des conversations + conversation active (null = aucune). */
      type: "sessions";
      sessions: WireSession[];
      activeId: string | null;
    }
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
      // Fuseau IANA du navigateur (facultatif) : permet d'horodater le message
      // dans l'heure LOCALE de l'utilisateur, même si le conteneur est en UTC.
      const tz = optionalString(parsed, "tz");
      return {
        ok: true,
        message: {
          type: "message",
          clientMsgId,
          text,
          ...(tz !== undefined && tz.trim().length > 0 ? { tz } : {}),
        },
      };
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
    case "switch": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "switch_missing_session_id" };
      }
      return { ok: true, message: { type: "switch", sessionId } };
    }
    case "new": {
      return { ok: true, message: { type: "new" } };
    }
    case "rename": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "rename_missing_session_id" };
      }
      // Le titre peut être VIDE (effacer le nom natif → repli automatique).
      const title = parsed.title;
      if (typeof title !== "string") {
        return { ok: false, error: "rename_invalid_title" };
      }
      return { ok: true, message: { type: "rename", sessionId, title } };
    }
    case "setAside": {
      const sessionId = optionalString(parsed, "sessionId");
      if (sessionId === undefined) {
        return { ok: false, error: "set_aside_missing_session_id" };
      }
      return { ok: true, message: { type: "setAside", sessionId } };
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
