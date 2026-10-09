/**
 * Transport WS — affichage d'une CAPTURE D'ÉCRAN dans la conversation.
 *
 * Vérifie le caractère ÉPHÉMÈRE de l'image (trame de CONTRÔLE, aucun `seq`
 * consommé, jamais dans le rejeu ni le snapshot) et le ROUTAGE vers la SEULE
 * conversation demanderesse. Le rendu DOM (`<img>`) est vérifié en E2E.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { CapturedScreenshotView, ScreenshotGatewayPort } from "../../../src/agents/execution.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of harnesses.splice(0)) await h.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeScreenshotPort implements ScreenshotGatewayPort {
  private readonly listeners = new Set<(event: { kind: "captured"; screenshot: CapturedScreenshotView }) => void>();

  subscribeScreenshots(listener: (event: { kind: "captured"; screenshot: CapturedScreenshotView }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(screenshot: CapturedScreenshotView): void {
    for (const listener of [...this.listeners]) listener({ kind: "captured", screenshot });
  }
}

const DATA_URL = "data:image/jpeg;base64,QUJD";

function shot(overrides: Partial<CapturedScreenshotView> = {}): CapturedScreenshotView {
  return {
    agentId: "agent-a",
    agentName: "nuc00",
    sessionId: "sess-1",
    dataUrl: DATA_URL,
    format: "jpeg",
    width: 1280,
    height: 720,
    bytes: 140 * 1024,
    capturedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

type ScreenshotFrame = Extract<ServerFrame, { type: "screenshot" }>;

function countType(c: TestClient, type: ServerFrame["type"]): number {
  return c.frames.filter((f) => f.type === type).length;
}

describe("capture d'écran — trame de contrôle", () => {
  it("pousse l'image vers la conversation sans consommer de `seq`", async () => {
    const port = new FakeScreenshotPort();
    const h = await startHarness({ screenshots: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");
    const seqAfterSnapshot = snapshot.seq;

    port.emit(shot());
    const frame = (await c.waitFor(
      (f) => f.type === "screenshot",
    )) as ScreenshotFrame;

    expect(frame.screenshot.dataUrl).toBe(DATA_URL);
    expect(frame.screenshot.width).toBe(1280);
    expect(frame.screenshot.height).toBe(720);
    // Trame de CONTRÔLE : réutilise le `seq` courant, n'en consomme aucun.
    expect(frame.seq).toBe(seqAfterSnapshot);
    expect(frame.sessionId).toBe("sess-1");
  });

  it("ne diffuse QU'À la conversation concernée", async () => {
    const port = new FakeScreenshotPort();
    const h = await startHarness({ screenshots: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");

    port.emit(shot({ sessionId: "une-autre-session" }));
    await delay(50);
    expect(countType(c, "screenshot")).toBe(0);
  });

  it("n'entre NI dans le rejeu NI dans le snapshot", async () => {
    const port = new FakeScreenshotPort();
    const h = await startHarness({ screenshots: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    port.emit(shot());
    await c.waitFor((f) => f.type === "screenshot");
    expect(countType(c, "screenshot")).toBe(1);

    // Reconstruction complète du fil : le rejeu/snapshot ne doit RIEN contenir
    // de l'image (rien sur disque, rien dans le buffer de session).
    const welcomeBefore = countType(c, "welcome");
    const framesBefore = c.frames.length;
    c.send({ type: "resume", sessionId: "sess-1", fromSeq: 0 });
    await c.waitFor((f) => f.type === "welcome" && countType(c, "welcome") > welcomeBefore);
    await delay(30);

    const replayed = c.frames.slice(framesBefore);
    expect(replayed.some((f) => f.type === "screenshot")).toBe(false);
    expect(JSON.stringify(replayed)).not.toContain("data:image");
    expect(JSON.stringify(replayed)).not.toContain("QUJD");
  });
});
