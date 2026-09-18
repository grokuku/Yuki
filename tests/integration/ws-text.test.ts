import { afterEach, describe, expect, it } from "vitest";

import { loadScript } from "../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const SIMPLE = loadScript("tests/fixtures/pi/simple-text.json");
const THINKING = loadScript("tests/fixtures/pi/with-thinking.json");

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  await harness?.close();
  harness = undefined;
});

async function connect(h: Harness): Promise<TestClient> {
  const c = await TestClient.connect(h.url);
  clients.push(c);
  c.send({ type: "hello" });
  await c.waitFor((frame) => frame.type === "welcome");
  await c.waitFor((frame) => frame.type === "snapshot");
  return c;
}

describe("intégration WS — tour de conversation texte", () => {
  it("streame la réponse token par token et clôt le tour", async () => {
    harness = await startHarness({ scripts: [SIMPLE] });
    const client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "Bonjour" });
    const accepted = await client.waitFor((frame) => frame.type === "accepted");
    expect(accepted.type === "accepted" && accepted.queued).toBe(false);

    const started = await client.waitFor("run_started");
    const runId = started.runId;

    await client.waitFor((frame) => frame.type === "run_finished" && frame.runId === runId);
    const deltas = client.frames.filter(
      (frame) => frame.type === "delta" && frame.runId === runId,
    );
    // Critère 1 : plusieurs trames delta `content`.
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    const text = deltas
      .map((frame) => (frame.type === "delta" ? frame.text : ""))
      .join("");
    expect(text).toBe("Bonjour depuis Yuki.");

    const finished = client.frames.find(
      (frame) => frame.type === "run_finished" && frame.runId === runId,
    );
    expect(finished?.type === "run_finished" && finished.reason).toBe("done");

    // Critère 4 : TTFT et durée totale journalisés / diffusés.
    const summary = await client.waitFor(
      (frame) => frame.type === "run_summary" && frame.runId === runId,
    );
    expect(summary.type === "run_summary" && typeof summary.ttftMs).toBe("number");
    expect(summary.type === "run_summary" && summary.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("la réflexion transite mais n'apparaît jamais comme réponse ni dans le transcript", async () => {
    harness = await startHarness({ scripts: [THINKING] });
    const client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "raisonne" });
    const started = await client.waitFor("run_started");
    const runId = started.runId;
    await client.waitFor((frame) => frame.type === "run_finished" && frame.runId === runId);

    const thinking = client.frames.filter(
      (frame) => frame.type === "delta" && frame.channel === "thinking",
    );
    expect(thinking.length).toBeGreaterThan(0);

    const content = client.frames
      .filter((frame) => frame.type === "delta" && frame.channel === "content")
      .map((frame) => (frame.type === "delta" ? frame.text : ""))
      .join("");
    expect(content).toBe("Voici la réponse.");
    expect(content).not.toContain("je réfléchis");

    // Transcript = contenu seul (via un nouveau client : snapshot).
    const observer = await connect(harness);
    const snapshot = observer.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") return;
    const assistantText = snapshot.transcript
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.text)
      .join("");
    expect(assistantText).toBe("Voici la réponse.");
    expect(assistantText).not.toContain("je réfléchis");
  });

  it("rejoue les événements manqués sans trou ni doublon après reconnexion", async () => {
    harness = await startHarness({ scripts: [SIMPLE, SIMPLE] });
    const first = await connect(harness);

    first.send({ type: "message", clientMsgId: "m1", text: "un" });
    await first.waitFor(
      (frame) => frame.type === "run_finished" && frame.reason === "done",
    );
    const lastSeq = first.frames.reduce(
      (max, frame) => Math.max(max, frame.seq),
      0,
    );
    const sessionId = first.frames[0]?.sessionId;
    expect(sessionId).toBeTruthy();
    await first.close();

    // Un autre client produit des événements PENDANT la déconnexion.
    const other = await connect(harness);
    other.send({ type: "message", clientMsgId: "m2", text: "deux" });
    await other.waitFor(
      (frame) => frame.type === "run_finished" && frame.reason === "done",
    );
    const currentSeq = other.frames.reduce((max, frame) => Math.max(max, frame.seq), 0);
    expect(currentSeq).toBeGreaterThan(lastSeq);

    // Reconnexion : on redemande le rejeu depuis le dernier seq appliqué.
    const resumed = await TestClient.connect(harness.url);
    clients.push(resumed);
    const before = resumed.frames.length;
    resumed.send({ type: "resume", sessionId, fromSeq: lastSeq });
    await resumed.waitFor(
      (frame) => frame.type === "run_summary",
      // Le dernier événement du second run est son run_summary.
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const replayed = resumed.frames
      .slice(before)
      .filter((frame) => frame.type !== "welcome");
    const seqs = replayed.map((frame) => frame.seq);
    expect(seqs.length).toBeGreaterThan(0);
    // Contigus, strictement croissants, sans trou ni doublon.
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }
    expect(seqs[0]).toBe(lastSeq + 1);
    expect(seqs[seqs.length - 1]).toBe(currentSeq);
  });

  it("renvoie un snapshot quand la fenêtre de rejeu est dépassée", async () => {
    harness = await startHarness({
      scripts: [SIMPLE, SIMPLE, SIMPLE],
      replayBufferSize: 4,
    });
    const client = await connect(harness);
    const sessionId = client.frames[0]?.sessionId ?? "";

    for (const id of ["m1", "m2", "m3"]) {
      client.send({ type: "message", clientMsgId: id, text: id });
      await client.waitFor(
        (frame) => frame.type === "run_finished" && frame.reason === "done",
      );
    }

    const resumed = await TestClient.connect(harness.url);
    clients.push(resumed);
    resumed.send({ type: "resume", sessionId, fromSeq: 0 });
    const snapshot = await resumed.waitFor((frame) => frame.type === "snapshot");
    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type !== "snapshot") return;
    expect(snapshot.seq).toBeGreaterThan(0);
    // Le snapshot contient les réponses en contenu seul.
    expect(snapshot.transcript.length).toBeGreaterThan(0);
  });
});
