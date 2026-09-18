import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadScript } from "../../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const ABORT_SLOW = loadScript("tests/fixtures/pi/abort-slow.json");

const pacedScript = {
  steps: [
    { kind: "delta" as const, channel: "content" as const, text: "a", delayMs: 40 },
    { kind: "delta" as const, channel: "content" as const, text: "b", delayMs: 40 },
  ],
};

let harness: Harness | undefined;
let client: TestClient | undefined;

afterEach(async () => {
  await client?.close();
  await harness?.close();
  client = undefined;
  harness = undefined;
});

async function connect(h: Harness): Promise<TestClient> {
  const c = await TestClient.connect(h.url);
  c.send({ type: "hello" });
  await c.waitFor((frame) => frame.type === "welcome");
  await c.waitFor((frame) => frame.type === "snapshot");
  return c;
}

describe("abort et concurrence", () => {
  it("le Stop aborte le run en vol, vide la file, et n'émet plus de delta", async () => {
    harness = await startHarness({ scripts: [ABORT_SLOW] });
    client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    const started = await client.waitFor("run_started");
    const runId = started.runId;
    await client.waitFor((frame) => frame.type === "delta");

    // Deuxième message reçu pendant le run : mis en file.
    client.send({ type: "message", clientMsgId: "m2", text: "encore" });
    const queued = await client.waitFor(
      (frame) => frame.type === "accepted" && frame.clientMsgId === "m2",
    );
    expect(queued.type === "accepted" && queued.queued).toBe(true);

    client.send({ type: "abort" });
    const aborted = await client.waitFor(
      (frame) => frame.type === "run_finished" && frame.runId === runId,
    );
    expect(aborted.type === "run_finished" && aborted.reason).toBe("abort");

    const abortedQueued = await client.waitFor(
      (frame) =>
        frame.type === "run_finished" &&
        frame.reason === "abort" &&
        frame.runId !== runId,
    );
    expect(abortedQueued.type).toBe("run_finished");

    await client.waitFor((frame) => frame.type === "state" && frame.state === "idle");

    const seqAtAbort = aborted.seq;
    await delay(80);
    const lateDeltas = client.framesAfter(seqAtAbort).filter((f) => f.type === "delta");
    expect(lateDeltas).toEqual([]);
  });

  it("un message en file devient le run suivant", async () => {
    harness = await startHarness({ scripts: [pacedScript, pacedScript] });
    client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "premier" });
    const first = await client.waitFor("run_started");
    client.send({ type: "message", clientMsgId: "m2", text: "second" });
    await client.waitFor(
      (frame) => frame.type === "accepted" && frame.clientMsgId === "m2" && frame.queued,
    );

    await client.waitFor(
      (frame) => frame.type === "run_finished" && frame.runId === first.runId,
    );
    const second = await client.waitFor(
      (frame) => frame.type === "run_started" && frame.runId !== first.runId,
    );
    if (second.type !== "run_started") throw new Error("run_started attendu");
    await client.waitFor(
      (frame) =>
        frame.type === "run_finished" &&
        frame.runId === second.runId &&
        frame.reason === "done",
    );
  });

  it("abort en idle est un no-op idempotent", async () => {
    harness = await startHarness({ scripts: [] });
    client = await connect(harness);
    const before = client.frames.length;
    client.send({ type: "abort" });
    client.send({ type: "abort" });
    await delay(50);
    const terminal = client.frames
      .slice(before)
      .filter((frame) => frame.type === "run_finished");
    expect(terminal).toEqual([]);
  });
});
