/**
 * « COMPACTER… » — logique PURE et câblage de l'attente (aucun DOM réel).
 *
 * Ce que ce test prouve :
 *  - les libellés d'attente DISTINGUENT la passe de mémoire (avec sa partie) de
 *    la compaction (jamais un texte figé qui laisserait croire à un blocage) ;
 *  - le compte rendu dit ce qui s'est VRAIMENT passé (mémoire écrite / inactive
 *    / échouée) et donne les mesures du moteur ;
 *  - une seule compaction à la fois, trames corrélées par `requestId`, écran
 *    d'attente FERMÉ avant l'affichage du résultat ;
 *  - une trame étrangère n'est jamais consommée (elle appartient à un autre
 *    parcours).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  COMPACT_BUSY_LABEL,
  compactProgressLabel,
  createSessionActions,
  describeCompactOutcome,
  describeMemoryPass,
  formatTokens,
} from "../../public/ui/session-actions.js";

describe("libellés d'attente — la phase et la partie sont DITES", () => {
  it("passe de mémoire : partie en cours visible", () => {
    const label = compactProgressLabel("memory", 2, 3);
    expect(label).toContain("partie 2/3");
    expect(label).toContain("Passe de mémoire");
  });

  it("passe de mémoire sans partie connue : texte d'attente explicite", () => {
    expect(compactProgressLabel("memory")).toContain("Passe de mémoire en cours");
    expect(compactProgressLabel("memory", 0, 0)).toContain("Passe de mémoire en cours");
  });

  it("compaction : texte distinct (la passe est terminée)", () => {
    const label = compactProgressLabel("compact");
    expect(label).toContain("Compaction du fil en cours");
    expect(label).not.toContain("partie");
  });

  it("libellé initial : jamais vide", () => {
    expect(COMPACT_BUSY_LABEL.length).toBeGreaterThan(10);
  });
});

describe("compte rendu de la passe de mémoire — jamais un succès muet", () => {
  it("passe exécutée avec écritures : le détail est donné", () => {
    const text = describeMemoryPass({
      ran: true,
      added: 2,
      updated: 1,
      removed: 0,
      skipped: 0,
      chunks: 1,
    });
    expect(text).toContain("2 souvenir(s) ajouté(s)");
    expect(text).toContain("1 mis à jour");
    expect(text).toContain("1 appel(s) au modèle");
  });

  it("passe exécutée SANS écriture : dit explicitement qu'il n'y avait rien", () => {
    const text = describeMemoryPass({
      ran: true,
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      chunks: 2,
    });
    expect(text).toContain("aucun souvenir nouveau");
  });

  it("passe INACTIVE ou ÉCHOUÉE : distinguée d'un succès", () => {
    expect(
      describeMemoryPass({ ran: false, reason: "disabled", added: 0, updated: 0, removed: 0, skipped: 0, chunks: 0 }),
    ).toContain("désactivée");
    const failed = describeMemoryPass({
      ran: false,
      reason: "failed",
      error: "panne du modèle",
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      chunks: 0,
    });
    expect(failed).toContain("ÉCHOUÉE");
    expect(failed).toContain("panne du modèle");
    expect(failed).toContain("la compaction a quand même eu lieu");
  });
});

describe("compte rendu de la compaction — mesures du moteur, titre nommé", () => {
  it("nomme la conversation et donne l'avant/après en tokens", () => {
    const text = describeCompactOutcome({
      title: "Conversation POTAGER",
      tokensBefore: 12_000,
      tokensAfter: 2_500,
      memory: { ran: true, added: 1, updated: 0, removed: 0, skipped: 0, chunks: 1 },
    });
    expect(text).toContain("Conversation POTAGER");
    expect(text).toContain(formatTokens(12_000));
    expect(text).toContain(formatTokens(2_500));
    expect(text).toContain("avant");
    expect(text).toContain("après");
  });

  it("sans estimation après : ne prétend rien", () => {
    const text = describeCompactOutcome({
      title: "T",
      tokensBefore: 100,
      memory: { ran: false, reason: "disabled", added: 0, updated: 0, removed: 0, skipped: 0, chunks: 0 },
    });
    expect(text).toContain("estimation après non fournie");
  });

  it("après ≥ avant : ne prétend AUCUNE économie (deux estimations distinctes)", () => {
    const text = describeCompactOutcome({
      title: "T",
      tokensBefore: 2,
      tokensAfter: 34,
      memory: null,
    });
    expect(text).toContain("aucune économie constatée");
    expect(text).not.toContain("avant → ");
  });

  it("après < avant : la réduction constatée est dite", () => {
    const text = describeCompactOutcome({
      title: "T",
      tokensBefore: 40_000,
      tokensAfter: 3_000,
      memory: null,
    });
    expect(text).toContain("avant → ");
    expect(text).toContain("après");
  });

  it("titre absent : repli honnête, jamais « undefined »", () => {
    const text = describeCompactOutcome({ tokensBefore: 10, memory: null });
    expect(text).not.toContain("undefined");
    expect(text).toContain("cette conversation");
  });
});

interface ModalEvent {
  kind: string;
  label?: string;
  title?: string;
  message?: string;
}

/** Faux `HolafModal` : enregistre les fenêtres et permet de vérifier l'ordre. */
function fakeModal() {
  const events: ModalEvent[] = [];
  const modal = {
    events,
    busy(label: string) {
      events.push({ kind: "busy", label });
      return {
        set(next: string) {
          events.push({ kind: "busy:set", label: next });
        },
        close() {
          events.push({ kind: "busy:close" });
        },
      };
    },
    alert(title: string, message: string) {
      events.push({ kind: "alert", title, message });
      return Promise.resolve();
    },
  };
  return modal;
}

describe("câblage — trames corrélées, une compaction à la fois", () => {
  it("envoie la demande avec un requestId et ouvre l'attente", () => {
    const modal = fakeModal();
    const sent: Array<Record<string, unknown>> = [];
    const actions = createSessionActions({
      send: (payload: object) => {
        sent.push(payload as Record<string, unknown>);
        return true;
      },
      modal,
      now: () => 1000,
    });

    actions.request("sess-1");
    expect(sent).toEqual([{ type: "compact", sessionId: "sess-1", requestId: "compact-sess-1-1000-1" }]);
    expect(actions.isBusy()).toBe(true);
    // Une seconde demande pendant l'attente est IGNORÉE (jamais deux écrans).
    actions.request("sess-1");
    expect(sent).toHaveLength(1);
  });

  it("progression → met à jour l'attente ; résultat → ferme PUIS affiche", () => {
    const modal = fakeModal();
    const actions = createSessionActions({ send: () => true, modal, now: () => 1 });
    actions.request("s1");
    const requestId = "compact-s1-1-1";

    expect(
      actions.handleFrame({ type: "compact_progress", requestId, phase: "memory", part: 1, parts: 2 }),
    ).toBe(true);
    expect(
      actions.handleFrame({ type: "compact_progress", requestId, phase: "compact" }),
    ).toBe(true);
    expect(
      actions.handleFrame({
        type: "compact_done",
        requestId,
        title: "Ma conversation",
        tokensBefore: 4000,
        tokensAfter: 800,
        memory: { ran: true, added: 1, updated: 0, removed: 0, skipped: 0, chunks: 1 },
      }),
    ).toBe(true);

    const kinds = modal.events.map((event) => event.kind);
    // L'écran d'attente est FERMÉ avant l'affichage du résultat.
    expect(kinds.indexOf("busy:close")).toBeLessThan(kinds.indexOf("alert"));
    expect(kinds).toContain("busy:set");
    expect(actions.isBusy()).toBe(false);
    const alert = modal.events.find((event) => event.kind === "alert")!;
    expect(alert.message).toContain("Ma conversation");
  });

  it("échec → alerte dédiée, aucun succès affiché", () => {
    const modal = fakeModal();
    const actions = createSessionActions({ send: () => true, modal, now: () => 2 });
    actions.request("s1");
    actions.handleFrame({
      type: "error",
      requestId: "compact-s1-2-1",
      code: "PI_SESSION_ERROR",
      message: "Conversation vide ou trop courte : il n'y a rien à compacter.",
    });
    const alert = modal.events.find((event) => event.kind === "alert")!;
    expect(alert.title).toContain("échec");
    expect(alert.message).toContain("trop courte");
    expect(actions.isBusy()).toBe(false);
  });

  it("trame SANS notre requestId : non consommée (autre parcours)", () => {
    const modal = fakeModal();
    const actions = createSessionActions({ send: () => true, modal, now: () => 3 });
    actions.request("s1");
    expect(actions.handleFrame({ type: "compact_done", requestId: "autre" })).toBe(false);
    expect(actions.handleFrame({ type: "snapshot" })).toBe(false);
    expect(actions.isBusy()).toBe(true);
  });

  it("hors connexion : aucune attente fantôme, message honnête", () => {
    const modal = fakeModal();
    const actions = createSessionActions({ send: () => false, modal, now: () => 4 });
    actions.request("s1");
    expect(actions.isBusy()).toBe(false);
    const alert = modal.events.find((event) => event.kind === "alert")!;
    expect(alert.message).toContain("Non connecté au gateway");
  });
});

describe("garde-fous statiques de session-actions.js (CSP, pas de confirm natif)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "session-actions.js"), "utf8");

  it("aucune injection HTML, aucun window.confirm", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("window.confirm(");
  });

  it("réutilise l'attente existante de la brique (aucun second système)", () => {
    expect(source).toContain("modal.busy(");
    expect(source).toContain("modal.alert(");
  });

  it("ne dépend pas de Vitest ni d'un DOM au chargement", () => {
    expect(source).not.toContain("vitest");
    expect(vi.isMockFunction(describe)).toBe(false);
  });
});
