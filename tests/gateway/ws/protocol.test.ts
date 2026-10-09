import { describe, expect, it } from "vitest";

import { parseClientMessage } from "../../../src/gateway/ws/protocol.js";
import { toServerMessage } from "../../../src/gateway/ws/server.js";
import type { PiEvent } from "../../../src/pi/types.js";

describe("protocol — client → serveur", () => {
  it("accepte hello avec et sans champs optionnels", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello" }))).toEqual({
      ok: true,
      message: { type: "hello" },
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "hello", clientVersion: "1", sessionId: "s1" }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "hello", clientVersion: "1", sessionId: "s1" },
    });
  });

  it("accepte resume valide et rejette un fromSeq invalide", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "resume", sessionId: "s1", fromSeq: 3 })),
    ).toEqual({
      ok: true,
      message: { type: "resume", sessionId: "s1", fromSeq: 3 },
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "resume", sessionId: "s1", fromSeq: -1 })),
    ).toEqual({ ok: false, error: "resume_invalid_from_seq" });
    expect(
      parseClientMessage(JSON.stringify({ type: "resume", fromSeq: 1 })),
    ).toEqual({ ok: false, error: "resume_missing_session_id" });
  });

  it("accepte message non vide et rejette un texte vide", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "message", clientMsgId: "m1", text: "salut" })),
    ).toEqual({
      ok: true,
      message: { type: "message", clientMsgId: "m1", text: "salut" },
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "message", clientMsgId: "m1", text: "   " })),
    ).toEqual({ ok: false, error: "message_empty_text" });
    expect(
      parseClientMessage(JSON.stringify({ type: "message", text: "salut" })),
    ).toEqual({ ok: false, error: "message_missing_client_msg_id" });
  });

  it("accepte un fuseau (tz) optionnel sur un message, sinon l'omet", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "message", clientMsgId: "m1", text: "salut", tz: "Europe/Paris" }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "message", clientMsgId: "m1", text: "salut", tz: "Europe/Paris" },
    });
    // Absent ou vide ⇒ champ omis (le serveur utilisera le fuseau du process).
    expect(
      parseClientMessage(JSON.stringify({ type: "message", clientMsgId: "m2", text: "salut", tz: "  " })),
    ).toEqual({ ok: true, message: { type: "message", clientMsgId: "m2", text: "salut" } });
  });

  it("accepte abort et ping", () => {
    expect(parseClientMessage(JSON.stringify({ type: "abort" }))).toEqual({
      ok: true,
      message: { type: "abort" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "abort", runId: "r1" }))).toEqual({
      ok: true,
      message: { type: "abort", runId: "r1" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "ping", t: 42 }))).toEqual({
      ok: true,
      message: { type: "ping", t: 42 },
    });
    expect(parseClientMessage(JSON.stringify({ type: "ping", t: "42" }))).toEqual({
      ok: false,
      error: "ping_invalid_t",
    });
  });

  it("accepte une trame playback valide et rejette les formes invalides", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "playback", runId: "r1", event: "started" })),
    ).toEqual({ ok: true, message: { type: "playback", runId: "r1", event: "started" } });
    expect(
      parseClientMessage(JSON.stringify({ type: "playback", runId: "r1", event: "aborted" })),
    ).toEqual({ ok: true, message: { type: "playback", runId: "r1", event: "aborted" } });
    expect(parseClientMessage(JSON.stringify({ type: "playback", event: "started" }))).toEqual({
      ok: false,
      error: "playback_missing_run_id",
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "playback", runId: "r1", event: "nope" })),
    ).toEqual({ ok: false, error: "playback_invalid_event" });
  });

  it("rejette le JSON invalide et les types inconnus", () => {
    expect(parseClientMessage("{oops")).toEqual({ ok: false, error: "invalid_json" });
    expect(parseClientMessage("[]")).toEqual({ ok: false, error: "not_an_object" });
    expect(parseClientMessage(JSON.stringify({ type: "nope" }))).toEqual({
      ok: false,
      error: "unknown_type",
    });
  });

  it("accepte une décision de validation (approve/deny) et rejette les formes invalides", () => {
    expect(
      parseClientMessage(
        JSON.stringify({ type: "approval_decision", id: "ap-1", decision: "approve" }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "approval_decision", id: "ap-1", decision: "approve" },
    });
    expect(
      parseClientMessage(
        JSON.stringify({ type: "approval_decision", id: "ap-1", decision: "deny" }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "approval_decision", id: "ap-1", decision: "deny" },
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "approval_decision", decision: "approve" })),
    ).toEqual({ ok: false, error: "approval_decision_missing_id" });
    expect(
      parseClientMessage(JSON.stringify({ type: "approval_decision", id: "ap-1", decision: "peut-etre" })),
    ).toEqual({ ok: false, error: "approval_decision_invalid" });
  });
});

describe("protocol — mapping événement → trame serveur", () => {
  it("mappe delta avec le canal structurant", () => {
    const event: PiEvent = {
      type: "delta",
      sessionId: "s1",
      runId: "r1",
      channel: "thinking",
      text: "…",
    };
    expect(toServerMessage(event)).toEqual({
      type: "delta",
      runId: "r1",
      channel: "thinking",
      text: "…",
    });
  });

  it("mappe run_finished avec raison et usage", () => {
    const event: PiEvent = {
      type: "run_finished",
      sessionId: "s1",
      runId: "r1",
      reason: "abort",
    };
    expect(toServerMessage(event)).toEqual({
      type: "run_finished",
      runId: "r1",
      reason: "abort",
    });
  });

  it("mappe phase et run_summary", () => {
    expect(
      toServerMessage({
        type: "phase",
        sessionId: "s1",
        runId: "r1",
        stage: "first_token",
        at: "2026-01-01T00:00:00.000Z",
        sinceT0Ms: 12,
      }),
    ).toEqual({
      type: "phase",
      runId: "r1",
      stage: "first_token",
      at: "2026-01-01T00:00:00.000Z",
      sinceT0Ms: 12,
    });
    expect(
      toServerMessage({
        type: "run_summary",
        sessionId: "s1",
        runId: "r1",
        ttftMs: 12,
        totalMs: 40,
      }),
    ).toEqual({ type: "run_summary", runId: "r1", ttftMs: 12, totalMs: 40 });
    expect(
      toServerMessage({
        type: "run_summary",
        sessionId: "s1",
        runId: "r1",
        ttftMs: 12,
        totalMs: 40,
        ttfaMs: 5,
        ttsSynthMs: 20,
        ttsSegments: 3,
      }),
    ).toEqual({
      type: "run_summary",
      runId: "r1",
      ttftMs: 12,
      totalMs: 40,
      ttfaMs: 5,
      ttsSynthMs: 20,
      ttsSegments: 3,
    });
  });
});

describe("agent_level — réglage du niveau depuis le menu contextuel", () => {
  it("accepte les 4 niveaux D118", () => {
    for (const level of ["disabled", "always", "destructive", "never"]) {
      expect(
        parseClientMessage(JSON.stringify({ type: "agent_level", agentId: "a1", level })),
      ).toEqual({ ok: true, message: { type: "agent_level", agentId: "a1", level } });
    }
  });

  it("refuse un niveau inconnu, un agentId vide ou absent", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "agent_level", agentId: "a1", level: "oui" })),
    ).toEqual({ ok: false, error: "agent_level_invalid_level" });
    expect(
      parseClientMessage(JSON.stringify({ type: "agent_level", agentId: "", level: "never" })),
    ).toEqual({ ok: false, error: "agent_level_missing_agent_id" });
    expect(
      parseClientMessage(JSON.stringify({ type: "agent_level", level: "never" })),
    ).toEqual({ ok: false, error: "agent_level_missing_agent_id" });
  });
});
