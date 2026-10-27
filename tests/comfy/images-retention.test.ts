/**
 * Stockage des IMAGES GÉNÉRÉES — conservation et purge (rétention réelle).
 *
 * ⚠️ Ce que ce fichier prouve :
 *  - l'image est COPIÉE chez Yuki (elle survit à la purge du `temp/` de ComfyUI) ;
 *  - elle est gardée avec le MÊME réglage que les pièces jointes
 *    (`retentionDays`), et une horloge INJECTABLE rend la rétention testable ;
 *  - un expiré est SUPPRIMÉ à la première lecture (⇒ 404) et par `purgeExpired()`
 *    (PIÈGE ④ : une purge qui ne purge pas ne sert à rien) ;
 *  - `attach()` rattache l'image à sa conversation et `list()` la retrouve ⇒
 *    l'image survit au RECHARGEMENT (le transport la restaure depuis le snapshot).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GeneratedImagesStore, pngDimensions } from "../../src/comfy/images.js";
import { DAY_MS } from "../../src/files/retention.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** PNG 64×64 minimal (en-tête IHDR valide suffit aux dimensions). */
function png(size = 64): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(size, 16);
  header.writeUInt32BE(size, 20);
  return Buffer.concat([header, Buffer.from([0x00, 0x01, 0x02, 0x03])]);
}

interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

function clock(start = Date.UTC(2026, 0, 1)): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("conservation d'une image générée", () => {
  it("copie l'image sur disque et la sert en same-origin", () => {
    const time = clock();
    const store = new GeneratedImagesStore({
      dir: join(tempDir("yuki-images-"), "images"),
      now: time.now,
      retentionDays: () => 30,
    });
    const record = store.save({
      data: png(64),
      mimeType: "image/png",
      promptId: "prompt-1",
    });
    expect(record).not.toBeNull();
    // ⚠️ La COPIE existe sur le disque de Yuki : la purge du `temp/` de ComfyUI ne
    // peut plus emporter l'image.
    expect(existsSync(record!.file)).toBe(true);
    expect(record!.imageSrc).toMatch(/^\/images\/[a-f0-9]{32}\.png$/);
    expect(record!.expiresAt).toBe(
      new Date(time.now() + 30 * DAY_MS).toISOString(),
    );
    const read = store.read(record!.id, "png");
    expect(read?.bytes.byteLength).toBe(record!.bytes);
    expect(read?.mimeType).toBe("image/png");
    expect(pngDimensions(read!.bytes)).toEqual({ width: 64, height: 64 });
  });

  it("rattache à la conversation et la RETROUVE après rechargement", () => {
    const time = clock();
    const dir = join(tempDir("yuki-images-"), "images");
    const store = new GeneratedImagesStore({ dir, now: time.now, retentionDays: () => 30 });
    const record = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    store.attach(record.id, "conv-1");

    // ⚠️ NOUVEAU store sur le MÊME répertoire : c'est ce qui se passe au
    // REDÉMARRAGE du gateway. L'image doit toujours être là, rattachée au fil.
    const reopened = new GeneratedImagesStore({ dir, now: time.now, retentionDays: () => 30 });
    const listed = reopened.list({ sessionId: "conv-1" });
    expect(listed.map((item) => item.id)).toEqual([record.id]);
    expect(reopened.toView(listed[0]!).imageSrc).toBe(record.imageSrc);
    // Une AUTRE conversation ne la voit pas.
    expect(reopened.list({ sessionId: "conv-2" })).toHaveLength(0);
  });

  it("la FICHE (prompt final) est persistée avec l'image et revient dans la vue", () => {
    const time = clock();
    const dir = join(tempDir("yuki-images-"), "images");
    const store = new GeneratedImagesStore({ dir, now: time.now, retentionDays: () => 30 });
    const record = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    store.attach(record.id, "conv-1");
    store.attachFinalPrompt(record.id, {
      nodeId: "1858",
      text: "focale 35 mm, embruns",
      totalChars: 21,
      truncated: false,
    });

    const reopened = new GeneratedImagesStore({ dir, now: time.now, retentionDays: () => 30 });
    const view = reopened.toView(reopened.list({ sessionId: "conv-1" })[0]!);
    expect(view.finalPrompt?.text).toBe("focale 35 mm, embruns");
    expect(view.finalPrompt?.nodeId).toBe("1858");
  });
});

describe("rétention des images générées (même règle que les pièces jointes)", () => {
  it("après 30 jours : supprimée à la LECTURE (⇒ 404) et le fichier disparaît", () => {
    const time = clock();
    const store = new GeneratedImagesStore({
      dir: join(tempDir("yuki-images-"), "images"),
      now: time.now,
      retentionDays: () => 30,
    });
    const record = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    expect(store.read(record.id, "png")).not.toBeNull();

    time.advance(29 * DAY_MS);
    expect(store.read(record.id, "png")).not.toBeNull();

    time.advance(2 * DAY_MS);
    // ⚠️ Lire un expiré vaut 404, ET le fichier est supprimé dans la foulée.
    expect(store.read(record.id, "png")).toBeNull();
    expect(existsSync(record.file)).toBe(false);
  });

  it("`purgeExpired()` supprime l'image ET ses métadonnées (PIÈGE ④)", () => {
    const time = clock();
    const dir = join(tempDir("yuki-images-"), "images");
    const store = new GeneratedImagesStore({ dir, now: time.now, retentionDays: () => 30 });
    const record = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

    // Pas encore expiré : la purge ne touche à rien.
    expect(store.purgeExpired()).toBe(0);
    expect(store.read(record.id, "png")).not.toBeNull();

    time.advance(31 * DAY_MS);
    expect(store.purgeExpired()).toBe(1);
    // Il ne reste RIEN : ni octets, ni métadonnées.
    expect(readdirSync(dir)).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it("un réglage plus court s'applique aux DÉPÔTS SUIVANTS (jamais rétroactivement)", () => {
    const time = clock();
    let days = 30;
    const store = new GeneratedImagesStore({
      dir: join(tempDir("yuki-images-"), "images"),
      now: time.now,
      retentionDays: () => days,
    });
    const first = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    days = 7;
    const second = store.save({ data: png(), mimeType: "image/png", promptId: "p" })!;
    expect(first.expiresAt).toBe(new Date(time.now() + 30 * DAY_MS).toISOString());
    expect(second.expiresAt).toBe(new Date(time.now() + 7 * DAY_MS).toISOString());
    // On ne supprime pas « sous les pieds » ce qui est déjà là.
    time.advance(8 * DAY_MS);
    expect(store.purgeExpired()).toBe(1);
    expect(store.read(first.id, "png")).not.toBeNull();
    expect(store.read(second.id, "png")).toBeNull();
  });
});
