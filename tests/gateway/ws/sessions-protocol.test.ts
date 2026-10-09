import { describe, expect, it } from "vitest";

import { parseClientMessage } from "../../../src/gateway/ws/protocol.js";

describe("protocol — trames de gestion des conversations", () => {
  it("accepte switch avec sessionId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "switch", sessionId: "s1" }))).toEqual({
      ok: true,
      message: { type: "switch", sessionId: "s1" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "switch" }))).toEqual({
      ok: false,
      error: "switch_missing_session_id",
    });
  });

  it("accepte new (sans champ)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "new" }))).toEqual({
      ok: true,
      message: { type: "new" },
    });
  });

  it("accepte rename avec un titre — y compris VIDE (efface le nom)", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "rename", sessionId: "s1", title: "Titre" })),
    ).toEqual({ ok: true, message: { type: "rename", sessionId: "s1", title: "Titre" } });
    expect(
      parseClientMessage(JSON.stringify({ type: "rename", sessionId: "s1", title: "" })),
    ).toEqual({ ok: true, message: { type: "rename", sessionId: "s1", title: "" } });
    expect(parseClientMessage(JSON.stringify({ type: "rename", title: "x" }))).toEqual({
      ok: false,
      error: "rename_missing_session_id",
    });
    expect(parseClientMessage(JSON.stringify({ type: "rename", sessionId: "s1" }))).toEqual({
      ok: false,
      error: "rename_invalid_title",
    });
  });

  it("accepte setAside avec sessionId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "setAside", sessionId: "s1" }))).toEqual({
      ok: true,
      message: { type: "setAside", sessionId: "s1" },
    });
    expect(parseClientMessage(JSON.stringify({ type: "setAside" }))).toEqual({
      ok: false,
      error: "set_aside_missing_session_id",
    });
  });

  it("accepte pin avec sessionId + booléen épinglé", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "pin", sessionId: "s1", pinned: true })),
    ).toEqual({ ok: true, message: { type: "pin", sessionId: "s1", pinned: true } });
    expect(
      parseClientMessage(JSON.stringify({ type: "pin", sessionId: "s1", pinned: false })),
    ).toEqual({ ok: true, message: { type: "pin", sessionId: "s1", pinned: false } });
    expect(parseClientMessage(JSON.stringify({ type: "pin", pinned: true }))).toEqual({
      ok: false,
      error: "pin_missing_session_id",
    });
    expect(parseClientMessage(JSON.stringify({ type: "pin", sessionId: "s1" }))).toEqual({
      ok: false,
      error: "pin_invalid_pinned",
    });
  });
});
