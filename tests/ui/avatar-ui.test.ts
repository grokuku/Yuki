/**
 * AVATAR — garde-fous STATIQUES de l'interface.
 *
 * Les mesures de rendu sont prouvées par la campagne E2E (Chromium headless) ;
 * ici on verrouille les décisions de conception pour qu'une modification
 * accidentelle ne les efface pas :
 *   - A : `.empty-state__logo` affiche l'avatar, le flocon ❄️ reste le REPLI ;
 *   - B : `header .brand` porte l'avatar 24 px AVANT le nom, et il RESTE
 *     visible en téléphone (22 px) alors que le nom est masqué ;
 *   - ⚠️ AUCUN avatar dans les bulles (`.message__head`) ;
 *   - l'éditeur n'utilise NI `createObjectURL` (CSP `img-src 'self' data:`) NI
 *     `innerHTML` (XSS) NI `window.confirm` (HolafModal) ;
 *   - la CSP du gateway n'est pas élargie.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ui = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");
const src = (name: string): string =>
  readFileSync(join(process.cwd(), "src", "gateway", "routes", name), "utf8");

describe("A — état vide : l'avatar remplace le flocon, qui reste le repli", () => {
  const html = ui("index.html");

  it("le cercle de 76 px contient une image d'avatar ET le glyphe de repli", () => {
    expect(html).toMatch(
      /class="empty-state__logo"[\s\S]{0,400}?class="empty-state__glyphe"[\s\S]{0,400}?data-avatar-image/,
    );
    // L'image démarre MASQUÉE : sans avatar, le flocon est seul à l'écran.
    expect(html).toMatch(/id="empty-avatar"[^>]*hidden/);
  });

  it("le flocon est marqué comme REPLI et n'apparaît jamais en même temps", () => {
    expect(html).toContain('class="empty-state__glyphe" data-avatar-fallback');
    const source = ui("avatar.js");
    expect(source).toContain('querySelectorAll("[data-avatar-fallback]")');
    expect(source).toMatch(/el\.hidden = existe/);
  });

  it("le disque CLIPPE l'image (rien ne sort du cercle)", () => {
    const css = ui("styles.css");
    expect(css).toMatch(/\.empty-state__logo\s*\{[^}]*border-radius:\s*50%[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.avatar--logo\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s);
  });
});

describe("B — barre du haut : avatar 24 px avant le nom, visible en téléphone", () => {
  const html = ui("index.html");
  const css = ui("styles.css");

  it("le markup place l'avatar AVANT le nom « Yuki »", () => {
    expect(html).toMatch(
      /class="brand"[\s\S]{0,300}?id="brand-avatar"[\s\S]{0,300}?class="brand__name">Yuki/,
    );
    expect(html).toMatch(/id="brand-avatar"[^>]*class="avatar avatar--brand"/);
    expect(html).toMatch(/id="brand-avatar"[^>]*hidden/);
  });

  it("24 px en bureau, et le bloc n'est plus un simple texte", () => {
    expect(css).toMatch(/\.avatar--brand\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/s);
    expect(css).toMatch(/\.brand\s*\{[^}]*display:\s*flex/s);
  });

  it("en téléphone : nom masqué, avatar 22 px, marque révélée SEULEMENT avec un avatar", () => {
    const media = css.slice(css.indexOf("@media (max-width: 767px), (max-height: 480px)"));
    expect(media).toMatch(/\.brand__name\s*\{[^}]*display:\s*none/s);
    expect(media).toMatch(/body\.has-avatar \.brand\s*\{[^}]*display:\s*flex/s);
    expect(media).toMatch(/\.avatar--brand\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/s);
  });
});

describe("⚠️ aucun avatar dans les BULLES (garde de non-régression)", () => {
  it("l'éditeur et le câblage ne connaissent pas `.message__head`", () => {
    for (const fichier of ["avatar.js", "avatar-recadrage.js"]) {
      const source = ui(fichier);
      expect(source).not.toContain("message__head");
      expect(source).not.toContain("message--assistant");
    }
  });

  it("aucune règle CSS ne mêle un avatar à un message", () => {
    const css = ui("styles.css");
    const selecteurs = css.match(/[^{}]*\{/g) ?? [];
    for (const selecteur of selecteurs) {
      const bas = selecteur.toLowerCase();
      expect(bas.includes("avatar") && bas.includes(".message")).toBe(false);
    }
  });
});

describe("éditeur de recadrage : CSP stricte et géométrie pure", () => {
  const source = ui("avatar.js");
  const geometrie = ui("avatar-recadrage.js");

  it("sortie produite par `canvas.toBlob` (jamais un `blob:` dans une <img>)", () => {
    expect(source).toContain("toBlob");
    expect(source).toContain('"image/png"');
    expect(source).not.toContain("createObjectURL");
    expect(source).not.toContain("blob:");
    expect(source).toContain("TAILLE_SORTIE");
  });

  it("aucun innerHTML, aucun window.confirm (HolafModal partout)", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("window.confirm");
    expect(source).toContain("HolafModal.open");
    expect(source).toContain("HolafModal.confirm");
  });

  it("la géométrie est PURE (aucun DOM : testable sans navigateur)", () => {
    expect(geometrie).not.toContain("document.");
    expect(geometrie).not.toContain("window.");
    expect(geometrie).toContain("export function zoomer");
    expect(geometrie).toContain("export function deplacer");
    expect(geometrie).toContain("export function bornes");
    expect(geometrie).toContain("export function recadrer");
    expect(geometrie).toContain("export function dessiner");
    expect(geometrie).toContain("TAILLE_SORTIE = 512");
  });

  it("les trois gestes sont câblés : molette, pointeur, clavier", () => {
    expect(source).toContain('"wheel"');
    expect(source).toContain('"pointerdown"');
    expect(source).toContain('"pointermove"');
    expect(source).toContain('"keydown"');
    // Zoom borné et déplacement borné viennent du module pur.
    expect(source).toContain("zoomer");
    expect(source).toContain("deplacer");
    expect(source).toContain("recentrer");
  });
});

describe("réglage dans /config → Personnalité", () => {
  const panel = ui("personality-panel.js");
  const source = ui("avatar.js");

  it("la section Avatar est montée dans l'onglet Personnalité", () => {
    expect(panel).toContain('import { creerSectionAvatar } from "./avatar.js"');
    expect(panel).toContain("creerSectionAvatar({ HolafFetch, HolafModal })");
    expect(panel).toContain("avatarSection.element");
    expect(source).toContain('text: "Avatar"');
    expect(source).toContain('text: "Changer l\'avatar"');
    expect(source).toContain('text: "Retirer"');
  });

  it("« Retirer » passe par une CONFIRMATION HolafModal (jamais window.confirm)", () => {
    expect(source).toMatch(/HolafModal\.confirm\(/);
    expect(source).toContain('"Retirer l\'avatar"');
  });

  it("les écritures portent l'en-tête de garde", () => {
    expect(source).toContain('"x-yuki-config": "1"');
  });
});

describe("favicon et CSP inchangée", () => {
  it("`index.html` déclare le favicon et `app.js` initialise l'avatar", () => {
    const html = ui("index.html");
    expect(html).toContain('<link id="favicon" rel="icon" href="/favicon.ico" />');
    const app = ui("app.js");
    expect(app).toContain("initAvatar");
    expect(app).toContain('from "./avatar.js"');
  });

  it("le favicon suit l'avatar sans rechargement (`/favicon.ico?v=<sha>`)", () => {
    const source = ui("avatar.js");
    expect(source).toContain("/favicon.ico?v=");
    expect(source).toContain('document.getElementById("favicon")');
  });

  it("`img-src 'self' data:` est inchangé (aucun `blob:` ni origine distante)", () => {
    const staticRoute = src("static.ts");
    expect(staticRoute).toContain("img-src 'self' data:");
    expect(staticRoute).not.toContain("blob:");
    expect(staticRoute).not.toContain("img-src *");
  });
});
