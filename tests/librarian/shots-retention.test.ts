/**
 * Stockage des CAPTURES de pages web (libraire) — conservation et purge.
 *
 * ⚠️ Les captures n'étaient pas conservées : elles vivaient le temps d'une trame
 * de contrôle. Elles obéissent désormais à la MÊME règle que les pièces jointes
 * (`files.retentionDays`, voir `src/files/retention.ts`) :
 *  - lecture d'un expiré ⇒ ABSENT (404) et fichier supprimé ;
 *  - `purgeExpired()` au démarrage puis périodiquement ;
 *  - `list({ sessionId })` permet la RESTAURATION après rechargement.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DAY_MS } from "../../src/files/retention.js";
import { LibrarianShotsStore } from "../../src/librarian/shots.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-shots-"));
  dirs.push(dir);
  return dir;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function setup(days = 30, start = Date.UTC(2026, 0, 1)) {
  let current = start;
  const dir = join(tempDir(), "shots");
  const store = new LibrarianShotsStore({
    dir,
    now: () => current,
    retentionDays: () => days,
  });
  return {
    store,
    dir,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("capture de page web conservée", () => {
  it("enregistre l'image, sa page et sa conversation", () => {
    const { store } = setup();
    const record = store.save({
      data: PNG,
      mimeType: "image/png",
      pageUrl: "https://exemple.fr/article",
      sessionId: "conv-1",
    });
    expect(record).not.toBeNull();
    expect(existsSync(record!.file)).toBe(true);
    expect(record!.imageSrc).toMatch(/^\/captures\/[a-f0-9]{32}\.png$/);
    expect(record!.expiresAt).toBe(new Date(Date.UTC(2026, 0, 31)).toISOString());
    expect(store.read(record!.id, "png")?.mimeType).toBe("image/png");
    // La vue d'interface ne porte ni octet ni chemin absolu.
    const view = store.toView(record!);
    expect(view.host).toBe("exemple.fr");
    expect(view.sessionId).toBe("conv-1");
    // La vue porte l'EXPIRATION : l'interface peut dire la vérité sur la durée.
    expect(view.expiresAt).toBe(record!.expiresAt);
    expect(JSON.stringify(view)).not.toContain(PNG.toString("base64"));
  });

  it("se RETROUVE après rechargement (nouveau store, même répertoire)", () => {
    const { store, dir } = setup();
    const record = store.save({
      data: PNG,
      mimeType: "image/png",
      pageUrl: "https://exemple.fr/article",
      sessionId: "conv-1",
    })!;
    const reopened = new LibrarianShotsStore({
      dir,
      now: () => Date.UTC(2026, 0, 2),
      retentionDays: () => 30,
    });
    const listed = reopened.list({ sessionId: "conv-1" });
    expect(listed.map((item) => item.id)).toEqual([record.id]);
    expect(reopened.toView(listed[0]!).imageSrc).toBe(record.imageSrc);
    expect(reopened.list({ sessionId: "conv-2" })).toHaveLength(0);
  });
});

describe("rétention des captures (même règle que les pièces jointes)", () => {
  it("après 30 jours : ABSENTE à la lecture et supprimée", () => {
    const { store, advance } = setup();
    const record = store.save({
      data: PNG,
      mimeType: "image/png",
      pageUrl: "https://exemple.fr/",
      sessionId: "conv-1",
    })!;
    advance(30 * DAY_MS);
    expect(store.read(record.id, "png")).toBeNull();
    expect(existsSync(record.file)).toBe(false);
  });

  it("`purgeExpired()` supprime l'image ET les métadonnées", () => {
    const { store, dir, advance } = setup();
    const record = store.save({
      data: PNG,
      mimeType: "image/png",
      pageUrl: "https://exemple.fr/",
    })!;
    expect(store.purgeExpired()).toBe(0);
    expect(store.read(record.id, "png")).not.toBeNull();
    advance(31 * DAY_MS);
    expect(store.purgeExpired()).toBe(1);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
