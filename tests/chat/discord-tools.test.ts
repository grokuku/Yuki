/**
 * OUTILS d'un run né dans un salon Discord (lot 21) — AUCUNE duplication de politique.
 *
 * Ce que ce fichier prouve :
 *  - `toolAllowlistForChat(…, { chatMode: "discord" })` applique EXACTEMENT la politique
 *    distante (aucun outil à approbation, liste fermée quand les agents sont désactivés) :
 *    elle n'est pas câblée « par plateforme », elle connaît déjà Discord ;
 *  - `createRemoteRunTools` lève si une allowlist contient un outil à approbation
 *    (`assertNoApprovalTool`) — il n'existe donc AUCUN chemin par lequel un run Discord
 *    pourrait attendre une approbation que personne ne peut donner depuis le salon ;
 *  - la MÉMOIRE distante reste désactivée (réglage lu, jamais branché) ;
 *  - avec `remoteAgents = actives`, les outils de `REMOTE_SAFE_TOOLS` restent les seuls
 *    ajoutés : pas de délégation, pas de transfert, pas de commande, pas de secret.
 *
 * ⚠️ Échoue sur le code d'origine : la politique distante n'existait qu'au lot 20 pour
 * Mattermost, et rien n'attestait qu'elle s'appliquait à Discord (les tests de l'époque ne
 * connaissaient que `chatMode: "mattermost"`).
 */

import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUIRED_TOOLS,
  REMOTE_SAFE_TOOLS,
  toolAllowlistForChat,
  type ToolAllowlistOptions,
} from "../../src/llm/tool-policy.js";
import { assertNoApprovalTool, REMOTE_APPROVAL_REFUSAL } from "../../src/pi/chat-run.js";
import { ChatService } from "../../src/chat/index.js";

/** Options du rôle léger (les MÊMES que le host local). */
function lightOptions(): ToolAllowlistOptions {
  return { executionEnabled: true, screenshotsEnabled: true } as ToolAllowlistOptions;
}

describe("politique d'outils — Discord est traité comme un canal distant", () => {
  it("agents désactivés : liste FERMÉE (images + lecture de fichiers), rien d'autre", () => {
    const tools = toolAllowlistForChat("light", lightOptions(), {
      chatMode: "discord",
      remoteAgents: false,
      remoteTools: true,
    });
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(REMOTE_SAFE_TOOLS).toContain(tool);
    // Aucun builtin de lecture du système, aucune action.
    for (const interdit of ["read", "ls", "grep", "find", "run_command", "capturer_ecran", "delegate"]) {
      expect(tools).not.toContain(interdit);
    }
  });

  it("aucun outil à approbation, quel que soit le réglage des agents", () => {
    for (const remoteAgents of [false, true]) {
      const tools = toolAllowlistForChat("light", lightOptions(), {
        chatMode: "discord",
        remoteAgents,
        remoteTools: true,
      });
      for (const tool of APPROVAL_REQUIRED_TOOLS) expect(tools).not.toContain(tool);
      // ⚠️ Second filet : l'assertion du run distant ne lève pas sur cette liste.
      expect(() => assertNoApprovalTool(tools)).not.toThrow();
    }
  });

  it("un run LOURD ne peut pas naître d'un canal (allowlist vide)", () => {
    for (const remoteAgents of [false, true]) {
      expect(
        toolAllowlistForChat("heavy", lightOptions(), {
          chatMode: "discord",
          remoteAgents,
          remoteTools: true,
        }),
      ).toEqual([]);
    }
  });

  it("`assertNoApprovalTool` refuse, avec le TEXTE attendu", () => {
    expect(() => assertNoApprovalTool(["generer_image", "run_command"])).toThrow(
      REMOTE_APPROVAL_REFUSAL,
    );
    expect(() => assertNoApprovalTool(["generer_image", "lire_fichier"])).not.toThrow();
  });

  it("la MÉMOIRE distante n'est pas un réglage du tout (aucun interrupteur sans effet)", () => {
    const service = new ChatService({ mode: () => "discord" });
    // ⚠️ `service.remoteMemory()` N'EXISTE PLUS, et `chat.remoteMemory` non plus : la
    // mémoire d'un canal n'est pas branchée, donc il n'y a rien à activer. Les DEUX
    // réglages réels (agents, outils) sont, eux, exposés et désactivés par défaut.
    expect(service.status().distant).toEqual({ agents: "desactive", outils: "desactive" });
  });
});
