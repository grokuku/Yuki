/**
 * Transport WS — affichage d'une IMAGE GÉNÉRÉE (ComfyUI) dans la conversation.
 *
 * Vérifie le caractère ÉPHÉMÈRE de la trame (CONTRÔLE : aucun `seq` consommé,
 * jamais dans le rejeu ni le snapshot), le ROUTAGE vers la SEULE conversation
 * demandeuse, et le fait que le chemin transporté reste SAME-ORIGIN
 * (`/images/<id>.<ext>`) : la CSP n'est jamais élargie. Le rendu DOM (`<img>`) et
 * le fait que Yuki reçoive l'image sont couverts par `tests/ui/image-block.test.ts`
 * et `tests/pi/image-tool.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  ComfyImageFinalPromptView,
  ComfyImageView,
  ImagesGatewayPort,
} from "../../../src/comfy/index.js";
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

class FakeImagesPort implements ImagesGatewayPort {
  private readonly listeners = new Set<(view: ComfyImageView) => void>();
  private readonly ficheListeners = new Set<(view: ComfyImageFinalPromptView) => void>();

  /** Images CONSERVÉES d'une conversation (restauration après rechargement). */
  restored: ComfyImageView[] = [];

  /** `false` ⇒ ne sait pas restaurer (comportement d'un transport plus ancien). */
  constructor(private readonly canRestore = true) {}

  subscribeImages(listener: (view: ComfyImageView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeImageFinalPrompts(listener: (view: ComfyImageFinalPromptView) => void): () => void {
    this.ficheListeners.add(listener);
    return () => {
      this.ficheListeners.delete(listener);
    };
  }

  imagesForSession?(sessionId: string): ComfyImageView[] {
    if (!this.canRestore) return [];
    return this.restored.filter((item) => item.sessionId === sessionId);
  }

  emit(view: ComfyImageView): void {
    for (const listener of [...this.listeners]) listener(view);
  }

  emitFiche(view: ComfyImageFinalPromptView): void {
    for (const listener of [...this.ficheListeners]) listener(view);
  }
}

const ID = "a".repeat(32);

function view(overrides: Partial<ComfyImageView> = {}): ComfyImageView {
  return {
    id: ID,
    imageSrc: `/images/${ID}.png`,
    mimeType: "image/png",
    width: 1024,
    height: 768,
    bytes: 512 * 1024,
    createdAt: "2026-10-13T00:00:00.000Z",
    promptId: "prompt-1",
    sessionId: "sess-1",
    ...overrides,
  };
}

type ImageFrame = Extract<ServerFrame, { type: "image" }>;

describe("image générée — trame de contrôle", () => {
  it("pousse l'image vers la conversation sans consommer de `seq`", async () => {
    const port = new FakeImagesPort();
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");
    const seqAfterSnapshot = snapshot.seq;

    port.emit(view());
    const frame = (await c.waitFor((f) => f.type === "image")) as ImageFrame;

    expect(frame.image.imageSrc).toBe(`/images/${ID}.png`);
    // ⚠️ Chemin RELATIF : même origine, donc `img-src 'self'` suffit.
    expect(frame.image.imageSrc.startsWith("/")).toBe(true);
    expect(frame.image.width).toBe(1024);
    expect(frame.image.height).toBe(768);
    // Aucun octet d'image ne voyage dans la trame.
    expect(JSON.stringify(frame)).not.toContain("base64");
    expect(JSON.stringify(frame)).not.toContain("data:image");
    // Trame de CONTRÔLE : réutilise le `seq` courant, n'en consomme aucun.
    expect(frame.seq).toBe(seqAfterSnapshot);
    expect(frame.sessionId).toBe("sess-1");
  });

  it("ne diffuse QU'À la conversation concernée", async () => {
    const port = new FakeImagesPort();
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");

    port.emit(view({ sessionId: "une-autre-session" }));
    await delay(50);
    expect(c.frames.filter((f) => f.type === "image")).toHaveLength(0);
  });

  it("RESTAURE les images CONSERVÉES de la conversation juste après un snapshot", async () => {
    const port = new FakeImagesPort();
    port.restored = [
      view({ id: "c".repeat(32), imageSrc: `/images/${"c".repeat(32)}.png`, createdAt: "2026-10-14T00:00:00.000Z" }),
      view({ id: "d".repeat(32), imageSrc: `/images/${"d".repeat(32)}.png`, createdAt: "2026-10-15T00:00:00.000Z" }),
    ];
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");
    await delay(30);

    // ⚠️ Le snapshot est bien la VOIE de la restauration : les images arrivent
    // APRÈS lui, dans l'ordre CHRONOLOGIQUE, en trames de CONTRÔLE.
    const snapshotIndex = c.frames.findIndex((f) => f.type === "snapshot");
    const restoredFrames = c.frames.filter((f) => f.type === "image");
    expect(restoredFrames.map((f) => (f.type === "image" ? f.image.id : ""))).toEqual([
      "c".repeat(32),
      "d".repeat(32),
    ]);
    for (const frame of restoredFrames) {
      expect(c.frames.indexOf(frame)).toBeGreaterThan(snapshotIndex);
      // Aucun `seq` consommé : le compteur reste celui du snapshot.
      expect(frame.seq).toBe(snapshot.seq);
    }
  });

  it("n'entre NI dans le rejeu NI dans le snapshot (trame éphémère)", async () => {
    const port = new FakeImagesPort();
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    port.emit(view());
    await c.waitFor((f) => f.type === "image");

    const welcomeBefore = c.frames.filter((f) => f.type === "welcome").length;
    const framesBefore = c.frames.length;
    c.send({ type: "resume", sessionId: "sess-1", fromSeq: 0 });
    await c.waitFor(
      (f) =>
        f.type === "welcome" && c.frames.filter((x) => x.type === "welcome").length > welcomeBefore,
    );
    await delay(30);

    const replayed = c.frames.slice(framesBefore);
    expect(replayed.some((f) => f.type === "image")).toBe(false);
    expect(JSON.stringify(replayed)).not.toContain("/images/");
  });

  it("la FICHE (prompt final) arrive APRÈS l'image, en trame de contrôle", async () => {
    const port = new FakeImagesPort();
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");

    port.emit(view());
    await c.waitFor("image");
    port.emitFiche({
      id: ID,
      sessionId: "sess-1",
      finalPrompt: { nodeId: "1858", text: "focale 35 mm", totalChars: 13, truncated: false },
    });
    const fiche = await c.waitFor((f) => f.type === "image_final_prompt");
    expect(fiche.type === "image_final_prompt" ? fiche.id : "").toBe(ID);
    expect(fiche.type === "image_final_prompt" ? fiche.finalPrompt.text : "").toBe("focale 35 mm");
    // ⚠️ ORDRE : la fiche vient APRÈS l'image (elle est donc affichée SOUS elle).
    const imageIndex = c.frames.findIndex((f) => f.type === "image");
    const ficheIndex = c.frames.findIndex((f) => f.type === "image_final_prompt");
    expect(imageIndex).toBeGreaterThan(-1);
    expect(ficheIndex).toBeGreaterThan(imageIndex);
    expect(fiche.seq).toBe(snapshot.seq);
  });

  it("un port qui ne sait pas restaurer n'affiche rien (comportement d'avant)", async () => {
    const port = new FakeImagesPort(false);
    port.restored = [view()];
    const h = await startHarness({ images: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    await delay(30);
    expect(c.frames.filter((f) => f.type === "image")).toHaveLength(0);
  });

  it("sans port câblé, aucune trame `image` n'est jamais émise", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    await delay(30);
    expect(c.frames.filter((f) => f.type === "image")).toHaveLength(0);
  });
});
