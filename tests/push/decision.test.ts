/**
 * Décision anti-spam « faut-il notifier ? » — FONCTION PURE.
 *
 * Chaque cas est couvert : client focalisé, en arrière-plan, plusieurs clients,
 * aucun client. C'est le cœur de la qualité (ne pas notifier pendant que
 * l'utilisateur lit).
 */

import { describe, expect, it } from "vitest";

import { isWatching, shouldNotify } from "../../src/push/decision.js";
import type { PresenceView } from "../../src/push/types.js";

const viewing = (sessionId: string | null): PresenceView => ({
  sessionId,
  visible: true,
  focused: true,
});

describe("shouldNotify — validations (fenêtre GLOBALE)", () => {
  it("notifie quand AUCUN client n'est connecté", () => {
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, [])).toBe(true);
  });

  it("SUPPRIME la notification dès qu'un client est visible ET focalisé (la fenêtre s'affiche déjà)", () => {
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, [viewing("s2")])).toBe(false);
  });

  it("notifie si le client est visible mais NON focalisé (fenêtre recouverte)", () => {
    const viewers: PresenceView[] = [{ sessionId: "s1", visible: true, focused: false }];
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, viewers)).toBe(true);
  });

  it("notifie si le client est focalisé mais NON visible (onglet en arrière-plan)", () => {
    const viewers: PresenceView[] = [{ sessionId: "s1", visible: false, focused: true }];
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, viewers)).toBe(true);
  });
});

describe("shouldNotify — fin de tâche / réponse prête (dans LEUR conversation)", () => {
  it("SUPPRIME si un client regarde la conversation concernée", () => {
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, [viewing("s1")])).toBe(false);
    expect(shouldNotify({ kind: "job_report", sessionId: "s1" }, [viewing("s1")])).toBe(false);
  });

  it("NOTIFIE si le client regarde une AUTRE conversation (fil d'arrière-plan)", () => {
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, [viewing("s2")])).toBe(true);
    expect(shouldNotify({ kind: "job_report", sessionId: "s1" }, [viewing("s2")])).toBe(true);
  });

  it("NOTIFIE si le client regarde la conversation mais n'est pas focalisé", () => {
    const viewers: PresenceView[] = [{ sessionId: "s1", visible: true, focused: false }];
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, viewers)).toBe(true);
  });

  it("NOTIFIE si aucun client n'est connecté", () => {
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, [])).toBe(true);
  });

  it("NOTIFIE quand la conversation est inconnue (on ne peut pas affirmer qu'elle est vue)", () => {
    expect(shouldNotify({ kind: "run_finished", sessionId: null }, [viewing("s1")])).toBe(true);
    expect(shouldNotify({ kind: "job_report" }, [viewing("s1")])).toBe(true);
  });
});

describe("shouldNotify — plusieurs clients", () => {
  it("un seul client qui regarde la conversation suffit à supprimer", () => {
    const viewers: PresenceView[] = [
      { sessionId: "s1", visible: false, focused: true },
      { sessionId: "s1", visible: true, focused: true },
      { sessionId: "autre", visible: true, focused: true },
    ];
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, viewers)).toBe(false);
  });

  it("des clients ACTIFS sur d'AUTRES conversations ne suppriment pas (fil non focalisé)", () => {
    const viewers: PresenceView[] = [
      { sessionId: "s2", visible: true, focused: true },
      { sessionId: "s3", visible: true, focused: true },
    ];
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, viewers)).toBe(true);
  });

  it("un client ACTIF annule une validation même si un autre est inactif sur la même conversation", () => {
    const viewers: PresenceView[] = [
      { sessionId: "s1", visible: true, focused: false },
      { sessionId: "s1", visible: true, focused: true },
    ];
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, viewers)).toBe(false);
  });

  it("« connecté » ≠ « regarde » : un client non visibles ne supprime jamais", () => {
    const viewers: PresenceView[] = [
      { sessionId: "s1", visible: false, focused: false },
      { sessionId: "s1", visible: false, focused: false },
    ];
    expect(shouldNotify({ kind: "run_finished", sessionId: "s1" }, viewers)).toBe(true);
    expect(shouldNotify({ kind: "approval", sessionId: "s1" }, viewers)).toBe(true);
  });
});

describe("isWatching", () => {
  it("exige les DEUX signaux et la bonne conversation", () => {
    expect(isWatching(viewing("s1"), "s1")).toBe(true);
    expect(isWatching({ sessionId: "s1", visible: true, focused: false }, "s1")).toBe(false);
    expect(isWatching({ sessionId: "s1", visible: false, focused: true }, "s1")).toBe(false);
    expect(isWatching(viewing("s2"), "s1")).toBe(false);
    expect(isWatching(viewing(null), null)).toBe(false);
    expect(isWatching(viewing(""), "")).toBe(false);
  });
});
