/**
 * Route same-origin `/captures/<id>.<ext>` — service des captures de pages web.
 *
 * Prouve : un aller-retour stockage → service, la garde d'extension/identifiant
 * (aucune traversée), le 404 honnête et le refus des méthodes non-lecture.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibrarianShotsStore } from "../../src/librarian/shots.js";
import { handleCapturesRequest, isCapturesPath } from "../../src/gateway/routes/captures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeWith(): LibrarianShotsStore {
  const dir = mkdtempSync(join(tmpdir(), "yuki-captures-"));
  dirs.push(dir);
  return new LibrarianShotsStore({ dir });
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("captures de pages web — route same-origin", () => {
  it("sert l'image stockée avec le bon type et les en-têtes sûrs", () => {
    const store = storeWith();
    const record = store.save({ data: new Uint8Array(PNG), mimeType: "image/png", pageUrl: "https://example.com/" });
    expect(record).toBeTruthy();
    const response = handleCapturesRequest({
      method: "GET",
      path: record?.imageSrc ?? "",
      deps: { store },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-security-policy"]).toContain("img-src 'self' data:");
    expect(Buffer.isBuffer(response.body) && response.body.equals(PNG)).toBe(true);
  });

  it("404 sur identifiant inconnu, extension hors allowlist ou tentative de traversée", () => {
    const store = storeWith();
    const id = "a".repeat(32);
    expect(handleCapturesRequest({ method: "GET", path: `/captures/${id}.png`, deps: { store } }).status).toBe(404);
    expect(handleCapturesRequest({ method: "GET", path: `/captures/${id}.exe`, deps: { store } }).status).toBe(404);
    expect(handleCapturesRequest({ method: "GET", path: "/captures/..%2Fsecret.png", deps: { store } }).status).toBe(404);
    expect(handleCapturesRequest({ method: "GET", path: "/captures/nothex.png", deps: { store } }).status).toBe(404);
  });

  it("refuse les méthodes non-lecture (405) et ne réclame que `/captures/`", () => {
    const store = storeWith();
    expect(handleCapturesRequest({ method: "POST", path: "/captures/x.png", deps: { store } }).status).toBe(405);
    expect(isCapturesPath("/captures/abc.png")).toBe(true);
    expect(isCapturesPath("/api/config")).toBe(false);
  });
});
