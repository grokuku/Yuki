/**
 * Indicateur « message NON LU » — logique PURE (`public/ui/unread.js`) et
 * garde-fous STATIQUES des sources (`app.js`, `sessions-panel.js`, `styles.css`).
 *
 * Le comportement INTERACTIF (indicateur sur A quand on regarde B, extinction à
 * l'ouverture, coexistence « en cours »/« non lu », persistance au rechargement,
 * piège du rejeu) est prouvé en E2E (`_tools/e2e-multiplex.mjs`, Chromium headless).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_BADGE_COUNT,
  UNREAD_STORAGE_KEY,
  addUnread,
  clearUnread,
  composeConversationLabel,
  formatUnreadBadge,
  isUnreadTurn,
  normalizeCount,
  parseUnread,
  pruneUnread,
  serializeUnread,
  shouldMarkUnread,
  unreadLabel,
} from "../../public/ui/unread.js";

const read = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), "public", "ui", ...parts), "utf8");

describe("unread.js — ce qui compte comme « un message »", () => {
  it("compte la FIN d'un tour assistant (done/error), jamais un delta", () => {
    expect(isUnreadTurn({ type: "run_finished", reason: "done" })).toBe(true);
    expect(isUnreadTurn({ type: "run_finished", reason: "error" })).toBe(true);
    // Chaque morceau de texte : NON (sinon l'indicateur s'allume en continu).
    expect(isUnreadTurn({ type: "delta", channel: "content", text: "a" })).toBe(false);
    expect(isUnreadTurn({ type: "run_started" })).toBe(false);
    // Activité de fond : non (ce n'est pas un message).
    expect(isUnreadTurn({ type: "job_started" })).toBe(false);
    expect(isUnreadTurn({ type: "job_finished" })).toBe(false);
    // Interruption/remplacement : ce n'est pas un message livré.
    expect(isUnreadTurn({ type: "run_finished", reason: "abort" })).toBe(false);
    expect(isUnreadTurn({ type: "run_finished", reason: "superseded" })).toBe(false);
    expect(isUnreadTurn(null)).toBe(false);
    expect(isUnreadTurn("run_finished")).toBe(false);
  });
});

describe("unread.js — GARDE ANTI-REJEU (piège n°1)", () => {
  it("n'incrémente PAS si le `seq` de la trame n'avance pas (rejeu/duplicata)", () => {
    const store = { lastSeq: 12 };
    // Une trame rejouée porte un `seq` déjà appliqué ⇒ ignorée.
    expect(shouldMarkUnread(store, { type: "run_finished", reason: "done", seq: 12 })).toBe(false);
    expect(shouldMarkUnread(store, { type: "run_finished", reason: "done", seq: 7 })).toBe(false);
  });

  it("incrémente pour une trame STRICTEMENT nouvelle", () => {
    const store = { lastSeq: 12 };
    expect(shouldMarkUnread(store, { type: "run_finished", reason: "done", seq: 13 })).toBe(true);
  });

  it("n'incrémente jamais pour une trame sans `seq` de fin de tour", () => {
    const store = { lastSeq: 12 };
    expect(shouldMarkUnread(store, { type: "delta", text: "x", seq: 13 })).toBe(false);
  });
});

describe("unread.js — compteur et libellés (accessibilité)", () => {
  it("borne la pastille à « 9+ » mais garde le compte exact dans le libellé", () => {
    expect(formatUnreadBadge(0)).toBe("");
    expect(formatUnreadBadge(1)).toBe("1");
    expect(formatUnreadBadge(MAX_BADGE_COUNT)).toBe("9");
    expect(formatUnreadBadge(MAX_BADGE_COUNT + 1)).toBe("9+");
    expect(formatUnreadBadge(150)).toBe("9+");
  });

  it("normalise les compteurs (jamais négatif, jamais NaN)", () => {
    expect(normalizeCount(-3)).toBe(0);
    expect(normalizeCount(0)).toBe(0);
    expect(normalizeCount(2.9)).toBe(2);
    expect(normalizeCount("4")).toBe(4);
    expect(normalizeCount(undefined)).toBe(0);
    expect(normalizeCount("pas un nombre")).toBe(0);
  });

  it("libellé français au pluriel correct", () => {
    expect(unreadLabel(0)).toBe("");
    expect(unreadLabel(1)).toBe("1 message non lu");
    expect(unreadLabel(3)).toBe("3 messages non lus");
  });

  it("compose un libellé qui DIT les deux états (en cours + non lu) sans les confondre", () => {
    expect(composeConversationLabel("Conversation A", {})).toBe("Conversation A");
    expect(composeConversationLabel("Conversation A", { busy: true })).toBe(
      "Conversation A — en cours",
    );
    expect(composeConversationLabel("Conversation A", { busy: true, unread: 2 })).toBe(
      "Conversation A — en cours — 2 messages non lus",
    );
  });
});

describe("unread.js — mutateurs purs + persistance tolérante", () => {
  it("ajoute, retire et purge sans muter l'entrée", () => {
    const base = { a: 1 };
    expect(addUnread(base, "b")).toEqual({ a: 1, b: 1 });
    expect(addUnread(base, "a", 2)).toEqual({ a: 3 });
    expect(base).toEqual({ a: 1 }); // entrée intacte
    expect(clearUnread(base, "a")).toEqual({});
    expect(clearUnread(base, "zzz")).toBe(base); // rien à retirer ⇒ même objet
    expect(pruneUnread({ a: 1, b: 2 }, ["a"])).toEqual({ a: 1 });
  });

  it("ne purge que si nécessaire (retourne le même objet sinon)", () => {
    const base = { a: 1, b: 2 };
    expect(pruneUnread(base, ["a", "b"])).toBe(base);
  });

  it("désérialise défensivement (JSON invalide, valeurs négatives ignorées)", () => {
    expect(parseUnread("")).toEqual({});
    expect(parseUnread("pas du json")).toEqual({});
    expect(parseUnread("[1,2]")).toEqual({});
    expect(parseUnread('{"a":2,"b":-1,"c":"x","":5}')).toEqual({ a: 2 });
    expect(parseUnread(undefined)).toEqual({});
  });

  it("sérialise un état propre", () => {
    expect(serializeUnread({ a: 2, b: 0, c: -1 })).toBe('{"a":2}');
    expect(serializeUnread(null)).toBe("{}");
  });
});

describe("sources — garde-fous statiques (CSP, câblage)", () => {
  it("app.js route « non lu » par conversation, après la garde anti-rejeu", () => {
    const app = read("app.js");
    expect(app).toContain("shouldMarkUnread(");
    expect(app).toMatch(/if \(unread\) markConversationUnread\(id\);/);
    expect(app).toContain("markConversationRead(");
    expect(app).toContain("UNREAD_STORAGE_KEY");
    // La conversation FOCALISÉE ne s'allume jamais.
    expect(app).toMatch(/id === sessionId\) return;/);
  });

  it("sessions-panel.js pose une pastille `.conv__unread` et sait l'éteindre", () => {
    const panel = read("sessions-panel.js");
    expect(panel).toContain("conv__unread");
    expect(panel).toContain("conv--unread");
    expect(panel).toContain("setUnread(");
    expect(panel).not.toContain("innerHTML");
  });

  it("styles.css distingue « non lu » (pastille compteur) de « en cours » (point animé)", () => {
    const css = read("styles.css");
    expect(css).toContain(".conv__unread");
    expect(css).toContain(".conv--unread .conv__unread");
    expect(css).toContain(".conv__busy");
    // La pastille non-lue n'est PAS animée (seul le point « en cours » pulse).
    expect(css).toMatch(/\.conv__unread \{[\s\S]*?var\(--danger\)/);
  });

  it("la clé de stockage est dédiée (pas de collision avec la barre)", () => {
    expect(UNREAD_STORAGE_KEY).toBe("yuki-unread");
  });
});
