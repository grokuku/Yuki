/**
 * Garde-fous STATIQUES du layout multi-conversations.
 *
 * Les mesures de RENDU sont prouvées par `_tools/e2e-chat-sessions.mjs`
 * (Chromium headless + CDP). Ici, on verrouille les CONSTANTES de conception
 * (largeurs, durée d'animation, média étroit, styles CSP) pour qu'une
 * modification accidentelle du CSS ne passe pas inaperçue.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ui = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

describe("layout — barre latérale repliée/dépliée et fil pleine largeur", () => {
  const css = ui("styles.css");

  it("barre repliée 56 px, dépliée 280 px, animation 280 ms sur la LARGEUR", () => {
    expect(css).toContain("width: 56px");
    expect(css).toContain("width: 280px");
    expect(css).toContain("transition: width 280ms ease");
    // Dépliage piloté par le SEUL bouton (attribut `data-expanded`) :
    // plus d'ouverture au survol, plus de focus-within, plus de punaise.
    expect(css).toContain('.sidebar[data-expanded="true"]');
    expect(css).not.toContain(".sidebar:hover");
    expect(css).not.toContain(".sidebar:focus-within");
    expect(css).not.toContain("data-pinned");
    expect(css).not.toContain(".sidebar__pin");
  });

  it("le contenu interne a une largeur FIXE (pas de recomposition pendant l'animation)", () => {
    expect(css).toMatch(/\.sidebar__inner\s*\{[^}]*width:\s*280px/s);
  });

  it("fil pleine largeur : assistant 100 %, utilisateur 85 %", () => {
    expect(css).toMatch(/\.message--assistant\s*\{[^}]*width:\s*100%/s);
    expect(css).toMatch(/\.message--user\s*\{[^}]*width:\s*85%/s);
    // Plus AUCUNE borne de colonne de lecture ni centrage.
    expect(css).not.toContain("max-width: min(78%, 900px)");
  });

  it("état vide dans la même coquille (barre du haut + barre latérale)", () => {
    expect(css).toContain(".chat--empty .empty-state");
    expect(css).toContain(".chat--empty .composer");
    expect(css).toContain(".empty-state__logo");
  });

  it("fenêtre étroite : la barre se déplie PAR-DESSUS (média ≤ 640 px)", () => {
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.sidebar\s*\{[^}]*position:\s*absolute/s);
  });

  it("tableaux larges : défilement horizontal INTERNE à la bulle", () => {
    expect(css).toContain(".md-table-wrap");
    expect(css).toMatch(/\.md-table-wrap\s*\{[^}]*overflow-x:\s*auto/s);
    expect(ui("markdown.js")).toContain("md-table-wrap");
  });

  it("menu contextuel flottant stylé (aucune couleur en dur)", () => {
    expect(css).toContain(".ctx-menu");
    expect(css).toContain(".ctx-menu__item--danger");
    expect(css).toMatch(/\.ctx-menu\s*\{[^}]*position:\s*fixed/s);
  });
});

describe("app.js — câblage des conversations", () => {
  const app = ui("app.js");

  it("monte le panneau et route les trames de gestion", () => {
    expect(app).toContain("initSessionsPanel");
    expect(app).toContain('type === "sessions"');
    expect(app).toContain('type: "switch"');
    expect(app).toContain('type: "new"');
    expect(app).toContain('type: "rename"');
    expect(app).toContain('type: "setAside"');
  });

  it("gère l'état vide et n'envoie rien sans conversation ouverte", () => {
    expect(app).toContain("chat--empty");
    expect(app).toContain("setEmptyState");
    // Garde : pas de message tant qu'aucune conversation n'est ouverte.
    expect(app).toMatch(/if \(!sessionId\) return;/);
  });
});
