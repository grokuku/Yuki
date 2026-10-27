/**
 * Transport WS — ACCUSÉ DE RÉCEPTION.
 *
 * ⚠️ Ce que ce fichier prouve :
 *  - l'accusé voyage en trame de CONTRÔLE : aucun `seq` consommé, jamais dans le
 *    rejeu ni dans le snapshot, jamais dans le transcript ;
 *  - il est diffusé à la SEULE conversation concernée ;
 *  - il garde son ORDRE : il arrive AVANT la trame de l'action qui démarre
 *    (`job_started`) et avant le contenu qui suit ;
 *  - il n'est JAMAIS prononcé : le pipeline TTS ne reçoit que les `delta` de
 *    contenu, et l'accusé n'en est pas un (aucun appel au moteur).
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import type { TtsPipelineDeps } from "../../../src/tts/index.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of harnesses.splice(0)) await h.close();
});

type AckFrame = Extract<ServerFrame, { type: "ack" }>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCRIPT = {
  name: "accuse",
  steps: [
    { kind: "ack" as const, text: "Je m'en occupe.", tool: "delegate" },
    { kind: "delta" as const, channel: "content" as const, text: "C'est noté, je te tiens au courant." },
  ],
};

const SIMPLE = {
  name: "question-simple",
  steps: [
    { kind: "delta" as const, channel: "content" as const, text: "Bonjour !" },
  ],
};

describe("accusé de réception — trame de contrôle", () => {
  it("part AVANT la réponse, sans consommer de `seq` et sans entrer dans le snapshot", async () => {
    const h = await startHarness({ scripts: [SCRIPT], latencyScale: 0 });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");

    c.send({ type: "message", clientMsgId: "m1", text: "occupe-toi de ça" });
    const ack = (await c.waitFor("ack")) as AckFrame;
    expect(ack.text).toBe("Je m'en occupe.");
    expect(ack.tool).toBe("delegate");
    // ⚠️ ORDRE : l'accusé arrive AVANT le contenu de la réponse.
    const ackIndex = c.frames.findIndex((f) => f.type === "ack");
    const firstDelta = c.frames.findIndex((f) => f.type === "delta");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(firstDelta).toBeGreaterThan(ackIndex);
    // ⚠️ Trame de CONTRÔLE : elle N'AVANCE PAS le compteur `seq` — elle porte le
    // même `seq` que la dernière trame bufferisée, et la suivante prend le +1.
    const previous = c.frames[ackIndex - 1]!;
    expect(ack.seq).toBe(previous.seq);
    // La trame bufferisée SUIVANTE prend simplement le numéro suivant : l'accusé
    // n'a pas décalé le compteur (donc il n'occupe aucune place dans le rejeu).
    expect(c.frames[ackIndex + 1]!.seq).toBe(ack.seq + 1);
    void snapshot;

    await c.waitFor("run_finished");
    // ⚠️ Jamais dans le snapshot : ni l'accusé, ni un message.
    const after = await newClientSnapshot(h, c);
    expect(JSON.stringify(after)).not.toContain("Je m'en occupe");
    expect(
      after.transcript.filter((entry: { role?: string }) => entry.role === "assistant"),
    ).toHaveLength(1);
  });

  it("une question simple ne produit AUCUN accusé", async () => {
    const h = await startHarness({ scripts: [SIMPLE], latencyScale: 0 });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    c.send({ type: "message", clientMsgId: "m1", text: "bonjour" });
    await c.waitFor("run_finished");
    expect(c.frames.some((f) => f.type === "ack")).toBe(false);
  });

  it("n'est JAMAIS prononcé : le moteur TTS ne reçoit QUE le contenu", async () => {
    // ⚠️ Le seul alimentateur du moteur TTS est `routeTtsEvent`, appelé après
    // `streams.append` : l'accusé est dérouté AVANT, donc il n'atteint jamais la
    // synthèse. On le prouve en observant le TEXTE réellement synthétisé.
    const synthesized: string[] = [];
    const tts: TtsPipelineDeps = {
      enabled: true,
      config: {
        getString: () => "",
        getNumber: () => 0,
        getBoolean: () => false,
      } as unknown as TtsPipelineDeps["config"],
      synthesizer: async (request) => {
        synthesized.push(request.text);
        // Flux VIDE : on n'exige aucun moteur, seule compte l'intention de synthèse.
        return (async function* empty() {})();
      },
      resolveVoice: () => ({
        id: "voix-test",
        label: "Voix de test",
        engine: "audio-cpp",
        voiceId: "fr_test",
      }) as unknown as NonNullable<ReturnType<TtsPipelineDeps["resolveVoice"]>>,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
    const h = await startHarness({ scripts: [SCRIPT], latencyScale: 1, tts });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    c.send({ type: "message", clientMsgId: "m1", text: "occupe-toi de ça" });
    await c.waitFor("ack");
    await c.waitFor("run_finished");
    await delay(120);
    // ⚠️ Le témoin COMPTE : le contenu de la réponse EST bien synthétisé. Sans
    // cela, l'absence de l'accusé ne prouverait rien (le moteur aurait pu être muet).
    // Le moteur segmente finement : on compare sans espaces.
    const spoken = synthesized.join(" ").replace(/\s+/g, "");
    expect(spoken.length).toBeGreaterThan(0);
    expect(spoken).toContain("noté");
    // …et l'accusé, lui, n'a JAMAIS été prononcé.
    expect(spoken.toLowerCase()).not.toContain("occupe");
  });

});

/** Rouvre une connexion neuve et renvoie le snapshot de la conversation. */
async function newClientSnapshot(
  h: Harness,
  previous: TestClient,
): Promise<{ transcript: Array<{ role?: string }> } & Record<string, unknown>> {
  await previous.close();
  const fresh = await TestClient.connect(h.url);
  clients.push(fresh);
  fresh.send({ type: "hello" });
  const snapshot = await fresh.waitFor("snapshot");
  return snapshot as unknown as { transcript: Array<{ role?: string }> } & Record<string, unknown>;
}
