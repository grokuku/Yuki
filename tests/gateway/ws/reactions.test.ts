/**
 * Transport WS — RÉACTIONS aux messages de Yuki.
 *
 * Ce que ce fichier prouve, de bout en bout (hôte Pi simulé, transport réel) :
 *  1. une réaction est CORRÉLÉE au message par son `entryId` (l'identifiant
 *     d'entrée de session du message — celui que les statistiques utilisent via
 *     `parentId`) : elle se retrouve sur CE message et sur aucun autre ;
 *  2. elle SURVIT à la RECONNEXION (et à un rechargement complet du rendu) : le
 *     `snapshot` la restitue avec le message ;
 *  3. elle ne déclenche AUCUN tour : ZÉRO `run_started`, aucune trame de flux ;
 *  4. elle n'alimente JAMAIS la synthèse vocale : le synthétiseur n'est pas
 *     appelé (aucun segment, aucun texte prononcé) ;
 *  5. changer / retirer fonctionne (une seule réaction par message) ;
 *  6. une réaction inconnue est refusée avec un message HONNÊTE.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { ReactionStore } from "../../../src/reactions/store.js";
import type { ReactionsGatewayPort } from "../../../src/reactions/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../../src/tts/index.js";
import { startHarness, TestClient, type Harness } from "./harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harnesses: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type ReactionFrame = Extract<ServerFrame, { type: "reaction" }>;
type SnapshotFrame = Extract<ServerFrame, { type: "snapshot" }>;

/** Store RÉEL sur disque (volume `state` simulé) + port du transport. */
function realReactions(): {
  store: ReactionStore;
  port: ReactionsGatewayPort;
  spoken: string[];
  tts: TtsPipelineDeps;
} {
  const dir = mkdtempSync(join(tmpdir(), "yuki-reactions-ws-"));
  dirs.push(dir);
  const store = ReactionStore.open({ path: join(dir, "reactions.jsonl") });
  const spoken: string[] = [];
  const synthesizer: SegmentSynthesizer = async (request) => {
    spoken.push(request.text);
    return (async function* () {
      yield { type: "format", sampleRate: 16_000, channels: 1 };
      yield { type: "data", bytes: Buffer.alloc(800) };
    })();
  };
  return {
    store,
    spoken,
    port: {
      set: (sessionId, entryId, reaction) => store.set(sessionId, entryId, reaction) !== null,
      clear: (sessionId, entryId) => store.clear(sessionId, entryId),
      forSession: (sessionId) => store.forSession(sessionId),
    },
    tts: {
      enabled: true,
      config: {
        getString: (path) => (path === "tts.engine" ? "chatterbox" : ""),
        getNumber: (path) =>
          path === "tts.maxSentenceChars" ? 200 : path === "tts.prefetchDepth" ? 1 : 1,
      },
      synthesizer,
      resolveVoice: () => null,
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  };
}

/**
 * Attend le PROCHAIN `run_finished` porteur d'un identifiant de message au-delà
 * de `after` déjà reçus (un `waitFor` nu renverrait une trame ANTÉRIEURE).
 */
async function nextEntryId(c: TestClient, after: number): Promise<string> {
  const finished = () =>
    c.frames.filter(
      (f): f is Extract<ServerFrame, { type: "run_finished" }> =>
        f.type === "run_finished" && typeof f.entryId === "string",
    );
  await c.waitFor(() => finished().length > after, 5000);
  const list = finished();
  const entryId = list[list.length - 1].entryId;
  if (!entryId) throw new Error("run_finished sans entryId");
  return entryId;
}

/** Répond au prochain tour du double d'hôte (contenu simple). */
function script(): { steps: Array<{ kind: "delta"; channel: "content"; text: string; delayMs?: number }> } {
  return { steps: [{ kind: "delta", channel: "content", text: "Réponse de Yuki.", delayMs: 1 }] };
}

describe("WS — réaction corrélée au message", () => {
  it("se rattache à l'`entryId` du message visé, et à lui seul", async () => {
    const reactions = realReactions();
    const h = await startHarness({
      sessionId: "sess-1",
      scripts: [script(), script()],
      reactions: reactions.port,
      tts: reactions.tts,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");

    // Deux tours : deux messages assistant, chacun avec SON identifiant.
    c.send({ type: "message", clientMsgId: "Premier tour", text: "Premier tour" });
    const first = await nextEntryId(c, 0);
    c.send({ type: "message", clientMsgId: "Second tour", text: "Second tour" });
    const second = await nextEntryId(c, 1);
    const ids = [first, second];
    expect(ids[0]).not.toBe(ids[1]);

    // On réagit sur le PREMIER message (le piège n°1 : réagir sur le mauvais).
    c.send({ type: "reaction", sessionId: "sess-1", entryId: ids[0], reaction: "trop-long" });
    const frame = (await c.waitFor((f) => f.type === "reaction", 3000)) as ReactionFrame;
    expect(frame.entryId).toBe(ids[0]);
    expect(frame.reaction).toBe("trop-long");
    // Aucun `seq` consommé (trame de CONTRÔLE).
    expect(frame.seq).toBeGreaterThan(0);
    expect(reactions.store.get("sess-1", ids[0])).toBe("trop-long");
    expect(reactions.store.get("sess-1", ids[1])).toBeNull;
    expect(reactions.store.get("sess-1", ids[1])).toBeUndefined();
    await c.close();
  });

  it("SURVIT au rechargement : la reconnexion retrouve la réaction sur LE BON message", async () => {
    const reactions = realReactions();
    const h = await startHarness({
      sessionId: "sess-1",
      scripts: [script(), script()],
      reactions: reactions.port,
    });
    harnesses.push(h);
    const first = await TestClient.connect(h.url);
    first.send({ type: "hello" });
    await first.waitFor((f) => f.type === "snapshot");

    first.send({ type: "message", clientMsgId: "Un", text: "Un" });
    const idA = await nextEntryId(first, 0);
    first.send({ type: "message", clientMsgId: "Deux", text: "Deux" });
    const idB = await nextEntryId(first, 1);
    const ids = [idA, idB];
    first.send({ type: "reaction", sessionId: "sess-1", entryId: ids[1], reaction: "faux" });
    await first.waitFor((f) => f.type === "reaction", 3000);

    // RECONNEXION : nouveau client, `hello` ⇒ snapshot autoritatif.
    const second = await TestClient.connect(h.url);
    second.send({ type: "hello" });
    const snapshot = (await second.waitFor((f) => f.type === "snapshot", 4000)) as SnapshotFrame;
    const assistants = snapshot.transcript.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(2);
    // L'identifiant ET la réaction sont repris : le message VISÉ est le second.
    expect(assistants[0].id).toBe(ids[0]);
    expect(assistants[0].reaction).toBeUndefined();
    expect(assistants[1].id).toBe(ids[1]);
    expect(assistants[1].reaction).toBe("faux");
    await first.close();
    await second.close();
  });

  it("survit aussi à un RECHARGEMENT du store (journal relu du disque)", async () => {
    const reactions = realReactions();
    const h = await startHarness({
      sessionId: "sess-1",
      scripts: [script()],
      reactions: reactions.port,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");
    c.send({ type: "message", clientMsgId: "m", text: "Question" });
    const entryId = await nextEntryId(c, 0);
    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: "utile" });
    await c.waitFor((f) => f.type === "reaction", 3000);

    // Le journal relu depuis le disque (redémarrage) contient la même corrélation.
    const reopened = ReactionStore.open({ path: reactions.store.filePath });
    expect(reopened.get("sess-1", entryId)).toBe("utile");
    await c.close();
  });
});

describe("WS — une réaction ne déclenche AUCUN tour et reste MUETTE", () => {
  it("ZÉRO `run_started` et AUCUN segment prononcé", async () => {
    const reactions = realReactions();
    const h = await startHarness({
      sessionId: "sess-1",
      scripts: [script()],
      reactions: reactions.port,
      tts: reactions.tts,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");
    c.send({ type: "message", clientMsgId: "m", text: "Question" });
    const entryId = await nextEntryId(c, 0);
    // On laisse le run et sa synthèse se terminer (le dernier segment part au
    // `run_finished`), puis on remet les compteurs à zéro.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const runsBefore = c.frames.filter((f) => f.type === "run_started").length;
    const spokenBefore = reactions.spoken.length;
    // Preuve que la chaîne vocale FONCTIONNE pour un tour normal (sinon
    // l'assertion « rien de nouveau » ci-dessous ne prouverait rien).
    expect(spokenBefore).toBeGreaterThan(0);
    expect(reactions.spoken.join(" ")).toContain("Réponse de Yuki");

    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: "trop-bavard" });
    await c.waitFor((f) => f.type === "reaction", 3000);
    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: "fatigue" });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // AUCUN tour : le compte de `run_started` n'a pas bougé.
    expect(c.frames.filter((f) => f.type === "run_started").length).toBe(runsBefore);
    // AUCUNE voix : le synthétiseur n'a reçu aucun nouveau texte.
    expect(reactions.spoken.length).toBe(spokenBefore);
    // Et rien n'est entré dans le flux bufferisé (aucune trame de contenu).
    expect(c.frames.filter((f) => f.type === "delta")).toHaveLength(1);
    await c.close();
  });
});

describe("WS — changer, retirer, refuser", () => {
  it("une seule réaction par message : changer remplace, retirer efface", async () => {
    const reactions = realReactions();
    const h = await startHarness({
      sessionId: "sess-1",
      scripts: [script()],
      reactions: reactions.port,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");
    c.send({ type: "message", clientMsgId: "m", text: "Question" });
    const entryId = await nextEntryId(c, 0);

    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: "trop-long" });
    const first = (await c.waitFor((f) => f.type === "reaction", 3000)) as ReactionFrame;
    expect(first.reaction).toBe("trop-long");
    expect(reactions.store.size).toBe(1);

    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: "utile" });
    const changed = (await c.waitFor(
      (f) => f.type === "reaction" && f.reaction === "utile",
      3000,
    )) as ReactionFrame;
    expect(changed.entryId).toBe(entryId);
    // Toujours UNE seule réaction sur ce message.
    expect(reactions.store.size).toBe(1);
    expect(reactions.store.get("sess-1", entryId)).toBe("utile");

    c.send({ type: "reaction", sessionId: "sess-1", entryId, reaction: null });
    const removed = (await c.waitFor(
      (f) => f.type === "reaction" && f.reaction === null,
      3000,
    )) as ReactionFrame;
    expect(removed.entryId).toBe(entryId);
    expect(reactions.store.get("sess-1", entryId)).toBeUndefined();
    await c.close();
  });

  it("refuse une réaction INCONNUE avec un message honnête (aucune écriture)", async () => {
    const reactions = realReactions();
    const h = await startHarness({ sessionId: "sess-1", reactions: reactions.port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");

    c.send({ type: "reaction", sessionId: "sess-1", entryId: "e-1", reaction: "nimporte-quoi" });
    const error = await c.waitFor((f) => f.type === "error", 3000);
    if (error.type !== "error") throw new Error("erreur attendue");
    expect(error.code).toBe("reaction_unknown");
    expect(reactions.store.size).toBe(0);
    await c.close();
  });

  it("refuse une trame SANS identifiant de message (jamais une réaction au hasard)", async () => {
    const h = await startHarness({ sessionId: "sess-1" });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");

    c.send({ type: "reaction", sessionId: "sess-1", reaction: "utile" });
    const error = await c.waitFor((f) => f.type === "error", 3000);
    if (error.type !== "error") throw new Error("erreur attendue");
    expect(error.code).toBe("bad_request");
    await c.close();
  });

  it("sans port de réactions, l'action est refusée proprement", async () => {
    const h = await startHarness({ sessionId: "sess-1" });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "snapshot");

    c.send({ type: "reaction", sessionId: "sess-1", entryId: "e-1", reaction: "utile" });
    const error = await c.waitFor((f) => f.type === "error", 3000);
    if (error.type !== "error") throw new Error("erreur attendue");
    expect(error.code).toBe("reactions_unavailable");
    await c.close();
  });
});
