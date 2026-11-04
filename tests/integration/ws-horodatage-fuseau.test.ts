/**
 * Intégration WS — FUSEAU DES HORODATAGES (`/config` → `ui.timeZone`).
 *
 * Trois garanties :
 *  1. `welcome` PORTE le fuseau : l'interface ne devine jamais celui du navigateur ;
 *  2. la trame `message` du navigateur n'impose plus rien : le préfixe STOCKÉ est
 *     daté dans le fuseau du RÉGLAGE (défaut `UTC`), même si le client envoie `tz` ;
 *  3. un changement de réglage est ANNONCÉ à chaud (`time_zone`), sans rechargement.
 *
 * ⚠️ ÉCHEC SUR L'ORIGINE (mesuré) : aucun `timeZone` dans `welcome`, et
 * `host.send` recevait `{ timezone: message.tz }` — le fuseau du navigateur.
 */

import { afterEach, describe, expect, it } from "vitest";

import { loadScript } from "../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const SIMPLE = loadScript("tests/fixtures/pi/simple-text.json");

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

describe("intégration WS — fuseau des horodatages", () => {
  it("`welcome` annonce UTC par défaut (aucun fuseau configuré)", async () => {
    harness = await startHarness({ scripts: [SIMPLE] });
    const client = await TestClient.connect(harness.url);
    clients.push(client);
    client.send({ type: "hello" });
    const welcome = await client.waitFor((frame) => frame.type === "welcome");
    expect(welcome.type === "welcome" && welcome.timeZone).toBe("UTC");
  });

  it("`welcome` annonce le fuseau RÉGLÉ", async () => {
    harness = await startHarness({
      scripts: [SIMPLE],
      timeZone: { current: () => "Europe/Paris" },
    });
    const client = await TestClient.connect(harness.url);
    clients.push(client);
    client.send({ type: "hello" });
    const welcome = await client.waitFor((frame) => frame.type === "welcome");
    expect(welcome.type === "welcome" && welcome.timeZone).toBe("Europe/Paris");
  });

  it("le préfixe stocké suit le RÉGLAGE, jamais le `tz` du navigateur", async () => {
    harness = await startHarness({ scripts: [SIMPLE] });
    const client = await connect(harness);

    client.send({
      type: "message",
      clientMsgId: "m1",
      text: "Bonjour",
      // ⚠️ Un client ancien envoie encore son fuseau : il est IGNORÉ.
      tz: "Asia/Tokyo",
    });
    await client.waitFor((frame) => frame.type === "run_finished");

    expect(harness.host.sentOptions).toHaveLength(1);
    expect(harness.host.sentOptions[0]?.timezone).toBe("UTC");
  });

  it("un changement de fuseau est ANNONCÉ à chaud (trame `time_zone`)", async () => {
    let fuseau = "UTC";
    harness = await startHarness({
      scripts: [SIMPLE],
      timeZone: { current: () => fuseau },
    });
    const client = await connect(harness);

    // Ce que fait `src/index.ts` à chaque changement du réglage.
    fuseau = "Europe/Paris";
    harness.transport.notifyTimeZone?.(fuseau);

    const frame = await client.waitFor((item) => item.type === "time_zone");
    expect(frame.type === "time_zone" && frame.timeZone).toBe("Europe/Paris");
  });
});
