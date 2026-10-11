/**
 * Intégration WS — E3 : ACTIVITÉ D'UN SOUS-AGENT.
 *
 * Prouve, sur le transport RÉEL (FakePiHost + WsTransport + synthétiseur
 * ENREGISTREUR), les invariants de la trame `job_activity` :
 *   1. elle est livrée en trame de CONTRÔLE (rattachée à SA conversation) et ne
 *      consomme AUCUN `seq` ;
 *   2. elle N'EST PAS bufferisée ⇒ elle n'apparaît JAMAIS dans le rejeu ni dans
 *      un snapshot (éphémérité) ;
 *   3. elle n'atteint JAMAIS le moteur TTS, même pour la conversation FOCALISÉE,
 *      alors qu'une réponse normale, elle, est bien synthétisée (muet).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { AudioStreamEvent, SegmentSynthesizer } from "../../src/tts/synthesizer.js";
import type { TtsPipelineDeps } from "../../src/tts/pipeline.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await harness?.close();
  harness = undefined;
});

async function connect(h: Harness): Promise<TestClient> {
  const client = await TestClient.connect(h.url);
  clients.push(client);
  client.send({ type: "hello" });
  await client.waitFor((frame) => frame.type === "welcome");
  await client.waitFor((frame) => frame.type === "snapshot");
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeTts(): { deps: TtsPipelineDeps; requested: string[] } {
  const requested: string[] = [];
  const synthesizer: SegmentSynthesizer = async (request) => {
    requested.push(request.text);
    return (async function* (): AsyncGenerator<AudioStreamEvent> {
      yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
      yield { type: "data" as const, bytes: Buffer.from([1, 2, 3, 4]) };
    })();
  };
  const values: Record<string, string | number> = {
    "tts.prefetchDepth": 1,
    "tts.minSentenceChars": 1,
    "tts.maxSentenceChars": 500,
    "tts.engine": "chatterbox",
    "tts.voice": "",
  };
  return {
    requested,
    deps: {
      enabled: true,
      config: {
        getString: (path) => String(values[path] ?? ""),
        getNumber: (path) => Number(values[path] ?? 0),
      },
      synthesizer,
      resolveVoice: () => null,
      logger,
      sleep: async () => undefined,
    },
  };
}

const at = () => new Date().toISOString();

describe("E3 — trame d'activité : contrôle, éphémère, muette", () => {
  it("livrée en trame de CONTRÔLE rattachée à SA session, sans consommer de `seq`", async () => {
    harness = await startHarness({ sessionId: "sess-1" });
    const client = await connect(harness);

    // Une trame RÉELLE consomme le `seq` 1.
    harness.host.emitExternal({ type: "run_started", sessionId: "sess-1", runId: "r1" });
    const started = await client.waitFor("run_started");

    harness.host.emitExternal({
      type: "job_activity",
      sessionId: "sess-1",
      jobId: "job-1",
      stage: "job_progress",
      detail: "ACTIVITE-SECRETE",
      at: at(),
    });
    const activity = await client.waitFor("job_activity");
    // Rattachement PAR CONVERSATION (enveloppe).
    expect(activity.sessionId).toBe("sess-1");
    expect(activity.type).toBe("job_activity");
    if (activity.type === "job_activity") {
      expect(activity.jobId).toBe("job-1");
      expect(activity.stage).toBe("job_progress");
      expect(activity.detail).toBe("ACTIVITE-SECRETE");
    }
    // Aucun `seq` consommé : elle réutilise le `seq` courant.
    expect(activity.seq).toBe(started.seq);

    // La trame RÉELLE suivante prend bien le `seq` SUIVANT (compteur intact).
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-1",
      runId: "r1",
      channel: "content",
      text: "suite",
    });
    const delta = await client.waitFor("delta");
    expect(delta.seq).toBe(started.seq + 1);
  });

  it("NON bufferisée : absente du REJEU et du snapshot (éphémérité)", async () => {
    harness = await startHarness({ sessionId: "sess-1" });
    const client = await connect(harness);

    harness.host.emitExternal({ type: "run_started", sessionId: "sess-1", runId: "r1" });
    await client.waitFor("run_started");
    harness.host.emitExternal({
      type: "job_activity",
      sessionId: "sess-1",
      jobId: "job-1",
      stage: "job_progress",
      detail: "ACTIVITE-SECRETE",
      at: at(),
    });
    await client.waitFor("job_activity");

    // Un SECOND client rejoue STRICTEMENT depuis 0 : la trame d'activité ne doit
    // pas y apparaître (elle n'a jamais été bufferisée).
    const replayClient = await TestClient.connect(harness.url);
    clients.push(replayClient);
    replayClient.send({ type: "resume", sessionId: "sess-1", fromSeq: 0 });
    await replayClient.waitFor((frame) => frame.type === "welcome");
    await replayClient.waitFor((frame) => frame.type === "run_started");
    await sleep(60);
    const replayed = replayClient.frames.filter((frame) => frame.seq > 0);
    expect(replayed.some((frame) => frame.type === "job_activity")).toBe(false);
    // Le rejeu contient bien les trames RÉELLES (la preuve n'est pas vide).
    expect(replayed.some((frame) => frame.type === "run_started")).toBe(true);

    // Le snapshot (état autoritatif) ne porte aucune activité.
    const snapshotClient = await connect(harness);
    const snapshot = snapshotClient.frames.find((frame) => frame.type === "snapshot");
    expect(
      (snapshot?.type === "snapshot" ? snapshot.transcript : [])
        .map((entry) => entry.text)
        .join("\n"),
    ).not.toContain("ACTIVITE-SECRETE");
  });

  it("MUETTE : n'atteint JAMAIS le moteur TTS, même pour la conversation FOCALISÉE", async () => {
    const tts = makeTts();
    harness = await startHarness({ sessionId: "sess-1", tts: tts.deps });
    const client = await connect(harness);
    expect(harness.host.currentSessionId()).toBe("sess-1");

    // Activité du fil FOCALISÉ, avec un détail très « prononçable ».
    harness.host.emitExternal({
      type: "job_activity",
      sessionId: "sess-1",
      jobId: "job-1",
      stage: "job_progress",
      detail: "ACTIVITE-SECRETE-A-NE-PAS-PRONONCER",
      at: at(),
    });
    await client.waitFor("job_activity");
    await sleep(50);
    // Rien n'a été synthétisé par la seule activité.
    expect(tts.requested).toEqual([]);

    // Une réponse NORMALE, elle, doit bien être synthétisée (preuve non vide).
    harness.host.emitExternal({ type: "run_started", sessionId: "sess-1", runId: "r1" });
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-1",
      runId: "r1",
      channel: "content",
      text: "Bonjour, ceci est une réponse normale. ",
    });
    harness.host.emitExternal({
      type: "run_finished",
      sessionId: "sess-1",
      runId: "r1",
      reason: "done",
    });
    const start = Date.now();
    while (tts.requested.length === 0 && Date.now() - start < 3000) {
      await sleep(10);
    }
    expect(tts.requested.some((text) => text.includes("réponse normale"))).toBe(true);
    expect(
      tts.requested.every((text) => !text.includes("ACTIVITE-SECRETE-A-NE-PAS-PRONONCER")),
    ).toBe(true);
  });
});
