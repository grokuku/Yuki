/**
 * Panneau des conversations — logique PURE (titre, doublon, compteur, dates)
 * et garde-fous STATIQUES de la source (rendu DOM, aucune `innerHTML`, aucune
 * `window.confirm`, pas de « ⋯ »).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPACT_MENU_LABEL,
  DELETE_MENU_LABEL,
  RECAP_MENU_LABEL,
  conversationTitle,
  excerptFor,
  formatDate,
  formatHour,
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

  it("heure du menu téléphone : HH:mm aujourd'hui, date courte sinon", () => {
    const now = new Date("2026-10-23T15:00:00.000Z");
    expect(formatHour("2026-10-23T12:34:00.000Z", now)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatHour("2026-10-08T10:00:00.000Z", now)).toMatch(/oct/);
    expect(formatHour(undefined, now)).toBe("");
    expect(formatHour("pas une date", now)).toBe("");
  });

  it("aperçu borné, jamais une redite du titre", () => {
    expect(excerptFor({ excerpt: "Bonjour, question" }, "Autre titre")).toBe(
      "Bonjour, question",
    );
    // Extrait identique au titre (repli de `conversationTitle`) : rien à dire.
    expect(excerptFor({ excerpt: "Mon titre" }, "Mon titre")).toBe("");
    expect(excerptFor({}, "Mon titre")).toBe("");
    const long = excerptFor({ excerpt: "a".repeat(200) }, "Titre");
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);
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

  it("le menu du TITRE porte « Conversation dédiée… » et l'appui long tactile", () => {
    expect(RECAP_MENU_LABEL).toBe("Conversation dédiée…");
    expect(source).toContain("RECAP_MENU_LABEL");
    expect(source).toContain("onRecapDedicated");
    // Appui long partagé (tactile) ; le clic droit bureau reste câblé.
    expect(source).toContain("attachLongPress");
    expect(source).toContain("openMenu(info.id, item, point)");
  });

  it("« Mettre de côté » reste le déplacement récupérable", () => {
    expect(source).toContain("Mettre de côté");
    expect(source).toContain("conversations-supprimees");
  });

  it("« Supprimer » est une VRAIE suppression définitive, confirmée et nommée", () => {
    // Le bouton n'est plus grisé : le serveur sait effacer le fil.
    expect(DELETE_MENU_LABEL).toBe("Supprimer");
    expect(source).not.toContain("del.disabled = true");
    expect(source).toContain("DELETE_MENU_LABEL");
    // La confirmation NOMME la conversation et dit l'irréversibilité.
    expect(source).toContain("confirmDelete(id)");
    // ⚠️ La suppression est CONDITIONNÉE au résultat de la fenêtre : aucune
    // neutralisation « const confirmed = true » ne doit passer inaperçue.
    expect(source).toMatch(/const confirmed = await modal\.confirm\(\s*`Supprimer définitivement/);
    expect(source).not.toMatch(/const confirmed = true/);
    expect(source).toContain("aucune récupération possible");
    expect(source).toContain("Supprimer définitivement");
    // …et dit que la mémoire n'est PAS touchée (promesse exacte).
    expect(source).toContain("La mémoire durable n'est PAS touchée");
  });

  it("« Compacter… » est dans le MENU DU TITRE (bureau ET menu téléphone)", () => {
    expect(COMPACT_MENU_LABEL).toBe("Compacter…");
    expect(source).toContain("COMPACT_MENU_LABEL");
    expect(source).toContain("onCompact");
    // Le menu est construit UNE fois, rendu pour le rail ET le menu téléphone.
    expect(source).toContain("buildMenu()");
    expect(source).toContain("extraLists");
  });

  it("rend le MÊME contenu dans le menu téléphone (cible supplémentaire)", () => {
    expect(source).toContain("extraLists");
    expect(source).toContain("mnav-conv");
    expect(source).toContain("excerptFor");
    expect(source).toContain("formatHour");
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

  it("le BOUTON déplier/replier remplace la punaise et l'ouverture au survol", () => {
    expect(source).toContain("sidebar__toggle");
    expect(source).toContain('"aria-expanded"');
    expect(source).toContain("Déplier la barre latérale");
    expect(source).toContain("Replier la barre latérale");
    expect(source).toContain("data-expanded");
    // La punaise de BARRE a disparu (classe + libellé).
    expect(source).not.toContain("sidebar__pin");
    expect(source).not.toContain("Épingler la barre");
  });

  it("persiste l'état déplié en localStorage (clé dédiée, tolérante au mode privé)", () => {
    expect(source).toContain("SIDEBAR_EXPANDED_KEY");
    expect(source).toContain("yuki-sidebar-expanded");
    expect(source).toContain("localStorage");
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
