/**
 * Intégration WS — ⚠️ LOT 36 (L11) : LE RUN QUI PARLE EST CELUI DU BON HOST.
 *
 * Le transport reçoit l'événement d'un host (`source`) et le passe au pipeline
 * TTS : la VOIX doit être celle du bot PROPRIÉTAIRE de ce host (`tts.voice` est
 * une clé `bot`). Un run de `kohai` ne doit jamais parler avec la voix de
 * `yuki` — ni l'inverse.
 *
 * ⚠️ Échoue sur le code d'origine : `BotHostsPort.botDe` et
 * `TtsPipelineDeps.configPour` n'existent pas — le pipeline ne lisait que la
 * configuration d'instance, donc chaque bot parlait avec la voix du principal.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  TtsPipelineConfig,
  TtsPipelineDeps,
} from "../../src/tts/pipeline.js";
import type { AudioStreamEvent, SegmentSynthesizer } from "../../src/tts/synthesizer.js";
import type { FakeScript } from "../pi/host-double.js";
import { FakePiHost } from "../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function config(voix: string): TtsPipelineConfig {
  const valeurs: Record<string, string | number> = {
    "tts.prefetchDepth": 2,
    "tts.minSentenceChars": 1,
    "tts.maxSentenceChars": 500,
    "tts.engine": "chatterbox",
    "tts.voice": voix,
    "tts.emotion": "neutre",
    "tts.exaggeration": 500,
    "tts.cfg": 500,
    "tts.speed": 100,
    "tts.language": "fr",
  };
  return {
    getString: (chemin) => String(valeurs[chemin] ?? ""),
    getNumber: (chemin) => Number(valeurs[chemin] ?? 0),
  };
}

const SCRIPT: FakeScript = {
  steps: [{ kind: "delta" as const, channel: "content" as const, text: "Bonjour à toi. ", delayMs: 1 }],
};

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await harness?.close();
  harness = undefined;
});

async function attendre(predicat: () => boolean, ms = 3_000): Promise<void> {
  const debut = Date.now();
  while (!predicat()) {
    if (Date.now() - debut > ms) throw new Error("timeout en attendant la synthèse");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

/** Banc : deux hosts (principal + `kohai`), chacun avec SON script. */
function ttsDeuxBots(voixEntendues: string[]): TtsPipelineDeps {
  const synthesizer: SegmentSynthesizer = async (request) => {
    voixEntendues.push(request.voice?.id ?? "aucune");
    return (async function* () {
      const evenements: AudioStreamEvent[] = [
        { type: "format", sampleRate: 16_000, channels: 1 },
        { type: "data", bytes: Buffer.from([1, 2, 3, 4]) },
      ];
      for (const evenement of evenements) yield evenement;
    })();
  };
  return {
    enabled: true,
    config: config("voix-yuki"),
    configPour: (botId) => config(botId === "kohai" ? "voix-kohai" : "voix-yuki"),
    synthesizer,
    resolveVoice: (id) => (id.length > 0 ? ({ id, label: id } as never) : null),
    logger,
    sleep: async () => undefined,
  };
}

describe("intégration WS — voix par bot (lot 36, L11)", () => {
  it("un run de `kohai` parle avec la voix de SON `configBot`", async () => {
    const voix: string[] = [];
    const kohai = new FakePiHost({ sessionId: "sess-kohai", scripts: [SCRIPT] });
    await kohai.start();
    harness = await startHarness({
      sessionId: "sess-yuki",
      scripts: [],
      autresHosts: { kohai },
      tts: ttsDeuxBots(voix),
    });

    const client = await TestClient.connect(harness.urlBot("kohai"));
    clients.push(client);
    client.send({ type: "hello" });
    await client.waitFor((frame) => frame.type === "welcome");
    await client.waitFor((frame) => frame.type === "snapshot");

    client.send({ type: "message", clientMsgId: "m-kohai", text: "go" });
    await client.waitFor("run_finished");
    await attendre(() => voix.length > 0);

    // ⚠️ TEST CENTRAL : la voix est celle de `kohai`, jamais celle du principal.
    expect(voix[0]).toBe("voix-kohai");
    expect(voix).not.toContain("voix-yuki");
  });

  it("le PRINCIPAL est inchangé : son run garde la configuration d'instance", async () => {
    const voix: string[] = [];
    const kohai = new FakePiHost({ sessionId: "sess-kohai", scripts: [SCRIPT] });
    await kohai.start();
    harness = await startHarness({
      sessionId: "sess-yuki",
      scripts: [SCRIPT],
      autresHosts: { kohai },
      tts: ttsDeuxBots(voix),
    });

    const client = await TestClient.connect(harness.url);
    clients.push(client);
    client.send({ type: "hello" });
    await client.waitFor((frame) => frame.type === "welcome");
    await client.waitFor((frame) => frame.type === "snapshot");

    client.send({ type: "message", clientMsgId: "m-yuki", text: "go" });
    await client.waitFor("run_finished");
    await attendre(() => voix.length > 0);

    expect(voix[0]).toBe("voix-yuki");
    expect(voix).not.toContain("voix-kohai");
  });
});
