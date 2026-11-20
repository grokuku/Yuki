/**
 * POLITIQUE — une tâche DIFFÉRÉE a les MÊMES outils de vérification que la
 * conversation du bot (2026-11-16).
 *
 * ⚠️ LE DÉFAUT VERROUILLÉ : la tâche planifiée « relève les prix de ces trois
 * pages » s'est réveillée SANS `recherche_libraire` ni `lire_page_web`, donc elle
 * n'a rien pu vérifier et a rendu un rapport d'échec — en DEVINANT la cause. Un
 * run différé passe par le WORKER LOURD : `TOOL_POLICY.heavy.librarian` valait
 * `[]`.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `toolAllowlist("heavy", {
 * librarianEnabled: true })` n'y contient AUCUN outil du libraire.
 */

import { describe, expect, it } from "vitest";

import {
  LIBRARIAN_CAPTURE_TOOLS,
  LIBRARIAN_TOOLS,
  TOOL_POLICY,
  toolAllowlist,
  toolAllowlistForChat,
  type ToolAllowlistOptions,
} from "../../src/llm/tool-policy.js";

/** Les outils de VÉRIFICATION diagnostiqués (le libraire et la lecture d'une page). */
const VERIFICATION = ["recherche_libraire", "lire_page_web"];

function verificationDe(tools: readonly string[]): string[] {
  return VERIFICATION.filter((outil) => tools.includes(outil));
}

describe("politique — une tâche différée voit le libraire et la lecture web", () => {
  it("⚠️ LE TEST CENTRAL : capacités `web`+`libraire` ⇒ la tâche planifiée a les DEUX outils", () => {
    const deferred = toolAllowlist("heavy", {
      capacites: ["libraire", "web"],
      librarianEnabled: true,
    });
    expect(deferred).toContain("recherche_libraire");
    expect(deferred).toContain("lire_page_web");
    // Le groupe entier (recherche, bibliothèque, document, archivage) suit.
    for (const outil of LIBRARIAN_TOOLS) expect(deferred, outil).toContain(outil);
  });

  it("⚠️ conversation et tâche différée donnent le MÊME jeu d'outils de vérification", () => {
    const options: ToolAllowlistOptions = {
      capacites: ["libraire", "web"],
      librarianEnabled: true,
    };
    const conversation = toolAllowlistForChat("light", options, {
      chatMode: "local",
      remoteAgents: false,
      remoteTools: false,
    });
    const deferred = toolAllowlist("heavy", options);
    expect(verificationDe(deferred)).toEqual(verificationDe(conversation));
    expect(verificationDe(deferred)).toEqual(VERIFICATION);
  });

  it("⚠️ capacité retirée ⇒ l'outil DISPARAÎT de l'allowlist différée (même câblage)", () => {
    const options: ToolAllowlistOptions = { librarianEnabled: true };
    const avec = toolAllowlist("heavy", { ...options, capacites: ["libraire", "web"] });
    const sansLibraire = toolAllowlist("heavy", { ...options, capacites: ["web"] });
    const sansWeb = toolAllowlist("heavy", { ...options, capacites: ["libraire"] });
    const sansRien = toolAllowlist("heavy", { ...options, capacites: ["execution"] });
    expect(avec).toContain("recherche_libraire");
    expect(sansLibraire).not.toContain("recherche_libraire");
    expect(sansLibraire).toContain("lire_page_web");
    expect(sansWeb).not.toContain("lire_page_web");
    expect(sansWeb).toContain("recherche_libraire");
    expect(verificationDe(sansRien)).toEqual([]);
  });

  it("libraire NON configuré ⇒ aucun outil de vérification dans la tâche différée", () => {
    const deferred = toolAllowlist("heavy", { capacites: ["libraire", "web"] });
    expect(verificationDe(deferred)).toEqual([]);
  });

  it("⚠️ garde conservée : le rôle lourd n'a JAMAIS `capture_libraire`", () => {
    expect(TOOL_POLICY.heavy.librarianCapture).toEqual([]);
    const deferred = toolAllowlist("heavy", {
      capacites: ["libraire", "web"],
      librarianEnabled: true,
      librarianCaptureEnabled: true,
    });
    for (const outil of LIBRARIAN_CAPTURE_TOOLS) expect(deferred).not.toContain(outil);
  });

  it("⚠️ mémoire du bot : la capacité `memoire` ouvre les DEUX recherches d'archive", () => {
    const outils = toolAllowlist("heavy", {
      capacites: ["memoire"],
      heritageEnabled: true,
      conversationArchiveEnabled: true,
    });
    expect(outils).toContain("archive_vie_anterieure");
    expect(outils).toContain("chercher_conversations_archivees");
    // LECTURE SEULE : un run lourd n'écrit ni consigne ni fait.
    expect(outils).not.toContain("memoriser_consigne");
    expect(outils).not.toContain("ajouter_fait");
    // Sans la capacité, les archives ne sont pas annoncées.
    const sansMemoire = toolAllowlist("heavy", {
      capacites: ["execution"],
      heritageEnabled: true,
      conversationArchiveEnabled: true,
    });
    expect(sansMemoire).not.toContain("archive_vie_anterieure");
    expect(sansMemoire).not.toContain("chercher_conversations_archivees");
  });

  it("aucune régression : le libraire reste absent par défaut, dans les deux rôles", () => {
    expect(verificationDe(toolAllowlist("heavy"))).toEqual([]);
    expect(verificationDe(toolAllowlist("light"))).toEqual([]);
    // Et le lourd ne gagne AUCUN outil de conversation en chemin.
    const deferred = toolAllowlist("heavy", {
      capacites: ["libraire", "web"],
      librarianEnabled: true,
    });
    for (const interdit of ["delegate", "envoyer_message", "planifier_tache", "programmer_envoi"]) {
      expect(deferred, interdit).not.toContain(interdit);
    }
  });
});

