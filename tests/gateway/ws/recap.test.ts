/**
 * « Continuer dans une conversation dédiée » — transport WS + `FakePiHost`.
 *
 * Prouve, de bout en bout (sans SDK) :
 *   - l'APERÇU (`recap_preview` → `recap_ready`) porte les FAITS du sujet ;
 *   - la conversation créée S'OUVRE avec le récapitulatif (bloc `recap` VISIBLE
 *     dans le snapshot) et le `run_started` ne porte AUCUN `userText` (le
 *     récapitulatif n'est pas attribué à l'utilisateur) ;
 *   - il n'est PAS synthétisé par la TTS (synthétiseur instrumenté) ;
 *   - la conversation d'ORIGINE n'est pas modifiée par l'aperçu ;
 *   - un ÉCHEC du générateur ou de l'injection ne laisse AUCUNE conversation à
 *     moitié (tout ou rien).
 */

import { describe, expect, it } from "vitest";

import { createRecapService, partHeading } from "../../../src/recap/index.js";
import type { RecapGenerator, RecapInput } from "../../../src/recap/index.js";
import type { TranscriptEntry } from "../../../src/pi/types.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import type { TtsPipelineDeps } from "../../../src/tts/index.js";
import type { Voice } from "../../../src/tts/types.js";
import { TestClient, startHarness } from "./harness.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Boucle d'attente bornée (les synthèses TTS arrivent hors de la trame WS). */
async function eventually(check: () => boolean, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(15);
  }
  return check();
}

/** Enregistre les textes réellement envoyés au moteur TTS. */
function ttsDeps(synthTexts: string[]): TtsPipelineDeps {
  const voice: Voice = {
    id: "camille",
    label: "Camille",
    kind: "preset",
    lang: "fr",
    refAudio: "presets/camille.wav",
    refText: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "factory",
  };
  return {
    enabled: true,
    config: {
      getString: (path) =>
        path === "tts.engine" ? "audio-cpp" : path === "tts.voice" ? "camille" : "",
      getNumber: (path) =>
        path === "tts.prefetchDepth" ? 1 : path === "tts.minSentenceChars" ? 1 : 400,
    },
    synthesizer: async (request) => {
      synthTexts.push(request.text);
      return (async function* () {
        yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
        yield { type: "data" as const, bytes: Buffer.from([1, 2, 3]) };
      })();
    },
    resolveVoice: () => voice,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

/** Générateur factice : reprend le SUJET et un marqueur unique. */
function makeGenerator(seen: RecapInput[]): RecapGenerator {
  return async (input) => {
    seen.push(input);
    return {
      title: input.subject ? `Sujet : ${input.subject}` : "Toute la conversation",
      recap:
        "RÉCAPITULATIF-MARQUEUR\n" +
        "- Décision : la clé du coffre reste en 0600.\n" +
        "- Chiffrement : AES-256-GCM, 4096 bits.",
      messageCount: input.messages.length,
      parts: 1,
    };
  };
}

async function connectAndSeed(client: TestClient): Promise<void> {
  client.send({ type: "hello", clientVersion: "test" });
  await client.waitFor("welcome");
  await client.waitFor("sessions");
  await client.waitFor("snapshot");
}

describe("ws — conversation dédiée (aperçu puis création)", () => {
  it("aperçu avec les faits, création avec le récapitulatif visible, sans TTS ni bulle utilisateur", async () => {
    const seen: RecapInput[] = [];
    const synthTexts: string[] = [];
    const harness = await startHarness({
      recap: makeGenerator(seen),
      tts: ttsDeps(synthTexts),
      scripts: [
        { name: "origine", steps: [{ kind: "delta", channel: "content", text: "Réponse d'origine." }] },
        { name: "dediee", steps: [{ kind: "delta", channel: "content", text: "Sujet bien pris en compte." }] },
      ],
    });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);

      // 1) On peuple le fil d'origine avec des FAITS.
      client.send({ type: "message", clientMsgId: "m1", text: "Où est stockée la clé du coffre ?" });
      await client.waitFor("run_finished");

      const before = harness.host.getState("sess-1")?.transcript ?? [];
      expect(before.some((e) => e.role === "user")).toBe(true);

      // 2) APERÇU axé sur un sujet.
      client.send({
        type: "recap_preview",
        sessionId: "sess-1",
        subject: "le coffre de secrets",
        requestId: "R1",
      });
      const ready = await client.waitFor(
        (frame) => frame.type === "recap_ready" && frame.requestId === "R1",
      );
      if (ready.type !== "recap_ready") throw new Error("recap_ready attendu");
      expect(ready.title).toBe("Sujet : le coffre de secrets");
      expect(ready.recap).toContain("RÉCAPITULATIF-MARQUEUR");
      expect(ready.subject).toBe("le coffre de secrets");
      expect(ready.originSessionId).toBe("sess-1");
      expect(ready.messageCount).toBeGreaterThan(0);

      // Le générateur a bien reçu le SUJET et les messages de la conversation.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.subject).toBe("le coffre de secrets");
      expect(seen[0]?.messages.some((m) => m.text.includes("clé du coffre"))).toBe(true);

      // 3) L'aperçu NE MODIFIE PAS la conversation d'origine.
      const after = harness.host.getState("sess-1")?.transcript ?? [];
      expect(after).toEqual(before);

      // 4) CRÉATION (titre/recap éventuellement corrigés).
      client.send({
        type: "recap_create",
        requestId: "R1",
        title: "Coffre de secrets",
        recap: "RÉCAPITULATIF-MARQUEUR\n- Décision : clé en 0600.",
      });
      const sessions = await client.waitFor(
        (frame) =>
          frame.type === "sessions" && frame.sessions.some((s) => s.title === "Coffre de secrets"),
      );
      if (sessions.type !== "sessions") throw new Error("sessions attendu");
      const created = sessions.sessions.find((s) => s.title === "Coffre de secrets");
      expect(created).toBeDefined();
      expect(sessions.activeId).toBe(created?.id);

      const snapshot = await client.waitFor(
        (frame) => frame.type === "snapshot" && frame.transcript.some((e) => e.role === "recap"),
      );
      if (snapshot.type !== "snapshot") throw new Error("snapshot attendu");
      const recapEntry = snapshot.transcript.find((e) => e.role === "recap");
      // Le récapitulatif est VISIBLE et relisible, avec sa référence d'origine.
      expect(recapEntry?.text).toContain("clé en 0600");
      expect(recapEntry?.origin).toBeTruthy();
      // Et AUCUNE bulle utilisateur ne porte le récapitulatif.
      const userTexts = snapshot.transcript.filter((e) => e.role === "user").map((e) => e.text);
      expect(userTexts.some((t) => t.includes("RÉCAPITULATIF-MARQUEUR"))).toBe(false);

      // Le `run_started` du récapitulatif ne porte PAS de userText.
      await client.waitFor((frame) => frame.type === "run_started" && frame.origin === "recap");
      const recapRun = client.frames.find(
        (f) => f.type === "run_started" && f.origin === "recap",
      );
      if (recapRun?.type !== "run_started") throw new Error("run_started recap attendu");
      expect(recapRun.userText).toBeUndefined();

      // Le cycle est CLOS explicitement (le déclencheur redevient disponible).
      const createdFrame = await client.waitFor(
        (frame) => frame.type === "recap_created" && frame.requestId === "R1",
      );
      if (createdFrame.type !== "recap_created") throw new Error("recap_created attendu");

      // 5) La TTS est BIEN branchée (elle synthétise la réponse de la
      //    conversation dédiée) mais n'a JAMAIS synthétisé le récapitulatif.
      expect(await eventually(() => synthTexts.some((t) => t.includes("bien pris en compte")))).toBe(
        true,
      );
      expect(synthTexts.some((t) => t.includes("RÉCAPITULATIF-MARQUEUR"))).toBe(false);

      await client.close();
    } finally {
      await harness.close();
    }
  });

  it("une erreur du générateur ⇒ message honnête et AUCUNE conversation créée", async () => {
    const harness = await startHarness({
      recap: async () => {
        throw new Error("panne réseau");
      },
    });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);
      client.send({ type: "message", clientMsgId: "m1", text: "un fait" });
      await client.waitFor("run_finished");

      const before = (await harness.host.listSessions()).map((s) => s.sessionId).sort();
      client.send({ type: "recap_preview", sessionId: "sess-1", subject: "x", requestId: "R2" });
      const error = await client.waitFor(
        (frame) => frame.type === "error" && frame.requestId === "R2",
      );
      if (error.type !== "error") throw new Error("error attendu");
      expect(error.code).toBe("recap_failed");

      const after = (await harness.host.listSessions()).map((s) => s.sessionId).sort();
      expect(after).toEqual(before);
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it("portion trop longue ⇒ refus honnête (recap_too_long), aucun appel modèle", async () => {
    let called = false;
    // On exerce le VRAI service (garde-fou d'entrée inclus).
    const service = createRecapService(async () => {
      called = true;
      return "TITRE: x\n=== RÉCAPITULATIF ===\ny";
    });
    const harness = await startHarness({ recap: service });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);
      client.send({ type: "message", clientMsgId: "m1", text: "z".repeat(300_000) });
      await client.waitFor(
        (frame) => frame.type === "run_finished",
        10_000,
      );

      client.send({ type: "recap_preview", sessionId: "sess-1", subject: "x", requestId: "R3" });
      const error = await client.waitFor(
        (frame) => frame.type === "error" && frame.requestId === "R3",
      );
      if (error.type !== "error") throw new Error("error attendu");
      expect(error.code).toBe("recap_too_long");
      expect(called).toBe(false);
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it("échec de l'INJECTION ⇒ la conversation ébauchée est retirée (tout ou rien)", async () => {
    const harness = await startHarness({
      recap: makeGenerator([]),
      scripts: [{ name: "origine", steps: [{ kind: "delta", channel: "content", text: "ok." }] }],
    });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);
      client.send({ type: "message", clientMsgId: "m1", text: "un fait" });
      await client.waitFor("run_finished");

      const before = await harness.host.listSessions();
      client.send({ type: "recap_preview", sessionId: "sess-1", subject: "x", requestId: "R4" });
      await client.waitFor((frame) => frame.type === "recap_ready" && frame.requestId === "R4");

      // Le PROCHAIN `send` (l'injection du récapitulatif) échoue.
      harness.host.failNextSend();
      client.send({ type: "recap_create", requestId: "R4", title: "Échec attendu" });
      const error = await client.waitFor(
        (frame) => frame.type === "error" && frame.requestId === "R4",
      );
      if (error.type !== "error") throw new Error("error attendu");

      // TOUT OU RIEN : la conversation ébauchée a été RETIRÉE (elle n'est plus
      // listée), et aucune conversation titrée « Échec attendu » ne subsiste.
      const after = await harness.host.listSessions();
      expect(after.some((s) => s.title === "Échec attendu")).toBe(false);
      expect(after).toHaveLength(before.length);
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it("requestId inconnu à la création ⇒ recap_not_found", async () => {
    const harness = await startHarness({ recap: makeGenerator([]) });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);
      client.send({ type: "recap_create", requestId: "inconnu", title: "X" });
      const error = await client.waitFor(
        (frame) => frame.type === "error" && frame.requestId === "inconnu",
      );
      if (error.type !== "error") throw new Error("error attendu");
      expect(error.code).toBe("recap_not_found");
      await client.close();
    } finally {
      await harness.close();
    }
  });

  it("un fil VOLUMINEUX est DÉCOUPÉ : progression visible + récapitulatif complet (joints intacts)", async () => {
    // 30 messages de 10 000 car. : plus long que la limite d'un appel.
    const long: TranscriptEntry[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text:
        `${index === 0 ? "FAIT-DEBUT " : index === 29 ? "FAIT-FIN " : ""}` +
        `message ${index} ` +
        "x".repeat(10_000),
    }));
    const prompts: string[] = [];
    // VRAI service : c'est LUI qui découpe et concatène.
    const service = createRecapService(async (prompt) => {
      prompts.push(prompt);
      const found = ["FAIT-DEBUT", "FAIT-FIN"].filter((f) => prompt.includes(f));
      return `TITRE: Suite\n=== RÉCAPITULATIF ===\nPART: ${found.join(",") || "aucun"}`;
    });
    const harness = await startHarness({
      recap: service,
      sessions: [{ id: "big", file: "/fake/big.jsonl", title: "Longue", transcript: long }],
    });
    try {
      const client = await TestClient.connect(harness.url);
      await connectAndSeed(client);
      // Bascule vers la conversation volumineuse.
      client.send({ type: "switch", sessionId: "big" });
      await client.waitFor((frame) => frame.type === "snapshot" && frame.transcript.length >= 30);

      client.send({ type: "recap_preview", sessionId: "big", subject: "", requestId: "RB" });
      const ready = await client.waitFor(
        (frame) => frame.type === "recap_ready" && frame.requestId === "RB",
        10_000,
      );
      if (ready.type !== "recap_ready") throw new Error("recap_ready attendu");

      // Plus AUCUN refus : le fil volumineux est traité en plusieurs parties.
      expect(ready.parts).toBeGreaterThan(1);
      expect(prompts).toHaveLength(ready.parts);

      // Le fait de la 1re tranche ET celui de la dernière sont TOUS DEUX présents.
      expect(ready.recap).toContain("PART: FAIT-DEBUT");
      expect(ready.recap).toContain("PART: FAIT-FIN");

      // L'ordre des parties est respecté.
      const positions = Array.from({ length: ready.parts }, (_, i) =>
        ready.recap.indexOf(partHeading(i + 1, ready.parts)),
      );
      for (const position of positions) expect(position).toBeGreaterThan(-1);
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i]).toBeGreaterThan(positions[i - 1]!);
      }

      // PROGRESSION VISIBLE : une trame par partie, dans l'ordre.
      const progress = client.frames.filter(
        (frame): frame is Extract<ServerFrame, { type: "recap_progress" }> =>
          frame.type === "recap_progress" && frame.requestId === "RB",
      );
      expect(progress.map((frame) => frame.part)).toEqual(
        Array.from({ length: ready.parts }, (_, i) => i + 1),
      );
      for (const frame of progress) {
        expect(frame.parts).toBe(ready.parts);
      }

      await client.close();
    } finally {
      await harness.close();
    }
  });
});
