/**
 * Politique d'OUTILS PAR MODE DE DISCUSSION (lot 18, lot 1).
 *
 * Exigence utilisateur (2026-11-01) : en mode distant, les AGENTS sont
 * désactivés par défaut (sécurité) — mais `generer_image` et l'ANALYSE D'IMAGE
 * restent disponibles.
 *
 * Ce que ce fichier verrouille :
 *  - mode local ⇒ allowlist du rôle STRICTEMENT inchangée ;
 *  - mode distant + agents désactivés ⇒ jeu FERMÉ : images + lecture/analyse
 *    d'image, RIEN d'autre (ni lecture disque, ni délégation, ni transfert, ni
 *    commande, ni secret) ;
 *  - mode distant + agents activés ⇒ politique du rôle léger, PLUS les outils
 *    sûrs (image/lecture) qu'elle ne porte pas, MOINS les outils qui exigent une
 *    approbation humaine (impossible à donner depuis un canal) — et le rôle lourd
 *    n'a RIEN (aucun run lourd ne naît d'un canal).
 *
 * ⚠️ Échoue sur le code d'origine : `toolAllowlistForChat` n'existe pas.
 */

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_TOOLS,
  REMOTE_SAFE_TOOLS,
  containsForbiddenTool,
  toolAllowlist,
  toolAllowlistForChat,
} from "../../src/llm/tool-policy.js";

const FULL_OPTIONS = {
  delegationEnabled: true,
  executionEnabled: true,
  screenshotsEnabled: true,
  directoryEnabled: true,
  secretsEnabled: true,
  secretRequestsEnabled: true,
  heritageEnabled: true,
  conversationArchiveEnabled: true,
  librarianEnabled: true,
  librarianCaptureEnabled: true,
  filesEnabled: true,
  fileTransferEnabled: true,
  fileListEnabled: true,
  fileReadEnabled: true,
  imagesEnabled: true,
};

describe("mode local — politique INCHANGÉE", () => {
  it("rend exactement `toolAllowlist(role, options)`", () => {
    for (const role of ["light", "heavy"] as const) {
      expect(toolAllowlistForChat(role, FULL_OPTIONS, { chatMode: "local", remoteAgents: false })).toEqual(
        toolAllowlist(role, FULL_OPTIONS),
      );
      expect(toolAllowlistForChat(role, FULL_OPTIONS, { chatMode: "local", remoteAgents: true })).toEqual(
        toolAllowlist(role, FULL_OPTIONS),
      );
    }
  });
});

describe("mode distant, agents DÉSACTIVÉS (défaut) — jeu fermé", () => {
  const light = toolAllowlistForChat("light", FULL_OPTIONS, {
    chatMode: "mattermost",
    remoteAgents: false,
  });

  it("garde la GÉNÉRATION et l'ANALYSE D'IMAGE (demande explicite)", () => {
    expect(light).toContain("generer_image");
    expect(light).toContain("consulter_workflow");
    expect(light).toContain("lire_fichier");
    expect(light).toContain("lister_fichiers");
  });

  it("n'expose AUCUNE délégation, AUCUN transfert, AUCUNE commande, AUCUN secret", () => {
    for (const tool of [
      "delegate",
      "job_status",
      "cancel_job",
      "steer_job",
      "recuperer_fichier",
      "deposer_fichier",
      "run_command",
      "capturer_ecran",
      "lister_agents",
      "etat_agent",
      "lister_secrets",
      "demander_secret",
      "archive_vie_anterieure",
      "chercher_conversations_archivees",
      "recherche_libraire",
      "capture_libraire",
    ]) {
      expect(light, tool).not.toContain(tool);
    }
  });

  it("n'expose AUCUN builtin de lecture disque (read/ls/grep/find)", () => {
    for (const builtin of ["read", "ls", "grep", "find"]) {
      expect(light).not.toContain(builtin);
    }
  });

  it("est exactement `REMOTE_SAFE_TOOLS` (aucun ajout silencieux)", () => {
    expect([...light].sort()).toEqual([...REMOTE_SAFE_TOOLS].sort());
  });

  it("le worker LOURD n'expose RIEN (sans délégation, aucun run lourd ne naît d'un canal)", () => {
    const heavy = toolAllowlistForChat("heavy", FULL_OPTIONS, {
      chatMode: "discord",
      remoteAgents: false,
    });
    expect(heavy).toEqual([]);
  });

  it("ne contient jamais un outil interdit (`write`, `edit`, `bash`…)", () => {
    expect(containsForbiddenTool(light)).toBe(false);
    for (const tool of FORBIDDEN_TOOLS) expect(light).not.toContain(tool);
  });
});

describe("mode distant, agents ACTIVÉS — politique du rôle, bornée par les approbations", () => {
  it("rend la politique locale du léger, PLUS les outils sûrs, MOINS ceux à approbation", () => {
    const light = toolAllowlistForChat("light", FULL_OPTIONS, {
      chatMode: "mattermost",
      remoteAgents: true,
    });
    // La délégation et les outils de consultation reviennent…
    expect(light).toContain("delegate");
    expect(light).toContain("lister_agents");
    expect(light).toContain("lister_secrets");
    expect(light).toContain("envoyer_fichier");
    // … les outils image/lecture du canal restent là (le léger local lit via
    // `envoyer_fichier`, un run distant n'a que `lire_fichier` pour voir une image)…
    for (const name of REMOTE_SAFE_TOOLS) expect(light).toContain(name);
    // … et AUCUN outil qui exige une approbation humaine n'est exposé : une
    // approbation s'affiche dans l'interface web, jamais dans un canal.
    expect(light).not.toContain("demander_secret");
    expect(containsForbiddenTool(light)).toBe(false);
  });

  it("le worker LOURD n'expose RIEN, même agents activés (aucun run lourd depuis un canal)", () => {
    // ⚠️ Décision : un run lourd né d'un canal laisserait ses validations
    // humaines dans une conversation que personne ne regarde. On ne le crée pas.
    expect(
      toolAllowlistForChat("heavy", FULL_OPTIONS, { chatMode: "mattermost", remoteAgents: true }),
    ).toEqual([]);
  });
});
