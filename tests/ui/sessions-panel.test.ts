/**
 * Panneau des conversations — logique PURE (titre, doublon, compteur, dates)
 * et garde-fous STATIQUES de la source (rendu DOM, aucune `innerHTML`, aucune
 * `window.confirm`, pas de « ⋯ »).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  conversationTitle,
  formatDate,
  formatMessageCount,
  initialsFor,
  isDuplicateTitle,
  normalizeTitle,
  UNTITLED,
} from "../../public/ui/sessions-panel.js";

describe("titre d'affichage — jamais vide, jamais « (no messages) »", () => {
  it("privilégie le titre serveur", () => {
    expect(conversationTitle({ id: "1", title: "Mon titre", excerpt: "autre chose" })).toBe(
      "Mon titre",
    );
  });

  it("repli sur l'extrait, tronqué proprement au-delà de 60 caractères", () => {
    const long = "a".repeat(120);
    const title = conversationTitle({ id: "1", excerpt: long });
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
    expect(conversationTitle({ id: "1", excerpt: "Court extrait" })).toBe("Court extrait");
  });

  it("repli final honnête quand rien n'est exploitable", () => {
    expect(conversationTitle({ id: "1" })).toBe(UNTITLED);
    expect(conversationTitle({ id: "1", title: "   ", excerpt: "" })).toBe(UNTITLED);
    expect(conversationTitle(undefined)).toBe(UNTITLED);
  });
});

describe("doublons de titre — REFUSÉS (insensible à la casse/espaces)", () => {
  const sessions = [
    { id: "a", title: "Espace de lecture" },
    { id: "b", title: "Thèmes V2" },
  ];

  it("détecte un doublon exact, insensible à la casse et aux espaces", () => {
    expect(isDuplicateTitle("Thèmes V2", sessions, "a")).toBe(true);
    expect(isDuplicateTitle("  thèmes   v2 ", sessions, "a")).toBe(true);
    expect(isDuplicateTitle("Autre", sessions, "a")).toBe(false);
  });

  it("ignore la conversation renommée elle-même et un titre vide", () => {
    expect(isDuplicateTitle("Thèmes V2", sessions, "b")).toBe(false);
    expect(isDuplicateTitle("", sessions, "a")).toBe(false);
    expect(isDuplicateTitle("   ", sessions, "a")).toBe(false);
  });
});

describe("formatage (compteur, initiales, date)", () => {
  it("compte les messages au pluriel correct, jamais négatif", () => {
    expect(formatMessageCount(0)).toBe("0 message");
    expect(formatMessageCount(1)).toBe("1 message");
    expect(formatMessageCount(2)).toBe("2 messages");
    expect(formatMessageCount(-3)).toBe("0 message");
    expect(formatMessageCount(undefined)).toBe("0 message");
  });

  it("dérive 1–2 initiales du titre", () => {
    expect(initialsFor("Espace de lecture")).toBe("ED");
    expect(initialsFor("Thèmes")).toBe("T");
    expect(initialsFor("")).toBe("?");
  });

  it("formate une date courte localisée, chaîne vide si inconnue", () => {
    const formatted = formatDate("2026-10-08T10:00:00.000Z");
    expect(formatted).toMatch(/\b8\b/);
    expect(formatted.toLowerCase()).toContain("oct");
    expect(formatDate(undefined)).toBe("");
    expect(formatDate("pas une date")).toBe("");
  });

  it("normalise un titre sur une seule ligne", () => {
    expect(normalizeTitle("  a\n b\tc ")).toBe("a b c");
    expect(normalizeTitle(undefined)).toBe("");
  });
});

describe("garde-fous statiques de sessions-panel.js (CSP, choix utilisateur)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "sessions-panel.js"), "utf8");

  it("construit le DOM sans injection HTML directe ni window.confirm", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("window.confirm(");
    expect(source).toContain("createElement");
  });

  it("n'expose PAS de bouton « trois points » (clic droit seul) mais un menu contextuel", () => {
    expect(source).not.toContain("conv__dots");
    expect(source).toContain("contextmenu");
    expect(source).toContain('class: "ctx-menu"');
  });

  it("réserve la place du titre par modèle (désactivé, lot suivant)", () => {
    expect(source).toContain("Titre généré par le modèle");
    expect(source).toContain("disabled = true");
  });

  it("la suppression passe par HolafModal et MET DE CÔTÉ (jamais détruire)", () => {
    expect(source).toContain("HolafModal");
    expect(source).toContain("conversations-supprimees");
    expect(source).toContain("récupérable à la main");
  });

  it("la punaise expose aria-pressed ET aria-expanded", () => {
    expect(source).toContain('"aria-pressed"');
    expect(source).toContain('"aria-expanded"');
    expect(source).toContain("data-pinned");
  });
});

describe("index.html — barre latérale et état vide présents, sans style inline", () => {
  const html = readFileSync(join(process.cwd(), "public", "ui", "index.html"), "utf8");

  it("porte l'<aside> des conversations et la zone de discussion", () => {
    expect(html).toContain('id="sessions-sidebar"');
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('id="chat"');
  });

  it("porte l'état vide (❄️ + Yuki + invitation honnête)", () => {
    expect(html).toContain('id="empty-state"');
    expect(html).toContain("❄️");
    expect(html).toContain("Ce n'est pas une erreur");
    expect(html).toContain('id="empty-new"');
  });

  it("n'introduit aucun style inline ni <svg> (CSP)", () => {
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("<svg");
  });
});
