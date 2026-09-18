import { describe, expect, it } from "vitest";

import {
  SessionStream,
  SessionStreamStore,
} from "../../../src/gateway/ws/session-stream.js";

function stream(bufferSize = 1000, bufferBytes = 1_000_000): SessionStream {
  return new SessionStream({
    sessionId: "s1",
    bufferSize,
    bufferBytes,
    now: () => 1_700_000_000_000,
    snapshotSource: () => ({
      state: "idle",
      transcript: [{ role: "user", text: "bonjour" }],
    }),
  });
}

describe("SessionStream — séquence", () => {
  it("attribue un seq monotone par session à partir de 1", () => {
    const s = stream();
    expect(s.seq).toBe(0);
    const a = s.append({ type: "state", state: "idle" });
    const b = s.append({ type: "state", state: "streaming", activeRunId: "r1" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(s.seq).toBe(2);
    expect(a.sessionId).toBe("s1");
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("envelope() ne consomme pas de seq", () => {
    const s = stream();
    s.append({ type: "state", state: "idle" });
    expect(s.envelope().seq).toBe(1);
    expect(s.envelope().seq).toBe(1);
    expect(s.seq).toBe(1);
  });

  it("diffuse à chaque abonné et respecte le désabonnement", () => {
    const s = stream();
    const seen: number[] = [];
    const off = s.subscribe((frame) => seen.push(frame.seq));
    s.append({ type: "state", state: "idle" });
    s.append({ type: "state", state: "idle" });
    off();
    s.append({ type: "state", state: "idle" });
    expect(seen).toEqual([1, 2]);
  });
});

describe("SessionStream — rejeu", () => {
  it("rejoue strictement seq > fromSeq", () => {
    const s = stream();
    s.append({ type: "state", state: "idle" }); // 1
    s.append({ type: "state", state: "streaming" }); // 2
    s.append({ type: "state", state: "idle" }); // 3

    const all = s.replay(0);
    expect(all.mode).toBe("replay");
    expect(all.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);

    const partial = s.replay(1);
    expect(partial.mode).toBe("replay");
    expect(partial.frames.map((frame) => frame.seq)).toEqual([2, 3]);

    const none = s.replay(3);
    expect(none.mode).toBe("replay");
    expect(none.frames).toEqual([]);
  });

  it("renvoie un snapshot quand la fenêtre du buffer est dépassée", () => {
    const s = stream(3, 1_000_000);
    for (let i = 0; i < 5; i += 1) {
      s.append({ type: "state", state: "idle" });
    }
    expect(s.size).toBe(3);
    expect(s.seq).toBe(5);

    const result = s.replay(0);
    expect(result.mode).toBe("snapshot");
    if (result.mode !== "snapshot") return;
    expect(result.snapshot.seq).toBe(5);
    expect(result.snapshot.state).toBe("idle");
    expect(result.snapshot.transcript).toEqual([{ role: "user", text: "bonjour" }]);

    // Depuis 3 (juste avant la première trame conservée = 3), le rejeu reste contigu.
    const contiguous = s.replay(3);
    expect(contiguous.mode).toBe("replay");
    expect(contiguous.frames.map((frame) => frame.seq)).toEqual([4, 5]);
  });

  it("renvoie un snapshot dès que la borne en octets est franchie", () => {
    const s = stream(1000, 120);
    for (let i = 0; i < 10; i += 1) {
      s.append({ type: "delta", runId: "r", channel: "content", text: "x".repeat(20) });
    }
    expect(s.byteSize).toBeLessThanOrEqual(120);
    expect(s.size).toBeLessThan(10);
    expect(s.replay(0).mode).toBe("snapshot");
  });

  it("snapshot par défaut sans source", () => {
    const s = new SessionStream({ sessionId: "s", bufferSize: 10, bufferBytes: 1000 });
    expect(s.snapshot()).toEqual({ seq: 0, state: "idle", transcript: [] });
  });
});

describe("SessionStreamStore", () => {
  it("crée un flux par session et expose la capacité", () => {
    const store = new SessionStreamStore({
      bufferSize: 7,
      bufferBytes: 500,
      snapshotSource: () => undefined,
    });
    const a = store.get("a");
    const b = store.get("b");
    expect(a).not.toBe(b);
    expect(store.get("a")).toBe(a);
    expect(store.count).toBe(2);
    expect(store.bufferSize).toBe(7);
    expect(store.bufferBytes).toBe(500);
  });
});
