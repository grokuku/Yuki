/**
 * Transport WS — SUPPRESSION DÉFINITIVE et COMPACTION FORCÉE.
 *
 * Ce que ce fichier prouve :
 *  - `delete` fait DISPARAÎTRE la conversation de la liste, efface son fichier
 *    (double : `deletedIds`), nettoie l'épingle orpheline et retombe sur l'état
 *    vide quand c'était la conversation ouverte ;
 *  - `delete` sur une cible inconnue remonte une trame `error` (jamais un succès
 *    muet) et ne change RIEN à la liste ;
 *  - `compact` relaie la PROGRESSION en trames de contrôle (`compact_progress`,
 *    avec `requestId`) puis le compte rendu `compact_done` — dans cet ORDRE ;
 *  - un échec de compaction arrive en `error` CORRÉLÉE (`requestId`) : c'est la
 *    fenêtre d'action qui l'affiche, pas une bulle d'assistant.
 */

import { describe, expect, it, afterEach } from "vitest";

import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;
type CompactDone = Extract<ServerFrame, { type: "compact_done" }>;
type CompactProgress = Extract<ServerFrame, { type: "compact_progress" }>;
type ErrorFrame = Extract<ServerFrame, { type: "error" }>;

/** Attend la PROCHAINE trame `sessions` au-delà de `afterCount` déjà reçues. */
async function nextSessions(c: TestClient, afterCount: number): Promise<SessionsFrame> {
  const count = () => c.frames.filter((f) => f.type === "sessions").length;
  const frame = await c.waitFor(() => count() > afterCount, 3000);
  if (frame.type !== "sessions") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}

describe("WS — suppression définitive d'une conversation", () => {
  it("supprime : la conversation quitte la liste, son fichier est effacé", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }, { id: "s2" }] });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "delete", sessionId: "s2" });
    const after = await nextSessions(c, 1);
    expect(after.sessions.map((s) => s.id)).toEqual(["s1"]);
    // Le fichier de la conversation a bien été effacé côté hôte.
    expect(h.host.deletedIds.has("s2")).toBe(true);
    await c.close();
  });

  it("supprimer la conversation OUVERTE ⇒ liste sans elle + état vide (snapshot vide)", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }, { id: "s2" }] });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "delete", sessionId: "s1" });
    const after = await nextSessions(c, 1);
    expect(after.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(after.activeId).toBeNull();
    const snapshot = await c.waitFor((f) => f.type === "snapshot", 3000);
    if (snapshot.type !== "snapshot") throw new Error("snapshot attendu");
    expect(snapshot.transcript).toEqual([]);
    await c.close();
  });

  it("supprime aussi une conversation qui n'est pas la conversation ouverte", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }, { id: "s2" }] });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "delete", sessionId: "s1" });
    const after = await nextSessions(c, 1);
    // La conversation OUVERTE disparaît, l'autre reste : aucun état fantôme.
    expect(after.sessions.map((s) => s.id)).toEqual(["s2"]);
    await c.close();
  });

  it("cible inconnue ⇒ trame `error` franche, la liste ne bouge pas", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }] });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "delete", sessionId: "inconnue" });
    const error = await c.waitFor((f) => f.type === "error", 3000);
    if (error.type !== "error") throw new Error("erreur attendue");
    const failure = error as ErrorFrame;
    expect(failure.code).toBe("PI_SESSION_ERROR");
    expect(failure.message).toContain("introuvable");
    expect(h.host.deletedIds.has("inconnue")).toBe(false);
    await c.close();
  });
});

describe("WS — compaction forcée", () => {
  it("relaie la progression (passe mémoire → compaction) PUIS le compte rendu", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }] });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "compact", sessionId: "s1", requestId: "req-1" });
    const done = await c.waitFor((f) => f.type === "compact_done", 3000);
    if (done.type !== "compact_done") throw new Error("compact_done attendu");
    const outcome = done as CompactDone;
    expect(outcome.requestId).toBe("req-1");
    expect(outcome.memory.ran).toBe(true);
    expect(outcome.tokensBefore).toBe(4000);
    expect(outcome.tokensAfter).toBe(800);
    expect(h.host.compactedIds).toEqual(["s1"]);

    // ORDRE : la progression de la PASSE DE MÉMOIRE précède celle de la compaction.
    const progress = c.frames
      .filter((f): f is CompactProgress => f.type === "compact_progress")
      .map((f) => f.phase);
    expect(progress).toEqual(["memory", "compact"]);
    // Une seule compaction par demande.
    expect(c.frames.filter((f) => f.type === "compact_done")).toHaveLength(1);
    await c.close();
  });

  it("échec ⇒ trame `error` CORRÉLÉE (requestId), aucun `compact_done`", async () => {
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }] });
    harnesses.push(h);
    h.host.failNextCompact("Conversation trop courte : il n'y a pas assez d'échanges à résumer.");
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "compact", sessionId: "s1", requestId: "req-2" });
    const error = await c.waitFor((f) => f.type === "error", 3000);
    if (error.type !== "error") throw new Error("erreur attendue");
    const failure = error as ErrorFrame;
    expect(failure.requestId).toBe("req-2");
    expect(failure.message).toContain("trop courte");
    expect(c.frames.filter((f) => f.type === "compact_done")).toHaveLength(0);
    await c.close();
  });
});
