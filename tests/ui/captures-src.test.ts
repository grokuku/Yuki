/**
 * Chemin same-origin des captures (`/captures/<id>.png`) — compatible CSP.
 *
 * ⚠️ La CSP (inchangée) autorise `img-src 'self' data:` : le chemin RELATIF de
 * même origine des captures Libry est donc accepté par le garde-fou image du
 * markdown, sans aucun élargissement de CSP.
 */

import { describe, expect, it } from "vitest";

import { isSafeImageSrc } from "../../public/ui/markdown.js";

describe("captures servies en same-origin — garde image", () => {
  it("accepte le chemin relatif `/captures/...` (img-src 'self')", () => {
    expect(isSafeImageSrc("/captures/abc123.png")).toBe(true);
    expect(isSafeImageSrc("captures/abc123.png")).toBe(true);
  });

  it("refuse toujours une URL distante ou un protocole relatif", () => {
    expect(isSafeImageSrc("http://127.0.0.1/x.png")).toBe(false);
    expect(isSafeImageSrc("//evil.example/x.png")).toBe(false);
  });
});
