/**
 * Politique d'OUTILS PAR MODE DE DISCUSSION (lot 18, lot 1).
 *
 * Exigence utilisateur (2026-11-01) : en mode distant, les AGENTS sont
 * désactivés par défaut (sécurité) — mais `generer_image` et l'ANALYSE D'IMAGE
 * restent disponibles.
 *
 * ⚠️ DEUX RÉGLAGES INDÉPENDANTS (2026-11-02, demande utilisateur) : `chat.remoteAgents`
 * (les MACHINES) et `chat.remoteTools` (image, libraire, archives) ne se commandent
 * plus ensemble. Ce que ce fichier verrouille :
 *  - mode local ⇒ allowlist du rôle STRICTEMENT inchangée, quels que soient les
 *    deux réglages ;
 *  - distant + agents non + outils oui ⇒ image/libraire/archives, AUCUNE délégation ;
 *  - distant + agents non + outils non ⇒ SOCLE `toujours` seulement (lister/lire
 *    une pièce jointe, publier, envoyer un fichier déjà rattaché) ;
 *  - distant + agents oui + outils non ⇒ délégation, AUCUNE image ;
 *  - distant + les deux oui ⇒ politique du rôle léger, PLUS le socle, MOINS les
 *    outils qui exigent une approbation humaine (impossible à donner depuis un canal) ;
 *  - le rôle lourd n'a RIEN (aucun run lourd ne naît d'un canal).
 *
 * ⚠️ Échoue sur le code d'origine : `remoteTools` n'existe pas, donc « agents non +
 * outils oui » rendait `generer_image` ET l'absence de `delegate` seulement par
 * accident de l'ancienne liste unique (et « agents oui + outils non » rendait
 * quand même l'image).
 */

import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUIRED_TOOLS,
  FORBIDDEN_TOOLS,
  REMOTE_ALWAYS_TOOLS,
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
      for (const remoteAgents of [true, false]) {
        for (const remoteTools of [true, false]) {
          expect(
            toolAllowlistForChat(role, FULL_OPTIONS, {
              chatMode: "local",
              remoteAgents,
              remoteTools,
            }),
          ).toEqual(toolAllowlist(role, FULL_OPTIONS));
        }
      }
    }
  });
});

describe("mode distant — les DEUX réglages, quatre combinaisons", () => {
  const politique = (remoteAgents: boolean, remoteTools: boolean): string[] =>
    toolAllowlistForChat("light", FULL_OPTIONS, {
      chatMode: "mattermost",
      remoteAgents,
      remoteTools,
    });

  it("agents NON + outils OUI ⇒ image/libraire/archives, AUCUNE délégation", () => {
    const light = politique(false, true);
    // Ce que le réglage « Outils distants » ouvre, et lui seul.
    for (const attendu of [
      "generer_image",
      "consulter_workflow",
      "recherche_libraire",
      "liste_libraire",
      "lire_libraire",
      "archive_libraire",
      "capture_libraire",
      "archive_vie_anterieure",
      "chercher_conversations_archivees",
    ]) {
      expect(light, attendu).toContain(attendu);
    }
    // Ce que le réglage « Agents distants » garde FERMÉ : tout ce qui atteint une
    // machine (ou son inventaire).
    for (const interdit of [
      "delegate",
      "job_status",
      "cancel_job",
      "steer_job",
      "lister_agents",
      "etat_agent",
      "lister_secrets",
      "run_command",
      "capturer_ecran",
      "recuperer_fichier",
      "deposer_fichier",
      "demander_secret",
      "read",
      "ls",
      "grep",
      "find",
    ]) {
      expect(light, interdit).not.toContain(interdit);
    }
    // Est exactement la réunion des deux groupes non réglés (`outils` + `toujours`).
    expect([...light].sort()).toEqual([...REMOTE_SAFE_TOOLS].sort());
  });

  it("agents NON + outils NON (le DÉFAUT) ⇒ le SOCLE seulement", () => {
    const light = politique(false, false);
    expect([...light].sort()).toEqual([...REMOTE_ALWAYS_TOOLS].sort());
    expect(light).not.toContain("generer_image");
    expect(light).not.toContain("delegate");
    // Le socle reste utilisable : sans lui, Yuki ne verrait plus une image jointe.
    for (const socle of ["lister_fichiers", "lire_fichier", "publier_dans_canal"]) {
      expect(light, socle).toContain(socle);
    }
  });

  it("agents OUI + outils NON ⇒ délégation, AUCUNE image", () => {
    const light = politique(true, false);
    expect(light).toContain("delegate");
    expect(light).toContain("lister_agents");
    expect(light).toContain("lister_secrets");
    // ⚠️ L'image appartient à l'AUTRE réglage : elle ne vient pas avec la délégation.
    expect(light).not.toContain("generer_image");
    expect(light).not.toContain("consulter_workflow");
    expect(light).not.toContain("recherche_libraire");
    // Le socle reste là, comme dans toutes les combinaisons.
    for (const socle of REMOTE_ALWAYS_TOOLS) expect(light, socle).toContain(socle);
  });

  it("agents OUI + outils OUI ⇒ politique du rôle, PLUS le socle, MOINS les approbations", () => {
    const light = politique(true, true);
    const attendu = toolAllowlist("light", FULL_OPTIONS);
    for (const nom of REMOTE_ALWAYS_TOOLS) {
      if (!attendu.includes(nom)) attendu.push(nom);
    }
    expect(light).toEqual(attendu.filter((tool: string) => !APPROVAL_REQUIRED_TOOLS.includes(tool)));
    // Et les deux familles sont bien là en même temps.
    expect(light).toEqual(expect.arrayContaining(["delegate", "generer_image"]));
    expect(light).not.toContain("demander_secret");
  });

  it("le worker LOURD n'expose RIEN, quelles que soient les deux valeurs", () => {
    // ⚠️ Décision : un run lourd né d'un canal laisserait ses validations
    // humaines dans une conversation que personne ne regarde. On ne le crée pas.
    for (const remoteAgents of [true, false]) {
      for (const remoteTools of [true, false]) {
        for (const chatMode of ["mattermost", "discord"] as const) {
          expect(
            toolAllowlistForChat("heavy", FULL_OPTIONS, { chatMode, remoteAgents, remoteTools }),
          ).toEqual([]);
        }
      }
    }
  });

  it("ne contient jamais un outil interdit (`write`, `edit`, `bash`…)", () => {
    for (const remoteAgents of [true, false]) {
      for (const remoteTools of [true, false]) {
        const light = politique(remoteAgents, remoteTools);
        expect(containsForbiddenTool(light)).toBe(false);
        for (const tool of FORBIDDEN_TOOLS) expect(light).not.toContain(tool);
      }
    }
  });
});
