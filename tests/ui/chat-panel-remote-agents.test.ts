/**
 * RÉGLAGE « Agents distants » — le chemin que cite le message de refus existe
 * VRAIMENT dans l'interface.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER FERME (2026-11-02) : le refus d'un outil long disait
 * « la délégation est désactivée » sans dire OÙ l'activer. Or `chat.remoteAgents`
 * n'avait AUCUN contrôle dans l'interface : le renvoyer vers un libellé inexistant
 * aurait été une seconde erreur. Le panneau « Discussions » porte donc le contrôle
 * « Agents distants », et ce test verrouille l'ÉGALITÉ entre le libellé de l'UI et
 * le chemin nommé par `REMOTE_AGENTS_SETTING_PATH` (`src/llm/tool-policy.ts`).
 *
 * ⚠️ CSP INCHANGÉE : le contrôle est construit avec `document.createElement`
 * (`h()`), jamais par `innerHTML`, et il n'ajoute aucun style inline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REMOTE_AGENTS_LABEL, REMOTE_AGENTS_HELP, initChatPanel } from "../../public/ui/chat-panel.js";
import { REMOTE_AGENTS_SETTING_PATH } from "../../src/llm/tool-policy.js";

const ROOT = process.cwd();

function lire(chemin: string): string {
  return readFileSync(join(ROOT, chemin), "utf8");
}

describe("panneau Discussions — réglage « Agents distants »", () => {
  it("le chemin du message de refus nomme le libellé EXACT du panneau", () => {
    expect(REMOTE_AGENTS_SETTING_PATH).toBe(`Configuration → Discussions → ${REMOTE_AGENTS_LABEL}`);
    expect(REMOTE_AGENTS_SETTING_PATH).toContain("Configuration → Discussions");
    expect(REMOTE_AGENTS_LABEL).toBe("Agents distants");
  });

  it("le panneau rend le contrôle et écrit la CLÉ de configuration attendue", () => {
    const source = lire("public/ui/chat-panel.js");
    expect(source).toContain('id: "chat-remote-agents"');
    expect(source).toContain('"chat.remoteAgents": select.value');
    expect(source).toContain("x-yuki-config");
    // ⚠️ La valeur effective vient du SERVEUR, jamais d'une supposition locale.
    expect(source).toContain("shared.state?.distant?.agents");
  });

  it("l'aide dit ce que le réglage change (images inline vs délégation)", () => {
    expect(REMOTE_AGENTS_HELP).toContain("GÉNÉRATION D'IMAGE");
    expect(REMOTE_AGENTS_HELP).toContain("DÉLÉGUER");
    expect(REMOTE_AGENTS_HELP).toContain("GLOBAL");
  });

  it("aucun `innerHTML` dans le panneau (CSP stricte)", () => {
    const source = lire("public/ui/chat-panel.js");
    // La règle est une INTERDICTION en tête de fichier : on cherche une AFFECTATION
    // réelle (`.innerHTML =`), jamais la mention de la règle elle-même.
    expect(source).not.toMatch(/\.innerHTML\s*=/u);
    expect(source).not.toMatch(/outerHTML\s*=/u);
    expect(source).not.toMatch(/insertAdjacentHTML/u);
  });

  it("le panneau expose une fabrique montable (aucune E/S au chargement)", () => {
    expect(typeof initChatPanel).toBe("function");
  });
});
