/**
 * WS — un modèle DÉCLARÉ SANS VISION ne reçoit pas d'image (et on le DIT).
 *
 * ⚠️ Le silence à éviter : sans `"image"` dans `input` (`models.json`, produit par
 * `/config` `llm.light.vision`), le SDK REMPLACE la pièce jointe par
 * « (tool image omitted: model does not support images) ». L'utilisateur aurait
 * « envoyé » son image et le modèle n'en aurait rien vu — sans un mot.
 *
 * Ces tests ÉCHOUENT sur le code d'origine : le transport n'avait aucune notion
 * de capacité de vision (`vision` n'existe pas dans ses dépendances et une image
 * partait toujours).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesService } from "../../../src/files/service.js";
import { FilesStore } from "../../../src/files/store.js";
import type { SendOptions } from "../../../src/pi/types.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

/** PNG 1×1 réel (70 octets). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const harnesses: Harness[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of harnesses.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeService(): FilesService {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ws-vision-"));
  dirs.push(dir);
  const store = new FilesStore({ dir, maxBytes: () => 1_000_000 });
  store.ensureLayout();
  return new FilesService({
    store,
    promptChars: () => 400,
    promptTotalChars: () => 800,
  });
}

async function connect(h: Harness): Promise<TestClient> {
  const client = await TestClient.connect(h.url);
  clients.push(client);
  client.send({ type: "hello" });
  await client.waitFor("welcome");
  return client;
}

function spySends(h: Harness): Array<{ text: string; opts?: SendOptions }> {
  const calls: Array<{ text: string; opts?: SendOptions }> = [];
  const original = h.host.send.bind(h.host);
  h.host.send = ((sessionId: string, text: string, opts?: SendOptions) => {
    calls.push({ text, ...(opts !== undefined ? { opts } : {}) });
    return original(sessionId, text, opts);
  }) as typeof h.host.send;
  return calls;
}

describe("WS — capacité vision de la conversation", () => {
  it("refuse une image quand le modèle est déclaré sans vision (aucun envoi)", async () => {
    const service = makeService();
    const stored = await service.saveUpload(
      (async function* () {
        yield new Uint8Array(PNG);
      })(),
      { name: "capture.png", mimeType: "image/png", origin: "user" },
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const h = await startHarness({
      files: service,
      vision: { conversationReceivesImages: () => false },
    });
    harnesses.push(h);
    const sends = spySends(h);
    const client = await connect(h);

    client.send({
      type: "message",
      clientMsgId: "m1",
      text: "regarde",
      files: [stored.file.id],
    });

    const error = (await client.waitFor(
      (frame) => frame.type === "error" && frame.code === "file_image_vision_disabled",
    )) as Extract<ServerFrame, { type: "error" }>;
    // ⚠️ Le message dit le GESTE à faire (interface de configuration, jamais un
    // fichier à éditer à la main).
    expect(error.message).toContain("/config");
    expect(error.message).toContain("vision");
    // ⚠️ Rien n'est parti au modèle : pas d'image « envoyée » qui n'arrive nulle part.
    expect(sends).toHaveLength(0);
  });

  it("laisse passer un fichier TEXTE même quand la vision est déclarée absente", async () => {
    const service = makeService();
    const stored = await service.saveUpload(
      (async function* () {
        yield new Uint8Array(Buffer.from("bonjour"));
      })(),
      { name: "notes.txt", mimeType: "text/plain", origin: "user" },
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const h = await startHarness({
      files: service,
      vision: { conversationReceivesImages: () => false },
    });
    harnesses.push(h);
    const client = await connect(h);
    client.send({ type: "message", clientMsgId: "m1", text: "lis ça", files: [stored.file.id] });
    const started = await client.waitFor("run_started");
    expect(started.type).toBe("run_started");
  });

  it("capacité déclarée « oui » : l'image part comme avant (non-régression)", async () => {
    const service = makeService();
    const stored = await service.saveUpload(
      (async function* () {
        yield new Uint8Array(PNG);
      })(),
      { name: "capture.png", mimeType: "image/png", origin: "user" },
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    const h = await startHarness({
      files: service,
      vision: { conversationReceivesImages: () => true },
    });
    harnesses.push(h);
    const sends = spySends(h);
    const client = await connect(h);
    client.send({ type: "message", clientMsgId: "m1", text: "regarde", files: [stored.file.id] });
    await client.waitFor("run_started");

    expect(sends).toHaveLength(1);
    expect(sends[0]?.opts?.images?.[0]?.mimeType).toBe("image/png");
  });
});
