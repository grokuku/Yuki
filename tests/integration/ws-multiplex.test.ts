/**
 * Intégration WS — E2 : TRANSPORT MULTIPLEXÉ.
 *
 * Prouve, sur le transport RÉEL (FakePiHost + WsTransport) :
 *   1. le client est ABONNÉ à PLUSIEURS conversations à la fois : les trames de
 *      chaque fil lui parviennent, chacune portant SON `sessionId` ⇒ aucun
 *      mélange (les messages d'un fil ne se retrouvent jamais dans l'autre) ;
 *   2. un fil de FOND ne PARLE PAS : ses deltas arrivent (il est suivi) mais
 *      AUCUNE trame audio n'est émise — même pendant qu'il streame ;
 *   3. `broadcastBinary` livre l'audio aux clients ABONNÉS à la session.
 */

import { afterEach, describe, expect, it } from "vitest";

import { decodeTtsFrame } from "../../src/tts/framing.js";
import type { AudioStreamEvent, SegmentSynthesizer } from "../../src/tts/synthesizer.js";
import type { TtsPipelineDeps } from "../../src/tts/pipeline.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const TWO_SESSIONS = [
  { id: "sess-2", file: "/fake/sess-2.jsonl" },
];

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

describe("E2 — transport multiplexé (le client suit PLUSIEURS conversations)", () => {
  it("les trames des DEUX fils arrivent, chacune avec SON sessionId (aucun mélange)", async () => {
    harness = await startHarness({ sessionId: "sess-1", sessions: TWO_SESSIONS });
    const client = await connect(harness);

    // Le client suit sess-1 ET sess-2 (la liste renvoyée par `hello`).
    const sessions = client.frames.find((frame) => frame.type === "sessions");
    expect(sessions?.type).toBe("sessions");
    if (sessions?.type !== "sessions") return;
    expect(sessions.sessions.map((s) => s.id).sort()).toEqual(["sess-1", "sess-2"]);

    // Un run d'ARRIÈRE-PLAN (sess-2, NON focalisé) streame.
    harness.host.emitExternal({
      type: "run_started",
      sessionId: "sess-2",
      runId: "r-2",
    });
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-2",
      runId: "r-2",
      channel: "content",
      text: "MESSAGE-DU-FIL-B",
    });
    // Un run de la conversation FOCALISÉE (sess-1).
    harness.host.emitExternal({
      type: "run_started",
      sessionId: "sess-1",
      runId: "r-1",
    });
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-1",
      runId: "r-1",
      channel: "content",
      text: "MESSAGE-DU-FIL-A",
    });
    await sleep(60);

    const deltas = client.frames.filter(
      (frame): frame is Extract<(typeof client.frames)[number], { type: "delta" }> =>
        frame.type === "delta",
    );
    const fromB = deltas.filter((d) => d.sessionId === "sess-2").map((d) => d.text);
    const fromA = deltas.filter((d) => d.sessionId === "sess-1").map((d) => d.text);

    // Le fil de fond est bien SUIVI (ses messages sont arrivés)…
    expect(fromB.join("")).toContain("MESSAGE-DU-FIL-B");
    // …et le fil focalisé aussi.
    expect(fromA.join("")).toContain("MESSAGE-DU-FIL-A");
    // AUCUN mélange : chaque message reste dans SON fil.
    expect(fromB.join("")).not.toContain("MESSAGE-DU-FIL-A");
    expect(fromA.join("")).not.toContain("MESSAGE-DU-FIL-B");
  });
});

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

describe("E2 — un fil de FOND reste MUET", () => {
  it("le fil suivi mais NON focalisé streame SANS produire une seule trame audio", async () => {
    const tts = makeTts();
    harness = await startHarness({
      sessionId: "sess-1",
      sessions: TWO_SESSIONS,
      tts: tts.deps,
    });
    const client = await connect(harness);
    expect(harness.host.currentSessionId()).toBe("sess-1");

    // Run d'ARRIÈRE-PLAN sur sess-2 : le client en est ABONNÉ (il reçoit le
    // texte) mais le pipeline TTS ne suit QUE la session focalisée.
    harness.host.emitExternal({ type: "run_started", sessionId: "sess-2", runId: "rB" });
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-2",
      runId: "rB",
      channel: "content",
      text: "Voix d'un fil de fond. ",
    });
    harness.host.emitExternal({
      type: "run_finished",
      sessionId: "sess-2",
      runId: "rB",
      reason: "done",
    });
    await sleep(80);

    // 1) Le fil de fond est SUIVI : son contenu est bien arrivé au client…
    const backgroundText = client.frames
      .filter((f) => f.type === "delta" && f.sessionId === "sess-2")
      .map((f) => (f.type === "delta" ? f.text : ""))
      .join("");
    expect(backgroundText).toContain("fil de fond");
    // 2) …MAIS zéro audio : aucune synthèse, aucune trame binaire.
    expect(tts.requested).toEqual([]);
    expect(client.binaryFrames).toEqual([]);

    // 3) La conversation FOCALISÉE, elle, parle bien (la preuve n'est pas vide).
    harness.host.emitExternal({ type: "run_started", sessionId: "sess-1", runId: "rA" });
    harness.host.emitExternal({
      type: "delta",
      sessionId: "sess-1",
      runId: "rA",
      channel: "content",
      text: "Voix du fil courant. ",
    });
    harness.host.emitExternal({
      type: "run_finished",
      sessionId: "sess-1",
      runId: "rA",
      reason: "done",
    });
    const start = Date.now();
    while (tts.requested.length === 0 && Date.now() - start < 3000) {
      await sleep(10);
    }
    expect(tts.requested.some((text) => text.includes("fil courant"))).toBe(true);
    expect(tts.requested.every((text) => !text.includes("fil de fond"))).toBe(true);
    // Une trame binaire a bien été livrée pour le fil focalisé (client abonné).
    const audioStart = Date.now();
    const hasAudio = (): boolean =>
      client.binaryFrames
        .map((frame) => decodeTtsFrame(frame))
        .some((decoded) => decoded?.header.type === "tts_audio");
    while (!hasAudio() && Date.now() - audioStart < 3000) {
      await sleep(10);
    }
    expect(hasAudio()).toBe(true);
  });
});
