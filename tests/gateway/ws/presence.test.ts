/**
 * Présence client (trame `presence`) : l'état déclaré alimente la décision
 * anti-spam des notifications via `Transport.presenceView()`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseClientMessage } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

describe("parseClientMessage — trame presence", () => {
  it("accepte deux booléens", () => {
    const parsed = parseClientMessage('{"type":"presence","visible":true,"focused":false}');
    expect(parsed).toEqual({
      ok: true,
      message: { type: "presence", visible: true, focused: false },
    });
  });

  it("refuse des drapeaux non booléens", () => {
    expect(parseClientMessage('{"type":"presence","visible":"oui","focused":false}').ok).toBe(false);
    expect(parseClientMessage('{"type":"presence","visible":true}').ok).toBe(false);
  });
});

describe("Transport.presenceView", () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness({ sessionId: "sess-1" });
  });
  afterAll(async () => {
    await harness.close();
  });

  it("part d'une présence CONSERVATRICE (ni visible ni focalisée) et suit les mises à jour", async () => {
    const client = await TestClient.connect(harness.url);
    client.send({ type: "hello", clientVersion: "test" });
    await client.waitFor("snapshot");

    const initial = harness.transport.presenceView?.() ?? [];
    expect(initial.length).toBe(1);
    expect(initial[0]).toMatchObject({ sessionId: "sess-1", visible: false, focused: false });

    client.send({ type: "presence", visible: true, focused: true });
    await viWaitFor(() => harness.transport.presenceView?.()[0]?.visible === true);
    expect(harness.transport.presenceView?.()[0]).toMatchObject({ visible: true, focused: true });

    client.send({ type: "presence", visible: false, focused: true });
    await viWaitFor(() => harness.transport.presenceView?.()[0]?.visible === false);
    expect(harness.transport.presenceView?.()[0]).toMatchObject({ visible: false, focused: true });

    await client.close();
    await viWaitFor(() => (harness.transport.presenceView?.() ?? []).length === 0);
  });
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition non atteinte");
}
