/**
 * Suivi des CONSULTATIONS de workflow (`WorkflowConsultationTracker`).
 *
 * ⚠️ Ce module ne sert QU'À COMPTER des faits observés : « pour cette génération,
 * le style avait-il été consulté avant ? ». Aucun taux n'est fabriqué ici — le
 * taux réel n'est observable qu'en production (journaux). Ce que ce fichier
 * prouve : le compte est PAR CONVERSATION (les outils sont partagés entre les
 * fils), et la mémoire reste BORNÉE.
 */

import { describe, expect, it } from "vitest";

import { MAX_TRACKED_SESSIONS, WorkflowConsultationTracker } from "../../src/comfy/index.js";

describe("suivi des consultations", () => {
  it("compte par conversation : une consultation ne vaut pas pour un autre fil", () => {
    const tracker = new WorkflowConsultationTracker();
    tracker.markConsulted("conv-1", "manga");

    expect(tracker.observe("conv-1", "manga")).toEqual({
      consultedBefore: true,
      generations: 1,
      consultedBeforeCount: 1,
      sessions: 1,
    });
    // Même workflow, AUTRE conversation : non consulté.
    expect(tracker.observe("conv-2", "manga")).toEqual({
      consultedBefore: false,
      generations: 2,
      consultedBeforeCount: 1,
      sessions: 2,
    });
  });

  it("un workflow consulté ne vaut pas pour un autre workflow", () => {
    const tracker = new WorkflowConsultationTracker();
    tracker.markConsulted("conv-1", "manga");
    expect(tracker.observe("conv-1", "realiste").consultedBefore).toBe(false);
  });

  it("sans identifiant de conversation, il reste une clé stable (jamais perdu)", () => {
    const tracker = new WorkflowConsultationTracker();
    tracker.markConsulted(undefined, "manga");
    expect(tracker.observe(undefined, "manga").consultedBefore).toBe(true);
  });

  it("borne la mémoire : au-delà du plafond, la plus ancienne conversation est oubliée", () => {
    const tracker = new WorkflowConsultationTracker({ maxSessions: 2 });
    tracker.markConsulted("a", "manga");
    tracker.markConsulted("b", "manga");
    expect(tracker.stats().sessions).toBe(2);
    tracker.markConsulted("c", "manga");
    expect(tracker.stats().sessions).toBe(2);
    // « a » a été évincée : sa consultation n'est plus connue (compteurs, eux, gardés).
    expect(tracker.wasConsulted("a", "manga")).toBe(false);
    expect(tracker.wasConsulted("c", "manga")).toBe(true);
  });

  it("expose des COMPTES, jamais un taux inventé", () => {
    const tracker = new WorkflowConsultationTracker();
    tracker.markConsulted("conv-1", "manga");
    tracker.observe("conv-1", "manga");
    tracker.observe("conv-1", "manga");
    const stats = tracker.stats();
    // Une consultation couvre les générations SUIVANTES du même fil : les deux
    // générations comptent comme « consulté avant ».
    expect(stats).toEqual({ generations: 2, consultedBeforeCount: 2, sessions: 1 });
    expect(Object.keys(stats)).not.toContain("ratio");
    expect(MAX_TRACKED_SESSIONS).toBeGreaterThan(1);
  });
});
